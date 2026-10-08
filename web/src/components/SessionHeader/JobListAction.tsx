// 后台任务(本项目里就是「AI 运行终端」)—— 逐行照搬 deepseek-harness 的 JobListAction:
// 会话头部一个「N 个后台任务运行中」的触发器 + 500px 弹层(进行中 / 已结束 N / 清空),
// 行内 StateDot + kind 徽标 + 标签 + 状态与耗时,运行中的行可展开看实时输出(TerminalBlock),
// 行尾一个**两次点击**才生效的停止按钮。样式用的是同一份 JobListAction.module.css 原件。
//
// 与 dsh 的差别只在**数据与动作名字**:
//   - dsh 的 job 由 ctx.jobs 服务提供(status: running/stopping/completed/killed/failed,
//     output.total / observe / kill);本项目由 server/core/ai-term.ts 的 aiTerms 注册表提供
//     (AiTermInfo + ai_term_* RPC + type='ai_term' 广播)。映射:
//       running→running, stopped/exited→completed, failed→failed, 停止中→stopping(本地态);
//       kind 徽标 = 远程/本机(本项目终端只有这两种归属);
//       kill = ai_term_delete(本项目「停止」与「删除记录」是同一个动作)。
//   - dsh 的已结束区由服务端 roster 保留;本项目的 ai_term_list 只返回运行中的,所以
//     「已结束」是**本次挂载期间**退出过的终端(客户端保留,与 dsh「重启后随进程丢失」一致)。
//
// 输出:ai_term_log 拉一次全量快照,之后由 type='ai_term' 的 output 事件增量追加;
// 展开期间才订阅/重渲染(不在展开的行不保留日志,也不因高频输出触发渲染)。

import React, {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  IconChevronDownOutlineRegular, IconStopFillRegular, StateDot, TerminalBlock,
  useDismissOnOutsidePointer,
  type StateDotState, type TerminalBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { api } from '../../api';
import type { AiTermInfo } from '../../types';
import { tJob, type JobKey } from './locales';
import css from './JobListAction.module.css';

/** 与 dsh 的菜单定位一致的视口边距。 */
const VIEWPORT_MARGIN = 12;
/** 二次点击确认的等待上限 / 失败提示的停留时长(dsh 原值)。 */
const KILL_ARM_MS = 3_000;
const KILL_FAILED_MS = 4_000;
/** 输出缓存上限:只读监看,超出丢最旧的(与 AiTermPanel 的 200k 同口径)。 */
const LOG_CAP = 200_000;

/** dsh 的 job 状态闭集。本项目没有 stopping/killed 的服务端态,但保留同一套展示口径。 */
type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed';
type KillState = 'idle' | 'armed' | 'pending' | 'failed';

function isLive(job: AiTermInfo): boolean {
  return job.state === 'running';
}

/** 本项目里 kind 徽标显示的是终端的归属:远程服务器 / 本机。 */
function kindOf(job: AiTermInfo): string {
  return job.target === 'local' ? '本机' : '远程';
}

function statusOf(job: AiTermInfo): JobStatus {
  if (job.state === 'running') return 'running';
  return job.state === 'failed' ? 'failed' : 'completed';
}

function dotState(status: JobStatus): StateDotState {
  switch (status) {
    case 'running': return 'ongoing';
    case 'stopping': return 'warning';
    case 'completed': return 'done';
    case 'killed': return 'warning';
    case 'failed': return 'error';
    default: return 'idle';
  }
}

/** Closed-union exhaustiveness fence for the status set. */
function assertNever(value: never): never {
  throw new Error(`unhandled job status: ${JSON.stringify(value)}`);
}

function statusLabel(status: JobStatus): string {
  switch (status) {
    case 'running': return tJob('status.running');
    case 'stopping': return tJob('status.stopping');
    case 'completed': return tJob('status.completed');
    case 'killed': return tJob('status.killed');
    case 'failed': return tJob('status.failed');
    default: return assertNever(status);
  }
}

/** 行上的一句话限定符:运行中给命令,结束后给退出事实。 */
function jobDetail(job: AiTermInfo): string | undefined {
  if (job.state === 'running') {
    const cmd = String(job.command || '').replace(/\s+/g, ' ').trim();
    return cmd === '' ? undefined : cmd.length > 60 ? `${cmd.slice(0, 59)}…` : cmd;
  }
  if (job.note) return job.note;
  if (job.exitCode == null) return job.state === 'failed' ? tJob('terminal.noExitCode') : undefined;
  return tJob('terminal.exitCode', { code: job.exitCode });
}

/**
 * Elapsed time in at most two adjacent units (dsh 原样:一小时内够用,超过就走小时)。
 */
function formatDuration(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1_000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3_600);
  if (hours > 0) return tJob('duration.hours', { hours, minutes });
  if (minutes > 0) return tJob('duration.minutes', { minutes, seconds });
  return tJob('duration.seconds', { seconds });
}

