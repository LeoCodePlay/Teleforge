// AI 运行终端面板:对话区右上角的悬浮胶囊 + 右侧终端抽屉。
//
// 语义:只展示「被 AI 拉起运行的项目终端」(run_command / run_local_command 以 background=true
// 启动的后台进程,如 dev server)。面板内终端为只读 —— xterm 关闭 stdin,通道也不接受写入;
// 唯一可做的操作是「删除」(停止进程 + 移除记录),与需求约束一致。
//
// 数据来源:
//   列表/历史日志 = RPC(ai_term_list / ai_term_log / ai_term_delete / ai_term_resize)
//   实时输出     = 全局广播事件 type='ai_term'(start / output / exit / removed,见 server/core/ws.ts)
// 输出事件在挂载时就开始累积,因此抽屉打开前产生的输出也不会丢;xterm 首次创建时一次性回放。
// 回放与实时输出的边界由「hydrated」标记控制:未回放前到达的实时块只进缓存,避免重复/丢字。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api } from '../../api';
import { useFeedback } from '../../context/feedback';
import { useIsPhone } from '../../hooks/useMediaQuery';
import { StateDot } from '../StateDot/StateDot';
import { IconApiOutline14 } from '../icons/icons';
import type { AiTermInfo } from '../../types';
import '@xterm/xterm/css/xterm.css';
import './AiTermPanel.scss';

// 与命令台(ConsolePanel)同一套配色:近黑底,保证与顶部终端标签观感一致
const CAMPBELL = {
  background: '#0c0c0c',
  foreground: '#cccccc',
  cursor: '#ffffff',
  cursorAccent: '#0c0c0c',
  selectionBackground: '#4a4a4a',
  black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00',
  blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
  brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5',
  brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2'
};

const LOG_CAP = 200_000;

interface XTermBox {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement | null;
  ro: ResizeObserver | null;
  /** 是否已把历史日志一次性写入(此后实时块可直接写) */
  hydrated: boolean;
  size: string;
}

