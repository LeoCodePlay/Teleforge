// 自动化任务页面(主区固定标签「自动化任务」)。
//
// 对齐 dsh `packages/client/ui-schedule` 的语义(而不是自创一套):
//   * 数据面 = 服务端的 **catalog**(含已结束)+ **history**(投递回执分页),两者与 dsh 的同名远程方法一一对应;
//   * 列表:状态筛选(全部 / 已开启 / 已结束)+ 搜索(名称/内容/会话)+ 按 `scheduledAt` 升序;
//     只有 active 行显示「下次计划时间」,inactive 行显示「已结束」;
//   * **没有"暂停"**、没有"立即执行":dsh 的任务只有 active/inactive(投递后自然结束或被归档停表);
//   * **没有前端创建表单**:dsh 的「+ 新建」是"开一个新会话,让模型用 schedule_create 建"
//     (见 TaskManagerPage.tsx 的按钮语义),本项目同样把新建交给模型 —— 这里只提供入口提示;
//   * 规则编辑 = dsh 的「Run time 卡」:改重复方式 / 时间 / 时区 / 星期 / cron,保存走 **compare-and-set**
//     (`expected` 必须是打开时的完整记录,不符返回 schedule_conflict);
//   * 「下次运行」显示的是**存储里已提交的 scheduledAt**(不是重算);编辑中的预览问服务端的
//     `schedule_preview`(与调度同一份 domain.ts,避免两套时间逻辑)。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { useFeedback } from '../../context/feedback';
import {
  absoluteTime, browserTimeZone, clockLabel, errorText, frequencyText, isOverdue, localDateValue, localTimeValue,
  nextRunText, recordOf, relativeTime, timeZoneOptions,
  type ScheduleCatalogEntry, type ScheduleHistoryResult, type SchedulePreview, type ScheduleRecord, type ScheduleRule,
  type TimingChange,
} from './types';
import './SchedulePanel.scss';

interface Props {
  /** 当前会话 id(新建/查看默认落在它上面) */
  sid?: string | null;
  /** 本页当前是否可见(不可见不轮询) */
  active?: boolean;
  /** 会话展示名(标题 · 作用域),App 已有会话列表 */
  sessionLabel?: (sid: string) => string;
  /** 「打开关联会话」 */
  onOpenSession?: (sid: string) => void;
  /** 汇总给标签页小红点:overdue = 已过提交点还没投递出去(多半在等服务器/模型就绪) */
  onSummary?: (s: { total: number; enabled: number; overdue: number }) => void;
  /** 「+ 新建」的落点:dsh 是"开一个新会话让模型建",由 App 负责切到对话页 */
  onNewTask?: () => void;
}

type Filter = 'all' | 'active' | 'inactive';
type EditorKind = 'at' | 'every' | 'daily' | 'weekly' | 'cron';

const FILTERS: { v: Filter; label: string }[] = [
  { v: 'all', label: '全部' },
  { v: 'active', label: '已开启' },
  { v: 'inactive', label: '已结束' },
];

const EDITOR_KINDS: { v: EditorKind; label: string }[] = [
  { v: 'at', label: '仅一次' },
  { v: 'every', label: '固定间隔' },
  { v: 'daily', label: '每天' },
  { v: 'weekly', label: '每周' },
  { v: 'cron', label: 'Cron 表达式' },
];

/** 编辑草稿(前端本地的墙钟写法;提交前收敛成 dsh 的选择器形状) */
interface Draft {
  kind: EditorKind;
  /** at:本地日期 + 时间 */
  date: string;
  atTime: string;
  /** daily / weekly:本地时间 */
  time: string;
  timeZone: string;
  weekdays: number[];
  /** every:秒 */
  seconds: number;
  expression: string;
}

