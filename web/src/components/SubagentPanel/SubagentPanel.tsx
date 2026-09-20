// 子代理面板:对话区右上角悬浮胶囊 + 右侧抽屉(派发记录列表 + 某次派发的完整对话)。
//
// 为什么需要它:子代理的过程**刻意不回传父会话**(父会话只多一条 tool/result),
// 但"它到底查了什么、为什么给这个结论"必须可追溯。于是每次派发落一份运行记录
// (server/store/subagent-store.ts),这里只读回看。
//
// 数据来源:
//   列表/详情 = RPC(subagent_list / subagent_get)
//   实时变更  = agent 事件流里的 event='subagent_changed'(带 runId + status,不含正文)
// 只读语义:没有任何写入口(不改、不删、不续聊);子代理记录是"已发生事实"的快照。
//
// 布局:桌面/平板 = 左列表 + 右对话(两栏);手机 = 单栏,选中后进入对话并可返回。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { useIsPhone } from '../../hooks/useMediaQuery';
import { StateDot } from '../StateDot/StateDot';
import { IconArrowLeft16, IconReload16, IconSparkle16, IconThinkOutline14 } from '../icons/icons';
import type { SubagentMessage, SubagentRun, SubagentRunInfo } from '../../types';
import './SubagentPanel.scss';

const POLL_MS = 1500; // 运行中记录的兜底刷新(事件为主,轮询只防丢事件)

/** 状态文案与状态点语义(点=真实状态,不是装饰) */
function statusOf(s: SubagentRunInfo['status']): { text: string; dot: 'ongoing' | 'done' | 'error' | 'warning' } {
  switch (s) {
    case 'running': return { text: '运行中', dot: 'ongoing' };
    case 'error': return { text: '出错', dot: 'error' };
    case 'stopped': return { text: '已停止', dot: 'warning' };
    default: return { text: '已完成', dot: 'done' };
  }
}