function stateDotOf(s: AiTermInfo['state']): 'ongoing' | 'done' | 'error' {
  return s === 'running' ? 'ongoing' : s === 'failed' ? 'error' : 'done';
}
function stateTextOf(t: AiTermInfo): string {
  if (t.state === 'running') return '运行中';
  if (t.state === 'failed') return t.exitCode == null ? '已中止' : `失败(退出码 ${t.exitCode})`;
  return t.exitCode == null ? '已结束' : `已结束(退出码 ${t.exitCode})`;
}
function shortCommand(cmd: string, max = 46): string {
  const s = String(cmd).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export default function AiTermPanel({ active, embedded = false, onCounts }: {
  active: boolean;
  /** 由外层 ActivityDock 托管:不渲染自己的悬浮胶囊/抽屉,只渲染面板内容 */
  embedded?: boolean;
  /** 向上汇报数量与运行中数量(宿主据此决定整块面板是否显示、标签上的角标) */
  onCounts?: (c: { count: number; running: number }) => void;
}) {
  const { confirm, toast } = useFeedback();
  const isPhone = useIsPhone();

  const [terms, setTerms] = useState<AiTermInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // 每个终端的输出缓存(先于 xterm 存在,用于首次回放与重连后的重建)
  const logs = useRef<Map<string, string>>(new Map());
  const xterms = useRef<Map<string, XTermBox>>(new Map());
  const hostCbs = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map());
  const mountedRef = useRef(true);

  const appendLog = useCallback((id: string, data: string) => {
    const next = (logs.current.get(id) || '') + data;
    logs.current.set(id, next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next);
  }, []);

  // ---------------- xterm 生命周期 ----------------

  const fitBox = useCallback((id: string) => {
    const x = xterms.current.get(id);
    if (!x || !x.host) return;
    if (!x.host.clientWidth || !x.host.clientHeight) return; // 隐藏时跳过
    try { x.fit.fit(); } catch { return; }
    const size = `${x.term.cols}x${x.term.rows}`;
    if (size === x.size) return;
    x.size = size;
    // 同步 PTY 尺寸:换行/进度条与可视宽度一致(服务端支持则生效,失败静默)
    api.send('ai_term_resize', { id, cols: x.term.cols, rows: x.term.rows });
  }, []);

  // 把已缓存的历史日志一次性写入终端(只在拿到日志后标记 hydrated,避免丢字/重字)
  const hydrate = useCallback((id: string) => {
    const x = xterms.current.get(id);
    if (!x || x.hydrated) return;
    if (!logs.current.has(id)) return; // 日志尚未拉取到,等 fetchAll 完成后再回放
    try { x.term.write(logs.current.get(id) || ''); } catch { /* 忽略 */ }
    x.hydrated = true;
    requestAnimationFrame(() => fitBox(id));
  }, [fitBox]);

  const disposeXterm = useCallback((id: string) => {
    const x = xterms.current.get(id);
    if (!x) return;
    try { x.ro?.disconnect(); } catch { /* 忽略 */ }
    try { x.term.dispose(); } catch { /* 忽略 */ }
    xterms.current.delete(id);
    hostCbs.current.delete(id);
  }, []);

  const openXterm = useCallback((id: string, host: HTMLDivElement) => {
    let x = xterms.current.get(id);
    if (!x) {
      const term = new Terminal({
        theme: CAMPBELL,
        fontFamily: '"Cascadia Mono", Consolas, "JetBrains Mono", monospace',
        fontSize: 12.5,
        cursorBlink: false,
        // 只读:不接受键盘输入;文本仍可选中复制
        disableStdin: true,
        scrollback: 4000,
        convertEol: false,
        rightClickSelectsWord: false
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      const ro = new ResizeObserver(() => fitBox(id));
      ro.observe(host);
      x = { term, fit, host, ro, hydrated: false, size: '' };
      xterms.current.set(id, x);
    } else {
      x.host = host;
    }
    hydrate(id);
    requestAnimationFrame(() => fitBox(id));
  }, [fitBox, hydrate]);

  const setHost = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) openXterm(id, el);
    else disposeXterm(id);
  }, [openXterm, disposeXterm]);

  // 稳定的 per-id ref 回调:避免每次渲染都触发 ref(null)/ref(el) 造成终端反复重建
  const hostRef = useCallback((id: string) => {
    let cb = hostCbs.current.get(id);
    if (!cb) {
      cb = (el: HTMLDivElement | null) => setHost(id, el);
      hostCbs.current.set(id, cb);
    }
    return cb;
  }, [setHost]);

  // ---------------- 数据:列表 + 历史日志 + 实时事件 ----------------

  const applyTerms = useCallback((list: AiTermInfo[]) => {
    setTerms(list);
    setActiveId((cur) => (cur && list.some((t) => t.id === cur) ? cur : list[0]?.id ?? null));
    // 清掉服务端已不存在的终端(可能被 evict)
    const alive = new Set(list.map((t) => t.id));
    for (const id of [...xterms.current.keys()]) if (!alive.has(id)) disposeXterm(id);
    for (const id of [...logs.current.keys()]) if (!alive.has(id)) logs.current.delete(id);
  }, [disposeXterm]);

  const fetchAll = useCallback(async () => {
    try {
      const r = await api.request('ai_term_list', {}, 10000, 'ai_term_list');
      const list: AiTermInfo[] = Array.isArray(r?.terms) ? r.terms : [];
      if (!mountedRef.current) return;
      applyTerms(list);
      // 历史日志:拉取并回放到已创建的 xterm(挂载后新产生的输出由事件累积)
      await Promise.all(list.map(async (t) => {
        try {
          const lr = await api.request('ai_term_log', { id: t.id }, 10000, 'ai_term_log');
          if (!mountedRef.current) return;
          if (!logs.current.has(t.id)) logs.current.set(t.id, String(lr?.log || ''));
          hydrate(t.id);
        } catch { /* 单个终端日志拉取失败不影响列表 */ }
      }));
    } catch {
      /* 列表拉取失败(服务端未起/断线):WS 重连后会自动重试,不打断界面 */
    }
  }, [applyTerms, hydrate]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchAll();
    const offTerm = api.on('ai_term', (m: any) => {
      const id = String(m?.id || m?.term?.id || '');
      if (!id) return;
      if (m.event === 'start') {
        const term: AiTermInfo | undefined = m.term;
        if (!term) return;
        if (!logs.current.has(id)) logs.current.set(id, '');
        setTerms((prev) => (prev.some((t) => t.id === id) ? prev : [term, ...prev]));
        setActiveId((cur) => cur ?? id);
        hydrate(id);
        return;
      }
      if (m.event === 'output') {
        const data = String(m?.data || '');
        if (!data) return;
        appendLog(id, data);
        const x = xterms.current.get(id);
        if (x && x.hydrated) { try { x.term.write(data); } catch { /* 忽略 */ } }
        return;
      }
      if (m.event === 'exit') {
        // 结束即从「运行终端」列表移除:面板只展示正在运行的终端
        const term: AiTermInfo | undefined = m.term;
        if (!term) return;
        setTerms((prev) => prev.filter((t) => t.id !== term.id));
        logs.current.delete(term.id);
        disposeXterm(term.id);
        setActiveId((cur) => (cur === term.id ? null : cur));
        // toast 的底层 pushToast 是稳定回调,这里即使闭包偏旧也能正确弹出
        if (term.state === 'failed') toast.error(`运行终端「${term.label}」已结束(退出码 ${term.exitCode ?? '未知'})`);
        else toast.info(`运行终端「${term.label}」已结束`);
        return;
      }
      if (m.event === 'removed') {
        setTerms((prev) => prev.filter((t) => t.id !== id));
        logs.current.delete(id);
        disposeXterm(id);
        setActiveId((cur) => (cur === id ? null : cur));
      }
    });
    // 前端重连(服务端可能重启/断线期间有新终端):丢弃本地缓存并重建终端,重新拉取列表与日志
    const offOpen = api.on('open', () => {
      for (const id of [...xterms.current.keys()]) disposeXterm(id);
      logs.current.clear();
      void fetchAll();
    });
    return () => { mountedRef.current = false; offTerm(); offOpen(); };
  }, [appendLog, disposeXterm, fetchAll, hydrate]);

  // 列表变化后把 activeId 收敛到有效值;没有终端时自动收起
  useEffect(() => {
    if (!terms.length) { setOpen(false); setActiveId(null); return; }
    if (!activeId || !terms.some((t) => t.id === activeId)) setActiveId(terms[0].id);
  }, [terms, activeId]);

  // 抽屉打开 / 切换终端 / 窗口尺寸变化:xterm 重新适配
  useEffect(() => {
    if (!open || !activeId) return;
    const raf = requestAnimationFrame(() => fitBox(activeId));
    return () => cancelAnimationFrame(raf);
  }, [open, activeId, terms, fitBox]);

  // 离开 AI 对话标签时收起(悬浮胶囊与抽屉都只在对话区展示)
  useEffect(() => { if (!active) setOpen(false); }, [active]);

  // Escape 关闭抽屉
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // 组件卸载:释放全部 xterm
  useEffect(() => () => {
    for (const id of [...xterms.current.keys()]) disposeXterm(id);
  }, [disposeXterm]);

  // ---------------- 删除(唯一允许的操作) ----------------

  const removeTerm = useCallback(async (t: AiTermInfo) => {
    const ok = await confirm({
      title: '删除运行终端',
      message: `确定删除「${t.label}」?\n`
        + (t.state === 'running' ? '该进程会被立即终止,其输出日志会一并清除。' : '其输出日志会被清除。'),
      confirmLabel: '删除',
      danger: true
    });
    if (!ok) return;
    setBusyId(t.id);
    try {
      await api.request('ai_term_delete', { id: t.id }, 15000, 'ai_term_deleted');
      setTerms((prev) => prev.filter((x) => x.id !== t.id));
      logs.current.delete(t.id);
      disposeXterm(t.id);
      toast.success('已删除运行终端');
    } catch (e) {
      toast.error(`删除失败:${(e as Error).message}`);
    } finally {
      if (mountedRef.current) setBusyId(null);
    }
  }, [confirm, disposeXterm, toast]);

  // ---------------- 渲染 ----------------

  const running = terms.filter((t) => t.state === 'running').length;
  useEffect(() => { onCounts?.({ count: terms.length, running }); }, [terms.length, running, onCounts]);
  const current = terms.find((t) => t.id === activeId) || terms[0] || null;

  const fab = active && terms.length > 0 && (
    <button
      type="button"
      className={`aiterm-fab${running > 0 ? ' live' : ''}${open ? ' on' : ''}`}
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      aria-label={`运行终端(${terms.length} 个${running ? `,${running} 个运行中` : ''})`}
      data-tip="AI 拉起的运行终端"
    >
      <span className="aiterm-fab-ico"><IconApiOutline14 size={14} /></span>
      <span className="aiterm-fab-text">运行终端</span>
      <span className="aiterm-fab-count">{terms.length}</span>
    </button>
  );

  // 面板内容:终端切换条 + xterm 容器 + 底部状态栏(宿主的头部/抽屉外壳不在这里)
  const body = (
    <>
      {terms.length > 1 && (
        <div className="aiterm-tabs" role="tablist" aria-label="终端列表">
          {terms.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === activeId}
              className={`aiterm-tab${t.id === activeId ? ' on' : ''}`}
              onClick={() => setActiveId(t.id)}
              data-tip={`${t.label}\n${t.command}`}
            >
              <StateDot state={stateDotOf(t.state)} size={9} />
              <span className="aiterm-tab-label">{t.label}</span>
            </button>
          ))}
        </div>
      )}

      <div className="aiterm-body">
        {!terms.length && <div className="aiterm-empty">当前没有 AI 拉起的运行终端</div>}
        {terms.map((t) => (
          <div
            key={t.id}
            className={`aiterm-term${t.id === current?.id ? ' on' : ''}`}
            ref={hostRef(t.id)}
            aria-label={`${t.label} 终端输出`}
          />
        ))}
      </div>

      {current && (
        <footer className="aiterm-bar">
          <StateDot state={stateDotOf(current.state)} size={10} />
          <span className={`aiterm-state st-${current.state}`}>{stateTextOf(current)}</span>
          <span className="aiterm-cmd" title={current.command}>{shortCommand(current.command)}</span>
          <span className="aiterm-meta">
            {current.target === 'remote' ? '远程' : '本机'}
            {current.cwd ? ` · ${current.cwd}` : ''}
          </span>
          <span className="aiterm-bar-gap" />
          <button
            type="button"
            className="aiterm-del"
            disabled={busyId === current.id}
            onClick={() => { void removeTerm(current); }}
            data-tip={current.state === 'running' ? '终止该进程并从列表移除' : '从列表移除'}
          >
            {busyId === current.id ? '删除中…' : '删除'}
          </button>
        </footer>
      )}

      {current?.note && <div className="aiterm-note">{current.note}</div>}
      <div className="aiterm-hint">终端只读,不接受输入;不再需要时可删除该运行终端</div>
    </>
  );

  // 由 ActivityDock 托管:只出内容(空的时候什么都不渲染,宿主自然不显示这一栏)
  if (embedded) return terms.length ? <div className="aiterm-embedded">{body}</div> : null;

  if (!terms.length) return <>{fab}</>;

  return (
    <>
      {fab}
      {open && !isPhone && <div className="aiterm-backdrop" onClick={() => setOpen(false)} />}
      <aside
        className={`aiterm-drawer${open ? ' open' : ''}${isPhone ? ' phone' : ''}`}
        role="dialog"
        aria-modal={open}
        aria-label="AI 运行终端"
        aria-hidden={!open}
      >
        <header className="aiterm-head">
          <span className="aiterm-title"><IconApiOutline14 size={14} />运行终端</span>
          <span className="aiterm-sub">
            {terms.length} 个运行中
            {/* 面板只列出正在运行的终端:进程结束后条目自动消失(见 exit 事件处理) */}
          </span>
          <span className="aiterm-head-gap" />
          <button type="button" className="chip-btn" onClick={() => setOpen(false)} aria-label="收起运行终端">收起</button>
        </header>

        {body}
      </aside>
    </>
  );
}