/** Localized display copy for the embedded terminal panel. */
function terminalLabels(): TerminalBlockLabels {
  return {
    signal: (signal) => tJob('terminal.signal', { signal }),
    exitCode: (code) => tJob('terminal.exitCode', { code }),
    noExitCode: tJob('terminal.noExitCode'),
    running: tJob('terminal.running'),
    failed: tJob('terminal.failed'),
    done: tJob('terminal.done'),
    copy: tJob('terminal.copy'),
    copied: tJob('terminal.copied'),
    noOutput: tJob('terminal.noOutput'),
    collapseAria: tJob('terminal.collapseAria'),
    collapse: tJob('terminal.collapse'),
    expandAria: (hidden) => tJob('terminal.expandAria', { n: hidden }),
    expand: (hidden) => tJob('terminal.expand', { n: hidden }),
  };
}

/**
 * Live rows first in start order, then settled rows newest-first(与 dsh 的 ordered 同序)。
 */
function ordered(jobs: readonly AiTermInfo[]): AiTermInfo[] {
  return [...jobs].sort((left, right) => {
    const liveLeft = isLive(left);
    if (liveLeft !== isLive(right)) return liveLeft ? -1 : 1;
    if (liveLeft) return left.startedAt - right.startedAt;
    const finished = (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt);
    return finished !== 0 ? finished : left.startedAt - right.startedAt;
  });
}