function fmtDur(ms: number | null): string {
  if (ms == null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 取参数里最有信息量的那一段做单行摘要 */
function argSummary(args?: string): string {
  if (!args) return '';
  try {
    const o = JSON.parse(args);
    if (o && typeof o === 'object') {
      for (const k of ['path', 'pattern', 'query', 'command', 'url', 'name']) {
        if (typeof o[k] === 'string' && o[k]) return `${k}=${o[k]}`;
      }
      const keys = Object.keys(o);
      if (keys.length) return keys.map((k) => `${k}=${JSON.stringify(o[k])?.slice(0, 40)}`).join(' ');
    }
  } catch { /* 非 JSON:原样给首行 */ }
  return String(args).replace(/\s+/g, ' ').slice(0, 120);
}

/** 把组装后的提示词按【标签】切成小节(父对话写的任务/边界因此一眼可分) */
function splitSections(text: string): Array<{ label: string | null; body: string }> {
  const src = String(text || '');
  const re = /^【([^】]+)】$/;
  const out: Array<{ label: string | null; body: string }> = [];
  let cur: { label: string | null; body: string[] } = { label: null, body: [] };
  for (const line of src.split('\n')) {
    const m = line.match(re);
    if (m) {
      if (cur.body.length || cur.label) out.push({ label: cur.label, body: cur.body.join('\n').trim() });
      cur = { label: m[1], body: [] };
    } else {
      cur.body.push(line);
    }
  }
  out.push({ label: cur.label, body: cur.body.join('\n').trim() });
  return out.filter((s) => s.label || s.body);
}

/** 可展开的长文本(工具输出/思考):默认折叠到 N 行,点标题栏展开 */
function FoldableText({ text, className, lines = 8 }: { text: string; className?: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const arr = text.split('\n');
  const long = arr.length > lines || text.length > 600;
  const shown = open || !long ? text : arr.slice(0, lines).join('\n');
  return (
    <div className={className}>
      <pre className="sa-pre">{shown}{!open && long ? '\n…' : ''}</pre>
      {long && (
        <button type="button" className="sa-fold" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? '收起' : `展开全部(${arr.length} 行)`}
        </button>
      )}
    </div>
  );
}

/** 一条对话消息(子代理内部视角) */
function MessageRow({ msg }: { msg: SubagentMessage }) {
  if (msg.role === 'user') {
    return (
      <div className="sa-msg sa-msg-user">
        <div className="sa-msg-head">
          <span className="sa-msg-who">派发提示词</span>
          <span className="sa-msg-step">由父对话生成</span>
        </div>
        <div className="sa-brief">
          {splitSections(msg.text || '').map((s, i) => (
            <div className="sa-brief-sec" key={i}>
              {s.label && <span className="sa-brief-label">{s.label}</span>}
              <span className="sa-brief-body">{s.body}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (msg.role === 'assistant') {
    const text = String(msg.text || '').trim();
    return (
      <div className="sa-msg sa-msg-assistant">
        <div className="sa-msg-head">
          <span className="sa-msg-who">子代理 · 第 {msg.step} 步</span>
          <span className="sa-msg-time">{fmtClock(msg.at)}</span>
        </div>
        {msg.reasoning ? (
          <div className="sa-think">
            <span className="sa-think-label"><IconThinkOutline14 size={12} />思考</span>
            <FoldableText text={String(msg.reasoning)} className="sa-think-body" lines={4} />
          </div>
        ) : null}
        {text
          ? <div className="sa-text">{text}</div>
          : <div className="sa-text sa-text-empty">(这一步没有文字,直接发起了工具调用)</div>}
      </div>
    );
  }
  const err = msg.isError === true;
  return (
    <div className={`sa-msg sa-msg-tool${err ? ' is-error' : ''}`}>
      <div className="sa-msg-head">
        <span className="sa-tool-name">{msg.name || '工具'}</span>
        <span className="sa-tool-args" title={msg.args}>{argSummary(msg.args)}</span>
        {msg.ms != null && <span className="sa-msg-time">{fmtDur(msg.ms)}</span>}
      </div>
      {err && <div className="sa-tool-badge">被拒绝 / 失败</div>}
      <FoldableText text={String(msg.content || '(空结果)')} className="sa-tool-out" lines={6} />
    </div>
  );
}

export default function SubagentPanel({ active, sid, open, runId, onOpen, onClose, embedded = false, onCounts }: {
  /** 当前是否在对话标签页(切走时自动收起) */
  active: boolean;
  /** 当前会话 id(只列这个会话派发的子代理) */
  sid: string | null;
  open: boolean;
  /** 打开时希望定位到的运行记录 id(卡片上的「查看会话」带过来) */
  runId: string | null;
  onOpen: (runId?: string) => void;
  onClose: () => void;
  /** 由外层 ActivityDock 托管:不渲染自己的悬浮胶囊/抽屉/头部,只渲染内容 */
  embedded?: boolean;
  /** 向上汇报派发数量与运行中数量(宿主据此决定整块面板是否显示、标签角标) */
  onCounts?: (c: { count: number; running: number }) => void;
}) {
  const isPhone = useIsPhone();
  const [runs, setRuns] = useState<SubagentRunInfo[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(runId);
  const [run, setRun] = useState<SubagentRun | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [showDetailOnPhone, setShowDetailOnPhone] = useState(false);
  const mountedRef = useRef(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const runningCount = useMemo(() => runs.filter((r) => r.status === 'running').length, [runs]);
  // 草稿会话(还没有 sid)名下不可能有派发记录:一条都不报,宿主也就不会显示子代理分区
  useEffect(() => {
    onCounts?.({ count: sid ? runs.length : 0, running: sid ? runningCount : 0 });
  }, [sid, runs.length, runningCount, onCounts]);
  const selectedInfo = useMemo(() => runs.find((r) => r.runId === selected) || null, [runs, selected]);

  const fetchList = useCallback(async () => {
    // 草稿会话没有 sid:不请求,列表直接清空(绝不把别的会话的记录当成自己的)
    if (!sid) { setRuns([]); setListErr(null); return; }
    try {
      const r = await api.request('subagent_list', { sid }, 10000, 'subagent_list');
      if (!mountedRef.current) return;
      setRuns(Array.isArray(r?.runs) ? r.runs : []);
      setListErr(null);
    } catch (e: any) {
      if (!mountedRef.current) return;
      // 服务端未起/断线:如实显示,不假装"没有记录"
      setListErr(e?.message || '派发记录拉取失败');
    }
  }, [sid]);

  const fetchRun = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const r = await api.request('subagent_get', { runId: id }, 10000, 'subagent_run');
      if (!mountedRef.current) return;
      setRun(r?.run ?? null);
      setDetailErr(null);
    } catch (e: any) {
      if (!mountedRef.current) return;
      setRun(null);
      setDetailErr(e?.message || '这次派发的记录拉取失败');
    } finally {
      if (mountedRef.current) setDetailLoading(false);
    }
  }, []);

  // 会话切换 / 挂载 / 断线重连:重拉列表
  useEffect(() => {
    mountedRef.current = true;
    void fetchList();
    const offOpen = api.on('open', () => { void fetchList(); });
    return () => { mountedRef.current = false; offOpen(); };
  }, [fetchList]);

  // 实时变更:事件只带 runId/status,正文由这里按需重拉
  useEffect(() => {
    const off = api.on('agent', (m: any) => {
      if (m?.event !== 'subagent_changed') return;
      if (sid && m.sid && m.sid !== sid) return;
      void fetchList();
      const id = String(m.runId || '');
      if (id && id === selected) void fetchRun(id);
    });
    return () => { off(); };
  }, [fetchList, fetchRun, selected, sid]);

  // 运行中兜底轮询(事件丢一帧也不至于停在旧状态)
  useEffect(() => {
    if (!open || runningCount === 0) return;
    const t = setInterval(() => {
      void fetchList();
      if (selected) void fetchRun(selected);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [open, runningCount, fetchList, fetchRun, selected]);

  // 外部带 runId 打开(卡片上的「查看会话」)
  useEffect(() => {
    if (!open || !runId) return;
    setSelected(runId);
    setShowDetailOnPhone(true);
    void fetchRun(runId);
  }, [open, runId, fetchRun]);

  // 打开但没指定:默认选最新一条(优先运行中的)
  useEffect(() => {
    if (!open || runId || selected || runs.length === 0) return;
    const next = runs.find((r) => r.status === 'running') || runs[0];
    setSelected(next.runId);
    void fetchRun(next.runId);
  }, [open, runId, selected, runs, fetchRun]);

  // 切走标签页 / 关闭时,手机端回到列表
  useEffect(() => { if (!open) setShowDetailOnPhone(false); }, [open]);
  useEffect(() => { if (!active) onClose(); }, [active, onClose]);

  // Esc 收起
  useEffect(() => {
    if (embedded || !open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [embedded, open, onClose]);

  // 运行中:新消息到达后贴底(用户主动上翻时不打扰)
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !open) return;
    if (selectedInfo?.status !== 'running') return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (near) el.scrollTop = el.scrollHeight;
  }, [run?.messages.length, open, selectedInfo?.status]);

  const pick = (id: string) => {
    setSelected(id);
    setShowDetailOnPhone(true);
    void fetchRun(id);
  };

  // 没有任何派发记录:不占用右上角(胶囊只在有内容时出现)
  // ---- 渲染:派发记录列表 / 该次派发的对话(embedded 与独立使用共用同一份 JSX)----
  const renderList = () => (
    <nav className="sa-list" aria-label="子代理派发记录">
      {listErr && (
        <div className="sa-list-err">
          <span>{listErr}</span>
          <button type="button" className="sa-retry" onClick={() => void fetchList()}>
            <IconReload16 size={12} />重试
          </button>
        </div>
      )}
      {runs.map((r) => {
        const st = statusOf(r.status);
        return (
          <button
            type="button"
            key={r.runId}
            className={`sa-item${r.runId === selected ? ' on' : ''}`}
            aria-current={r.runId === selected}
            onClick={() => pick(r.runId)}
          >
            <span className="sa-item-top">
              <StateDot state={st.dot} />
              <span className="sa-item-desc">{r.description || '(未命名派发)'}</span>
            </span>
            <span className="sa-item-meta">
              <span className={`sa-item-status st-${r.status}`}>{st.text}</span>
              <span className="sa-item-stat">{r.steps} 步 · {r.toolCalls} 次调用</span>
              {r.ms != null && <span className="sa-item-stat">{fmtDur(r.ms)}</span>}
            </span>
            <span className="sa-item-time">{fmtClock(r.startedAt)}</span>
          </button>
        );
      })}
      {!runs.length && !listErr && <div className="sa-list-empty">本次会话还没有派发过子代理</div>}
    </nav>
  );

  const renderDetail = () => (
    <section className="sa-detail">
      {isPhone && showDetailOnPhone && (
        <button type="button" className="sa-back" onClick={() => setShowDetailOnPhone(false)}>
          <IconArrowLeft16 size={14} />返回列表
        </button>
      )}
      <div className="sa-detail-body" ref={bodyRef}>
        {detailLoading && !run && (
          <div className="sa-skel" aria-busy="true" aria-label="加载中">
            <span className="sa-skel-line" />
            <span className="sa-skel-line w70" />
            <span className="sa-skel-line w85" />
            <span className="sa-skel-line w60" />
          </div>
        )}
        {detailErr && (
          <div className="sa-detail-err">
            <span>{detailErr}</span>
            {selected && (
              <button type="button" className="sa-retry" onClick={() => void fetchRun(selected)}>
                <IconReload16 size={12} />重试
              </button>
            )}
          </div>
        )}
        {!detailLoading && !detailErr && !run && (
          <div className="sa-detail-empty">
            {selected
              ? '这次派发的记录已不在(可能超出了保留上限,或被清理过)'
              : '从左侧选一次派发,查看子代理的完整过程'}
          </div>
        )}
        {run && (
          <>
            {run.messages.map((msg, i) => <MessageRow key={`${msg.role}-${msg.step}-${i}`} msg={msg} />)}
            {run.status === 'running' && <div className="sa-running">子代理还在跑,新步骤会自动出现</div>}
          </>
        )}
      </div>
      {run && (
        <footer className="sa-foot">
          <span className={`sa-item-status st-${run.status}`}>{statusOf(run.status).text}</span>
          <span className="sa-foot-stat">{run.steps} 步 · {run.toolCalls} 次调用</span>
          {run.ms != null && <span className="sa-foot-stat">{fmtDur(run.ms)}</span>}
          {(run.promptTokens || run.completionTokens) > 0 && (
            <span className="sa-foot-stat">token {run.promptTokens}/{run.completionTokens}</span>
          )}
          <span className="sa-foot-gap" />
          <span className="sa-foot-provider">{run.provider}</span>
        </footer>
      )}
      {run?.note && <div className="sa-note">{run.note}</div>}
    </section>
  );

  // 由 ActivityDock 托管:只出内容(没有派发记录时什么都不渲染,宿主自然不显示这一栏)
  if (embedded) {
    if (!sid || runs.length === 0) return null;
    return (
      <div className={`sa-cols${showDetailOnPhone ? ' detail' : ''}`}>
        {renderList()}
        {renderDetail()}
      </div>
    );
  }

  // 独立使用:没有派发记录(或草稿会话)就不显示悬浮胶囊(整块不存在)
  if (!sid || runs.length === 0) return null;

  return (
    <>
      <button
        type="button"
        className={`sa-fab${runningCount > 0 ? ' live' : ''}${open ? ' on' : ''}`}
        data-tip="查看子代理的调研过程"
        aria-label="打开子代理面板"
        aria-expanded={open}
        onClick={() => (open ? onClose() : onOpen())}
      >
        <span className="sa-fab-ico"><IconSparkle16 size={14} /></span>
        <span className="sa-fab-text">子代理</span>
        <span className="sa-fab-count">{runningCount > 0 ? `${runningCount}/${runs.length}` : runs.length}</span>
      </button>

      {open && !isPhone && <div className="sa-backdrop" onClick={onClose} />}

      <aside
        className={`sa-drawer${open ? ' open' : ''}${isPhone ? ' phone' : ''}`}
        aria-label="子代理"
        aria-hidden={!open}
      >
        <header className="sa-head">
          <span className="sa-title"><IconSparkle16 size={14} />子代理</span>
          <span className="sa-sub">
            {runs.length} 次派发{runningCount > 0 ? ` · ${runningCount} 个运行中` : ''}
          </span>
          <span className="sa-head-gap" />
          <button type="button" className="chip-btn" onClick={onClose} aria-label="收起子代理面板">收起</button>
        </header>
        <div className={`sa-cols${showDetailOnPhone ? ' detail' : ''}`}>
          {renderList()}
          {renderDetail()}
        </div>
      </aside>
    </>
  );
}