function draftFrom(record: ScheduleRecord): Draft {
  const base = {
    kind: 'daily' as EditorKind, date: localDateValue(Date.parse(record.scheduledAt)),
    atTime: localTimeValue(Date.parse(record.scheduledAt)), time: '09:00:00', timeZone: browserTimeZone(),
    weekdays: [1, 2, 3, 4, 5], seconds: 3600, expression: '0 9 * * *',
  };
  if (record.kind === 'daily') return { ...base, kind: 'daily', time: record.time, timeZone: record.timeZone };
  if (record.kind === 'weekly') return { ...base, kind: 'weekly', time: record.time, timeZone: record.timeZone, weekdays: [...record.weekdays] };
  if (record.kind === 'cron') return { ...base, kind: 'cron', expression: record.expression, timeZone: record.timeZone };
  if (record.kind === 'every') return { ...base, kind: 'every', seconds: record.everySeconds };
  if (record.kind === 'at') return { ...base, kind: 'at' };
  // after:相对延时不能在原地改(dsh:换延时请新建),落到"仅一次"的绝对时间上
  return { ...base, kind: 'at' };
}

/** 草稿 → dsh 的选择器(创建与预览共用同一形状) */
function ruleOf(draft: Draft): ScheduleRule {
  switch (draft.kind) {
    case 'at': return { at: { date: draft.date, time: draft.atTime, time_zone: draft.timeZone } };
    case 'every': return { every_seconds: Math.round(draft.seconds) };
    case 'daily': return { daily: { time: draft.time, time_zone: draft.timeZone } };
    case 'weekly': return { weekly: { time: draft.time, time_zone: draft.timeZone, weekdays: draft.weekdays } };
    default: return { cron: { expression: draft.expression, time_zone: draft.timeZone } };
  }
}

/** 草稿 → 改时间用的 change(与 ruleOf 同形,但带 kind 判别) */
function changeOf(draft: Draft): TimingChange {
  const rule = ruleOf(draft);
  if (rule.at !== undefined) return { kind: 'at', at: rule.at };
  if (rule.every_seconds !== undefined) return { kind: 'every', every_seconds: rule.every_seconds };
  if (rule.daily !== undefined) return { kind: 'daily', daily: rule.daily };
  if (rule.weekly !== undefined) return { kind: 'weekly', weekly: rule.weekly };
  return { kind: 'cron', cron: rule.cron! };
}