/** One job row plus, when expanded, its live output panel. */
function JobItem({ job, output, expanded, now, onToggle, kill }: {
  job: AiTermInfo;
  output: string;
  expanded: boolean;
  /** Clock sample live rows derive their running duration from. */
  now: number;
  onToggle: () => void;
  /** Present on running rows: the human-kill button state and press handler. */
  kill?: { state: KillState; onPress: () => void };
}) {
  const live = isLive(job);
  const status = statusLabel(statusOf(job));
  const detail = jobDetail(job);
  const labels = useMemo(() => terminalLabels(), []);
  const elapsed = live ? now - job.startedAt : (job.endedAt ?? job.startedAt) - job.startedAt;
  const duration = formatDuration(elapsed);
  const durationCell = (
    <span
      className={css.duration}
      data-tip={tJob(live ? 'duration.title.live' : 'duration.title.done', { duration })}
    >
      {duration}
    </span>
  );
  const body = live
    ? (
      <>
        <StateDot state={dotState('running')} className={css.rowDot} />
        <span className={css.main}>
          <span className={css.primary}>
            <span className={css.label} data-tip={job.label} data-tip-ellipsis>{job.label}</span>
          </span>
          <span className={css.secondary} data-tip={detail ?? status}>
            <span className={css.kind}>{kindOf(job)}</span>
            {detail !== undefined ? <span className={css.status}>{detail}</span> : null}
            {durationCell}
          </span>
        </span>
        <span className={css.chevronBox}>
          <IconChevronDownOutlineRegular size={12} className={expanded ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
        </span>
      </>
    )
    : (
      <>
        <StateDot state={dotState(statusOf(job))} className={css.rowDot} />
        <span className={css.kind}>{kindOf(job)}</span>
        <span className={css.label} data-tip={job.label} data-tip-ellipsis>{job.label}</span>
        <span className={css.status} data-tip={detail ?? status} data-tip-ellipsis>{detail ?? status}</span>
        {durationCell}
        <span className={css.chevronBox}>
          <IconChevronDownOutlineRegular size={12} className={expanded ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
        </span>
      </>
    );
  const killTitle = kill === undefined
    ? undefined
    : kill.state === 'armed'
      ? tJob('kill.confirm')
      : kill.state === 'failed' ? tJob('kill.failed') : tJob('kill.stop', { label: job.label });
  return (
    <li className={css.item}>
      <div className={live ? `${css.rowLine} ${css.rowLineLive}` : css.rowLine}>
        <button
          type="button"
          className={live ? css.row : `${css.row} ${css.rowSettled}`}
          aria-expanded={expanded}
          aria-label={tJob(expanded ? 'row.collapseAria' : 'row.expandAria', { label: job.label })}
          data-job-row={job.id}
          onClick={onToggle}
        >
          {body}
        </button>
        {kill !== undefined
          ? (
            <button
              type="button"
              className={
                kill.state === 'armed'
                  ? `${css.stop} ${css.stopArmed}`
                  : kill.state === 'failed' ? `${css.stop} ${css.stopFailed}` : css.stop
              }
              data-kill-state={kill.state}
              data-job-kill={job.id}
              disabled={kill.state === 'pending'}
              aria-label={killTitle}
              data-tip={killTitle}
              onClick={kill.onPress}
            >
              <IconStopFillRegular size={10} />
              {kill.state === 'armed' ? <span className={css.stopLabel}>{tJob('kill.confirmAction')}</span> : null}
            </button>
          )
          : null}
      </div>
      {expanded
        ? (
          <div className={css.panel}>
            <TerminalBlock
              command={job.command}
              cwd={job.cwd ?? undefined}
              output={output}
              running={live}
              copyText={job.command}
              // 行上已经带了状态点,面板里不再重复一个
              runStateDot={false}
              // 面板自己滚动,不折叠中间行
              maxLines={Number.POSITIVE_INFINITY}
              labels={labels}
            />
          </div>
        )
        : null}
    </li>
  );
}

/**
 * 会话头部动作区里的「后台任务」入口。挂载即开始订阅(与 AiTermPanel 同一份数据源):
 * 列表来自 ai_term_list + type='ai_term' 事件,输出按需拉取并增量追加。
 * @param props.sid - 只列这个会话拉起的终端(草稿会话 sid 为 null → 一条都不显示)。
 * @returns 触发器与它的弹层,没有任务时返回 null。
 */
export default function JobListAction({ sid }: { sid: string | null }) {
  const [terms, setTerms] = useState<AiTermInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  // 已结束区的折叠:用户显式切换优先;此前只在存在进行中任务时默认折叠
  const [settledOpen, setSettledOpen] = useState<boolean | undefined>(undefined);
  // 用户「清空」掉的已结束行(仅客户端隐藏)
  const [clearedKeys, setClearedKeys] = useState<ReadonlySet<string>>(() => new Set());
  // 同一时刻只有一个停止按钮在推进:武装一个会解除另一个
  const [killPhase, setKillPhase] = useState<{ key: string; state: Exclude<KillState, 'idle'> } | undefined>(undefined);
  // 输出文本按需保留:只有展开过的行才有日志(未展开的行不缓存,省内存也不抖动)
  const [outputTick, setOutputTick] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const [menuShift, setMenuShift] = useState(0);

  const logs = useRef<Map<string, string>>(new Map());
  const hydrated = useRef<Set<string>>(new Set());
  const inflight = useRef<Set<string>>(new Set());
  const openRef = useRef(open);
  const expandedRef = useRef(expandedKey);
  const sidRef = useRef(sid);
  const mountedRef = useRef(true);
  openRef.current = open;
  expandedRef.current = expandedKey;
  sidRef.current = sid;

  const rows = useMemo(() => ordered(terms), [terms]);
  const liveRows = useMemo(() => rows.filter(isLive), [rows]);
  const settledRows = useMemo(
    () => rows.filter((job) => !isLive(job) && !clearedKeys.has(job.id)),
    [rows, clearedKeys],
  );
  const settledExpanded = settledOpen ?? liveRows.length === 0;
  const visibleCount = liveRows.length + settledRows.length;

  useDismissOnOutsidePointer(rootRef, open, setOpen);

  const appendLog = useCallback((id: string, data: string) => {
    // 只有已拉过快照的行才累积实时块:未展开的行不保留日志(展开那一刻用 ai_term_log 补全,
    // 避免为没人看的高频输出常驻内存);拉取期间的实时块丢弃,宁缺勿重。
    if (!hydrated.current.has(id)) return;
    const next = (logs.current.get(id) || '') + data;
    logs.current.set(id, next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next);
  }, []);

  // 展开时才拉一次全量快照;拉取期间到达的实时块丢弃(它们大多已包含在快照前缀里,宁缺勿重)
  const hydrate = useCallback(async (id: string) => {
    if (hydrated.current.has(id) || inflight.current.has(id)) return;
    inflight.current.add(id);
    try {
      const lr = await api.request('ai_term_log', { id }, 10000, 'ai_term_log');
      if (!mountedRef.current) return;
      logs.current.set(id, String(lr?.log ?? ''));
    } catch {
      logs.current.set(id, logs.current.get(id) || '');
    } finally {
      inflight.current.delete(id);
      hydrated.current.add(id);
      if (mountedRef.current) setOutputTick((t) => t + 1);
    }
  }, []);

  // 列表:挂载 / 切会话 / 断线重连都重拉;只保留本会话的终端
  const fetchList = useCallback(async () => {
    const want = sidRef.current;
    try {
      const r = await api.request('ai_term_list', {}, 10000, 'ai_term_list');
      if (!mountedRef.current) return;
      const list: AiTermInfo[] = Array.isArray(r?.terms) ? r.terms : [];
      const mine = want ? list.filter((t) => t.sid === want) : [];
      setTerms((prev) => {
        // 服务端只给运行中的:把本次挂载期间已结束的行补回来(客户端保留)
        const byId = new Map(prev.map((t) => [t.id, t]));
        const merged = mine.map((t) => byId.get(t.id) ?? t);
        const gone = new Set(merged.map((t) => t.id));
        for (const t of prev) if (!isLive(t) && !gone.has(t.id) && t.sid === want) merged.push(t);
        return merged;
      });
    } catch {
      /* 列表拉取失败(服务端未起/断线):重连后自动重试,不打断界面 */
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void fetchList();
    const offTerm = api.on('ai_term', (m: any) => {
      const id = String(m?.id || m?.term?.id || '');
      if (!id) return;
      const want = sidRef.current;
      if (m.event === 'start' && m.term) {
        const term = m.term as AiTermInfo;
        if (want && term.sid !== want) return;
        setTerms((prev) => (prev.some((t) => t.id === term.id) ? prev : [...prev, term]));
        return;
      }
      if (m.event === 'output') {
        appendLog(id, String(m.data ?? ''));
        if (openRef.current && expandedRef.current === id) setOutputTick((t) => t + 1);
        return;
      }
      if (m.event === 'exit') {
        const term = m.term as AiTermInfo | undefined;
        setTerms((prev) => prev.map((t) => (t.id === id && term ? term : t)));
        return;
      }
      if (m.event === 'removed') {
        setTerms((prev) => prev.filter((t) => t.id !== id));
        logs.current.delete(id);
        hydrated.current.delete(id);
      }
    });
    const offOpen = api.on('open', () => {
      logs.current.clear();
      hydrated.current.clear();
      void fetchList();
    });
    return () => { mountedRef.current = false; offTerm(); offOpen(); };
  }, [appendLog, fetchList]);

  // 切换会话:先把上一个会话的列表与日志清干净,再重拉
  const firstSid = useRef(sid);
  useEffect(() => {
    if (firstSid.current === sid) return;
    firstSid.current = sid;
    logs.current.clear();
    hydrated.current.clear();
    setTerms([]);
    setExpandedKey(undefined);
    setOpen(false);
    void fetchList();
  }, [sid, fetchList]);

  // 时钟只在「打开且确有进行中任务」时走
  useEffect(() => {
    if (!open || liveRows.length === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => { setNow(Date.now()); }, 1_000);
    return () => { clearInterval(timer); };
  }, [open, liveRows.length]);

  // 弹层贴住视口:锚点靠右时向左平移,但不越过左边距
  useLayoutEffect(() => {
    if (!open) { setMenuShift(0); return; }
    const fit = (): void => {
      const root = rootRef.current;
      const menu = menuRef.current;
      if (root === null || menu === null) return;
      const width = menu.offsetWidth;
      if (width === 0) return;
      const anchorLeft = root.getBoundingClientRect().left;
      setMenuShift(Math.max(
        VIEWPORT_MARGIN - anchorLeft,
        Math.min(0, window.innerWidth - VIEWPORT_MARGIN - width - anchorLeft),
      ));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => { window.removeEventListener('resize', fit); };
  }, [open]);

  // 展开行:首次展开才去拉日志
  useEffect(() => {
    if (!open || expandedKey === undefined) return;
    void hydrate(expandedKey);
  }, [open, expandedKey, hydrate]);

  // 最后一个可见任务消失时先收起,别让焦点留在正在卸载的节点上
  useEffect(() => {
    if (visibleCount === 0 && open) setOpen(false);
  }, [visibleCount, open]);

  // 展开的行离开了列表(被删/被清):折叠它的面板
  useEffect(() => {
    if (expandedKey !== undefined && !rows.some((job) => job.id === expandedKey)) {
      setExpandedKey(undefined);
    }
  }, [rows, expandedKey]);

  // 武装态的停止按钮超时自动解除;失败提示短暂停留后复位
  useEffect(() => {
    if (killPhase === undefined || killPhase.state === 'pending') return;
    const timer = setTimeout(
      () => { setKillPhase(undefined); },
      killPhase.state === 'armed' ? KILL_ARM_MS : KILL_FAILED_MS,
    );
    return () => { clearTimeout(timer); };
  }, [killPhase]);

  // 已经不可停止的行(已结束/被删)不再保留按钮状态
  useEffect(() => {
    if (killPhase !== undefined
      && !rows.some((job) => job.id === killPhase.key && isLive(job))) {
      setKillPhase(undefined);
    }
  }, [rows, killPhase]);

  const pressKill = (job: AiTermInfo): void => {
    const key = job.id;
    if (killPhase?.key !== key || killPhase.state !== 'armed') {
      setKillPhase({ key, state: 'armed' });
      return;
    }
    setKillPhase({ key, state: 'pending' });
    void api.request('ai_term_delete', { id: key }, 15000, 'ai_term_deleted').then(
      () => {
        // 成功:进程结束 + 记录移除;本地立刻摘掉这一行(removed 事件也会到)
        setTerms((prev) => prev.filter((t) => t.id !== key));
        logs.current.delete(key);
        hydrated.current.delete(key);
        setKillPhase((current) => (current?.key === key ? undefined : current));
      },
      () => {
        setKillPhase((current) => (current?.key === key ? { key, state: 'failed' } : current));
      },
    );
  };

  if (visibleCount === 0) return null;

  const countKey: JobKey = liveRows.length > 0
    ? (liveRows.length === 1 ? 'count.live.one' : 'count.live.other')
    : (visibleCount === 1 ? 'count.idle.one' : 'count.idle.other');
  const countLabel = tJob(countKey, { count: liveRows.length > 0 ? liveRows.length : visibleCount });

  const clearSettled = (): void => {
    setClearedKeys((current) => {
      const next = new Set(current);
      for (const job of settledRows) next.add(job.id);
      return next;
    });
    if (expandedKey !== undefined && settledRows.some((job) => job.id === expandedKey)) {
      setExpandedKey(undefined);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    setOpen(false);
    triggerRef.current?.focus();
  };

  const item = (job: AiTermInfo) => (
    <JobItem
      key={job.id}
      job={job}
      output={expandedKey === job.id ? (logs.current.get(job.id) || '') : ''}
      expanded={expandedKey === job.id}
      now={now}
      onToggle={() => {
        setExpandedKey((current) => (current === job.id ? undefined : job.id));
      }}
      {...isLive(job)
        ? {
          kill: {
            state: killPhase?.key === job.id ? killPhase.state : 'idle' as const,
            onPress: () => { pressKill(job); },
          },
        }
        : {}}
    />
  );

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onKeyDown} data-output-tick={outputTick}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-expanded={open}
        aria-label={countLabel}
        data-job-list=""
        onClick={() => {
          // 打开的那一刻就取一次时钟:挂载时的值早于所有任务,否则首帧会把长跑的行显示成 0
          setNow(Date.now());
          setOpen((current) => !current);
        }}
      >
        {liveRows.length > 0 ? <StateDot state="ongoing" className={css.triggerDot} /> : null}
        <span className={css.count}>{countLabel}</span>
        <IconChevronDownOutlineRegular size={12} className={open ? css.triggerOpen : undefined} />
      </button>
      {open
        ? (
          <ul ref={menuRef} className={css.menu} style={{ left: menuShift }} data-job-menu="" aria-label={tJob('list.aria')}>
            {liveRows.length > 0
              ? <li className={css.sectionHeader} aria-hidden="true">{tJob('section.live')}</li>
              : null}
            {liveRows.map(item)}
            {settledRows.length > 0
              ? (
                <li className={css.sectionHeader}>
                  <button
                    type="button"
                    className={css.sectionToggle}
                    aria-expanded={settledExpanded}
                    onClick={() => { setSettledOpen(!settledExpanded); }}
                  >
                    <IconChevronDownOutlineRegular size={12} className={settledExpanded ? `${css.sectionChevron} ${css.sectionChevronOpen}` : css.sectionChevron} />
                    {tJob('section.settledCount', { count: settledRows.length })}
                  </button>
                  <button type="button" className={css.sectionClear} onClick={clearSettled}>
                    {tJob('section.clear')}
                  </button>
                </li>
              )
              : null}
            {settledExpanded ? settledRows.map(item) : null}
          </ul>
        )
        : null}
    </div>
  );
}