export default function SchedulePanel({ sid, active = true, sessionLabel, onOpenSession, onSummary, onNewTask }: Props) {
  const { confirm, toast } = useFeedback();
  const [entries, setEntries] = useState<ScheduleCatalogEntry[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [tab, setTab] = useState<'rule' | 'records'>('rule');
  const [history, setHistory] = useState<ScheduleHistoryResult | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [failure, setFailure] = useState('');
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [tzOptions] = useState(timeZoneOptions);
  const summaryRef = useRef(onSummary);
  summaryRef.current = onSummary;

  const selected = useMemo(() => entries?.find((e) => e.id === selId) ?? null, [entries, selId]);
  const systemZone = useMemo(browserTimeZone, []);

  const load = useCallback(async (): Promise<ScheduleCatalogEntry[]> => {
    try {
      const r = await api.request('schedule_catalog', {}, 20000, 'schedule_catalog');
      const list: ScheduleCatalogEntry[] = Array.isArray(r?.entries) ? r.entries : [];
      setEntries(list);
      setLoadError('');
      setSelId((prev) => (prev && list.some((e) => e.id === prev) ? prev : (list[0]?.id ?? null)));
      summaryRef.current?.({
        total: list.length,
        enabled: list.filter((e) => e.status === 'active').length,
        overdue: list.filter((e) => e.status === 'active' && isOverdue(e)).length,
      });
      return list;
    } catch (e) {
      setLoadError((e as Error)?.message || '无法加载提醒。');
      return [];
    }
  }, []);

  const loadHistory = useCallback(async (entry: ScheduleCatalogEntry, before?: string) => {
    try {
      const r = await api.request('schedule_history', {
        sessionId: entry.sessionId, id: entry.id, limit: 50, ...(before ? { before } : {}),
      }, 20000, 'schedule_history');
      const result: ScheduleHistoryResult | undefined = r?.result;
      if (!result) { setHistory(null); return; }
      if ('code' in result) { setHistory(result); setFailure(errorText(result.code, '投递记录不可用', result.code)); return; }
      setHistory((prev) => {
        if (!prev || 'code' in prev || before === undefined) return result;
        return { ...result, records: [...prev.records, ...result.records] };
      });
    } catch (e) {
      toast.error((e as Error)?.message || '无法加载投递记录');
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (active) void load(); }, [active, load]);
  useEffect(() => {
    const off = api.on('schedule', () => { void load(); });
    return () => { off(); };
  }, [load]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [active, load]);
  // 选中任务或切到"投递记录"页时拉历史
  useEffect(() => {
    if (selected && tab === 'records') void loadHistory(selected);
  }, [selected, tab, loadHistory]);
  // 选中任务变化 → 把编辑草稿重置为它当前的存储值(dsh:刷新期间是字段级合并,这里直接重取)
  useEffect(() => {
    if (!selected) { setDraft(null); return; }
    setDraft(draftFrom(selected));
    setTitle(selected.title);
    setPrompt(selected.prompt);
    setFailure('');
    setPreview(null);
    setPreviewError('');
  }, [selected?.id, selected?.scheduledAt, selected?.title, selected?.prompt]);

  // 编辑中的规则预览:改动后 250ms 问一次服务端(与调度同一份 domain.ts)
  useEffect(() => {
    if (!draft || !selected) return undefined;
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const r = await api.request('schedule_preview', { rule: ruleOf(draft), count: 5 }, 15000, 'schedule_preview');
        if (!alive) return;
        setPreview({ kind: r.kind, scheduledAt: r.scheduledAt, next: Array.isArray(r.next) ? r.next : [] });
        setPreviewError('');
      } catch (e) {
        if (!alive) return;
        setPreview(null);
        setPreviewError((e as Error)?.message || '规则不合法');
      }
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [draft, selected]);

  const dirty = !!selected && !!draft
    && (title !== selected.title || prompt !== selected.prompt || JSON.stringify(ruleOf(draft)) !== JSON.stringify(ruleOf(draftFrom(selected))));

  const cancel = () => {
    if (!selected) return;
    setDraft(draftFrom(selected));
    setTitle(selected.title);
    setPrompt(selected.prompt);
    setFailure('');
  };

  const save = async () => {
    if (!selected || !draft) return;
    if (!title.trim()) { setFailure(errorText('invalid_prompt', '任务名称不能为空')); return; }
    if (!prompt.trim()) { setFailure(errorText('invalid_prompt', '内容不能为空')); return; }
    if (previewError) { setFailure(previewError); return; }
    setSaving(true);
    setFailure('');
    try {
      const r = await api.request('schedule_update', {
        sessionId: selected.sessionId,
        id: selected.id,
        expected: recordOf(selected),
        ...(title === selected.title ? {} : { title: title.trim() }),
        ...(prompt === selected.prompt ? {} : { prompt }),
        ...(selected.kind === 'after' ? {} : { change: changeOf(draft) }),
      }, 30000, 'ok');
      const result = r?.result;
      if (result && result.updated === false) {
        setFailure(errorText(result.code, '保存失败'));
        return;
      }
      toast.success('已保存');
      await load();
    } catch (e) {
      const message = (e as Error)?.message || '';
      setFailure(/conflict/i.test(message) ? errorText('conflict', message) : errorText(undefined, '保存失败', message));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: ScheduleCatalogEntry) => {
    const ok = await confirm({
      title: '删除此任务?',
      message: '任务将停止触发,并连同其已保存的任务运行记录一并删除。原会话及其消息仍然保留;已排队的消息不会被撤回。',
      confirmLabel: '确认删除', danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.request('schedule_delete', { sessionId: entry.sessionId, id: entry.id }, 20000, 'ok');
      if (r?.result?.deleted === false) { toast.warning('无法删除任务'); return; }
      toast.success('任务已删除');
      await load();
    } catch {
      toast.warning('无法删除任务');
    }
  };

  const shown = useMemo(() => {
    const list = entries ?? [];
    const kw = q.trim().toLowerCase();
    return list
      .filter((e) => (filter === 'all' ? true : filter === 'active' ? e.status === 'active' : e.status === 'inactive'))
      .filter((e) => !kw || `${e.title} ${e.prompt} ${e.sessionId}`.toLowerCase().includes(kw))
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id));
  }, [entries, filter, q]);

  const label = (id: string) => (sessionLabel ? sessionLabel(id) : id);

  return (
    <div className="sch-root">
      <header className="sch-head">
        <h1 className="sch-title">自动化任务</h1>
        <span className="sch-sub">到点让 AI 自己接着干</span>
        <div className="sch-head-right">
          <input className="sch-search" type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="搜索自动化任务" aria-label="搜索任务" />
          {onNewTask
            ? <button type="button" className="primary sch-new" onClick={onNewTask}>+ 新建</button>
            : <span className="sch-note">新建:在 AI 编程助手里说「每天 9 点帮我…」</span>}
        </div>
      </header>

      <div className="sch-body">
        <aside className="sch-list">
          <div className="sch-filters" role="group" aria-label="任务状态">
            {FILTERS.map((f) => (
              <button key={f.v} type="button" className={`sch-chip${filter === f.v ? ' on' : ''}`}
                aria-pressed={filter === f.v} onClick={() => setFilter(f.v)}>{f.label}</button>
            ))}
          </div>

          {entries === null && <p className="sch-note">正在加载提醒…</p>}
          {loadError && (
            <p className="sch-note err">
              无法加载提醒。<button type="button" className="sch-link" onClick={() => void load()}>重试</button>
            </p>
          )}
          {entries !== null && shown.length === 0 && (
            <p className="sch-note">
              {filter === 'inactive' && !q.trim() ? '没有已结束的自动化任务'
                : entries.length === 0 ? '还没有自动化任务,在会话中创建的任务会显示在这里'
                  : '没有匹配的自动化任务'}
            </p>
          )}

          <ul className="sch-ul" aria-label="任务列表">
            {shown.map((e) => (
              <li key={e.id}>
                <button type="button" className={`sch-item${selId === e.id ? ' on' : ''}${e.status === 'inactive' ? ' done' : ''}`}
                  aria-expanded={selId === e.id} onClick={() => { setSelId(e.id); setTab('rule'); }}>
                  <span className={`sch-dot ${e.status === 'inactive' ? 'off' : isOverdue(e, now) ? 'err' : 'ok'}`} />
                  <span className="sch-item-main">
                    <span className="sch-item-top">
                      <span className="sch-item-title">{e.title}</span>
                      {e.status === 'inactive' && <span className="sch-tag">已结束</span>}
                    </span>
                    <span className="sch-item-meta">{frequencyText(e, systemZone)}</span>
                    {e.status === 'active' && (
                      <span className="sch-item-meta">
                        下次计划时间:<time dateTime={e.scheduledAt}>{nextRunText(e.scheduledAt, now)}</time>
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="sch-detail" aria-label="任务详情">
          {!selected && <p className="sch-note">左侧选一个任务看详情。</p>}

          {selected && (
            <>
              <div className="sch-detail-head">
                <div className="sch-detail-title">
                  <span className={`sch-dot ${selected.status === 'inactive' ? 'off' : 'ok'}`} />
                  <strong>{selected.title}</strong>
                </div>
                <div className="sch-detail-ops">
                  {onOpenSession && (
                    <button type="button" className="sch-link"
                      onClick={() => onOpenSession(selected.sessionId)}>关联会话:{label(selected.sessionId)} ›</button>
                  )}
                  <button type="button" className="danger" onClick={() => void remove(selected)}>删除任务</button>
                </div>
              </div>

              <div className="sch-tabs" role="tablist" aria-label="任务详情视图">
                <button type="button" role="tab" aria-selected={tab === 'rule'} className={`sch-chip${tab === 'rule' ? ' on' : ''}`}
                  onClick={() => setTab('rule')}>规则</button>
                <button type="button" role="tab" aria-selected={tab === 'records'} className={`sch-chip${tab === 'records' ? ' on' : ''}`}
                  onClick={() => setTab('records')}>任务运行记录</button>
              </div>

              {tab === 'rule' && draft && (
                <div className="sch-rule">
                  {selected.status === 'inactive' ? (
                    <>
                      <p className="sch-note">已结束</p>
                      <dl className="sch-kv">
                        <dt>频率</dt><dd>{frequencyText(selected, systemZone)}</dd>
                        <dt>任务内容</dt><dd><pre className="sch-prompt">{selected.prompt}</pre></dd>
                      </dl>
                    </>
                  ) : (
                    <div className="sch-form">
                      <label className="sch-field">
                        <span>任务名称</span>
                        <input value={title} maxLength={120} aria-label="自动化任务名称" onChange={(e) => setTitle(e.target.value)} />
                      </label>
                      <label className="sch-field">
                        <span>任务内容(到点后交给模型的原话)</span>
                        <textarea value={prompt} rows={4} aria-label="自动化任务内容" onChange={(e) => setPrompt(e.target.value)} />
                      </label>

                      <div className="sch-field">
                        <span>运行时间</span>
                        <div className="sch-kinds">
                          {EDITOR_KINDS.map((k) => (
                            <button key={k.v} type="button" className={`sch-chip${draft.kind === k.v ? ' on' : ''}`}
                              onClick={() => setDraft({ ...draft, kind: k.v })}>{k.label}</button>
                          ))}
                          {selected.kind === 'after' && <span className="sch-note">(相对延时不能在原地改:换个延时请新建一个)</span>}
                        </div>
                      </div>

                      {draft.kind === 'at' && (
                        <div className="sch-field">
                          <div className="sch-inline">
                            <input type="date" value={draft.date} aria-label="日期" onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
                            <input type="time" step={1} value={draft.atTime} aria-label="时间" onChange={(e) => setDraft({ ...draft, atTime: e.target.value })} />
                            <TimeZonePicker value={draft.timeZone} options={tzOptions} onChange={(v) => setDraft({ ...draft, timeZone: v })} />
                          </div>
                        </div>
                      )}

                      {draft.kind === 'every' && (
                        <div className="sch-field">
                          <div className="sch-inline">
                            <input type="number" min={60} value={draft.seconds} aria-label="间隔秒数"
                              onChange={(e) => setDraft({ ...draft, seconds: Math.max(1, Number(e.target.value) || 1) })} />
                            <span className="sch-unit">秒</span>
                            <button type="button" className="sch-mini" onClick={() => setDraft({ ...draft, seconds: 60 })}>1 分钟</button>
                            <button type="button" className="sch-mini" onClick={() => setDraft({ ...draft, seconds: 3600 })}>1 小时</button>
                            <button type="button" className="sch-mini" onClick={() => setDraft({ ...draft, seconds: 86_400 })}>1 天</button>
                          </div>
                        </div>
                      )}

                      {(draft.kind === 'daily' || draft.kind === 'weekly') && (
                        <>
                          {draft.kind === 'weekly' && (
                            <div className="sch-field">
                              <span>星期</span>
                              <div className="sch-inline" role="group">
                                {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                                  <button key={d} type="button" aria-label={`星期${['', '一', '二', '三', '四', '五', '六', '日'][d]}`}
                                    className={`sch-chip${draft.weekdays.includes(d) ? ' on' : ''}`}
                                    onClick={() => setDraft({
                                      ...draft,
                                      weekdays: draft.weekdays.includes(d)
                                        ? (draft.weekdays.length === 1 ? draft.weekdays : draft.weekdays.filter((x) => x !== d))
                                        : [...draft.weekdays, d].sort((a, b) => a - b),
                                    })}>
                                    {['', '一', '二', '三', '四', '五', '六', '日'][d]}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                          <div className="sch-field">
                            <span>时间</span>
                            <div className="sch-inline">
                              <input type="time" step={1} value={draft.time} aria-label="时间"
                                onChange={(e) => setDraft({ ...draft, time: `${e.target.value.length === 5 ? `${e.target.value}:00` : e.target.value}` })} />
                              <TimeZonePicker value={draft.timeZone} options={tzOptions} onChange={(v) => setDraft({ ...draft, timeZone: v })} />
                            </div>
                          </div>
                        </>
                      )}

                      {draft.kind === 'cron' && (
                        <>
                          <div className="sch-field">
                            <span>Cron(五字段:分 时 日 月 周)</span>
                            <input className="mono" value={draft.expression} aria-label="Cron 表达式"
                              onChange={(e) => setDraft({ ...draft, expression: e.target.value })} />
                          </div>
                          <div className="sch-field">
                            <span>时区</span>
                            <TimeZonePicker value={draft.timeZone} options={tzOptions} onChange={(v) => setDraft({ ...draft, timeZone: v })} />
                          </div>
                        </>
                      )}

                      <div className="sch-preview">
                        <div>下次运行:{nextRunText(selected.scheduledAt, now)}</div>
                        {previewError
                          ? <span className="err" role="alert">{previewError}</span>
                          : preview && (
                            <>
                              <div className="sch-note">按当前编辑后:{nextRunText(preview.scheduledAt, now)}</div>
                              {preview.next.length > 1 && (
                                <details>
                                  <summary>接下来 {preview.next.length} 次</summary>
                                  <ul className="sch-next">{preview.next.map((t) => <li key={t}>{absoluteTime(t)}({relativeTime(t, now)})</li>)}</ul>
                                </details>
                              )}
                            </>
                          )}
                      </div>

                      {failure && <p className="err" role="alert">{failure}</p>}

                      {dirty && (
                        <div className="sch-form-foot sch-inline">
                          <span className="sch-note">有未保存的修改</span>
                          <button type="button" onClick={cancel}>取消</button>
                          <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
                            {saving ? '保存中…' : '保存修改'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {tab === 'records' && (
                <div className="sch-records">
                  {history === null && <p className="sch-note">正在加载…</p>}
                  {history !== null && 'code' in history && <p className="sch-note err">投递记录不可用</p>}
                  {history !== null && !('code' in history) && (
                    <>
                      {history.earlierRecordsUnavailable && <p className="sch-note">更早的投递记录已不可得。</p>}
                      {history.earlierRecordsPruned && <p className="sch-note">更早的记录因保留策略({history.retention.days} 天 / {history.retention.records} 条)已清理。</p>}
                      {history.records.length === 0
                        ? <p className="sch-note">还没有投递记录。</p>
                        : (
                          <table className="sch-table">
                            <thead><tr><th>投递时间</th><th>计划时刻</th><th>提醒内容</th></tr></thead>
                            <tbody>
                              {history.records.map((r) => (
                                <tr key={r.messageId}>
                                  <td className="mono">{absoluteTime(r.deliveredAt)}</td>
                                  <td className="mono">{absoluteTime(r.scheduledAt)}({relativeTime(r.scheduledAt, now)})</td>
                                  <td>{r.prompt || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      {history.nextBefore && (
                        <button type="button" className="sch-mini" onClick={() => void loadHistory(selected, history.nextBefore)}>加载更早</button>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/** 时区选择:常用项置顶(与 dsh 的时区下拉同取向) */
function TimeZonePicker({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <select className="sch-tz" value={value} onChange={(e) => onChange(e.target.value)} aria-label="时区">
      {options.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
    </select>
  );
}
