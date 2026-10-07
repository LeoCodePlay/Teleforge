// 终端面板宿主:把 dsh 原版 `TerminalBody`(ui-sidebar-terminal 的槽位注册体)接到本项目的
// **既有 shell 通道**上。
//
// 与文件树面板(A)同一条路线:面板只吃槽位运行时给的 props,而本项目没移植那层运行时,
// 所以在这里手搓 —— 差别在于终端还要一个「React-free 的视图模型」(dsh 的 `TerminalView`:
// 创建/attach/写输入/resize/收画面),这里用 `/ws/term` 通道自己实现一个。
//
// 数据面(`server/core/ws.ts` 的 `/ws/term`,与 ConsolePanel 用的是同一条):
//   上行 二进制帧 = 键盘输入;文本帧 = {type:'start',mode,cols,rows} / {type:'resize',cols,rows} / {type:'kill'}
//   下行 二进制帧 = shell 输出;文本帧 = {type:'ready'} / {type:'exit'} / {type:'error',error}
// 注意它**没有回放完整屏幕**的能力,所以发给 DOM 终端的帧一律是 dsh 的 `output` 分支
// (不是 `snapshot`);面板在 mount 时 xterm 本来就是空的,因此不需要 reset。
import React, { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { KeyedSnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit';
import type {
  TerminalEnvironment, TerminalView, TerminalViewState, WebTerminalId,
} from '../../dsh-adapters/api-terminal-controller';
import type { ThemeSnapshot } from '../../dsh-adapters/ui-theme';
import { TerminalBody } from '../../dsh/ui-sidebar-terminal/client/terminal.tsx';
import { zh } from '../../dsh/ui-sidebar-terminal/client/locales.ts';
import type { PanelTabInfo, UseSessions } from './dsh-panel-contracts';

/**
 * 会话终端的上限与容量:cols/rows 与 `server/core/ws.ts` 的 clamp 对齐(2..500 / 2..300),
 * scrollback 取一个够用又不至于吃内存的值。
 */
const LIMITS = { maxInputBytes: 65536, maxCols: 500, maxRows: 300, scrollback: 5000 } as const;

/** 未确认帧最多缓存多少片输出。面板被隐藏/卸载时不再写 DOM,不能让它无限长。 */
const MAX_QUEUED_FRAMES = 2048;

/** 终端视图模型:把 dsh 的 `TerminalView` 落到本项目的 shell 通道上。 */
class SidebarTerminalModel implements TerminalView {
  readonly id: WebTerminalId;
  readonly state: SnapshotStore<TerminalViewState>;

  private ws: WebSocket | null = null;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private cols = 80;
  private rows = 24;
  /** 已发出、还没被 DOM 终端 ack 的帧 revision。 */
  private revision = 0;
  /** 有没有一帧正在等 ack(等的时候新输出先排队,否则会被后一帧覆盖丢掉)。 */
  private pending = false;
  private readonly queued: string[] = [];
  /** 主动关闭:之后不再把 onclose 当成掉线。 */
  private disposed = false;

  constructor(id: WebTerminalId, private readonly environment: TerminalEnvironment, private readonly local: boolean) {
    this.id = id;
    this.state = createSnapshotStore<TerminalViewState>({ phase: 'idle', writable: false });
  }

  private patch(next: Partial<TerminalViewState>): void {
    this.state.set({ ...this.state.getSnapshot(), ...next });
  }

  mount = (): (() => void) => {
    this.ensure();
    // dsh 的语义:视图在 DOM 卸载后仍存活,进程只在显式 close 时结束 —— 所以这里不杀会话。
    return () => {};
  };

  refresh = async (): Promise<void> => {
    this.disposed = false;
    try { this.ws?.close(); } catch { /* 已经关了 */ }
    this.ws = null;
    this.patch({ phase: 'idle', info: undefined, error: undefined, render: undefined });
    this.ensure();
  };

  connect = (): void => { this.ensure(); };

  write = (data: string): void => {
    const ws = this.ws;
    if (ws !== null && ws.readyState === 1) { try { ws.send(this.encoder.encode(data)); } catch { /* 半开连接 */ } }
  };

  resize = (cols: number, rows: number): void => {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    this.cols = Math.max(2, Math.min(LIMITS.maxCols, Math.trunc(cols) || 80));
    this.rows = Math.max(2, Math.min(LIMITS.maxRows, Math.trunc(rows) || 24));
    const ws = this.ws;
    if (ws !== null && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'resize', cols: this.cols, rows: this.rows })); } catch { /* 半开连接 */ }
    }
  };

  acknowledge = (revision: number): void => {
    if (revision !== this.revision) return;
    this.pending = false;
    this.patch({ render: undefined });
    this.emit();
  };

  /** 主动结束:先让服务端收掉 PTY,再断开通道。 */
  dispose(): void {
    this.disposed = true;
    const ws = this.ws;
    this.ws = null;
    if (ws !== null && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'kill' })); } catch { /* 半开连接 */ }
    }
    try { ws?.close(); } catch { /* 已经关了 */ }
    this.patch({ phase: 'closed', writable: false });
  }

  /** 建立通道并让服务端起 shell;已经连着就什么都不做。 */
  private ensure(): void {
    if (this.ws !== null && this.ws.readyState <= 1) return;
    this.patch({ phase: 'loading', environment: this.environment, writable: false });
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws/term`);
    } catch (error) {
      this.fail((error as Error).message);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.patch({ phase: 'creating' });
      try {
        ws.send(JSON.stringify({ type: 'start', mode: this.local ? 'local' : 'remote', cols: this.cols, rows: this.rows }));
      } catch { /* 半开连接 */ }
    };
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        let message: { type?: string; error?: string };
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'ready') this.ready();
        else if (message.type === 'exit') this.exit();
        else if (message.type === 'error') this.fail(String(message.error ?? ''));
        return;
      }
      this.pushOutput(this.decode(event.data));
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (!this.disposed) this.patch({ phase: 'disconnected', writable: false });
    };
    // onerror 之后紧跟 onclose,状态统一在那里落。
    ws.onerror = () => {};
  }

  private decode(data: unknown): string {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return this.decoder.decode(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) return this.decoder.decode(data as ArrayBufferView as Uint8Array);
    return '';
  }

  private ready(): void {
    this.patch({
      phase: 'connected',
      writable: true,
      error: undefined,
      environment: this.environment,
      info: {
        id: this.id,
        title: this.local ? '本机终端' : '远程终端',
        // shell 名字只用于展示:本项目由服务端决定真正的 shell,前端不参与挑选。
        shell: { path: '', args: [], name: this.local ? '本机 shell' : 'SSH shell' },
        cwd: this.environment.cwd,
        cols: this.cols,
        rows: this.rows,
        state: 'running',
        exitCode: null,
      },
    });
  }

  private exit(): void {
    const info = this.state.getSnapshot().info;
    this.patch({
      phase: 'closed',
      writable: false,
      info: info === undefined ? undefined : { ...info, state: 'exited', exitCode: null },
    });
  }

  private fail(message: string): void {
    this.patch({ phase: 'failed', writable: false, error: message === '' ? '终端连接失败' : message });
  }

  private pushOutput(text: string): void {
    if (text === '') return;
    this.queued.push(text);
    if (this.queued.length > MAX_QUEUED_FRAMES) this.queued.splice(0, this.queued.length - MAX_QUEUED_FRAMES);
    this.emit();
  }

  /** 同一时刻只让一帧在等 ack:DOM 终端 ack 之后才发下一帧,否则后帧会覆盖前帧。 */
  private emit(): void {
    if (this.pending) return;
    const next = this.queued.shift();
    if (next === undefined) return;
    this.pending = true;
    this.revision += 1;
    const revision = this.revision;
    this.patch({ render: { revision, frame: { type: 'output', sequence: revision, data: next } } });
  }
}

// ---- 模型登记表:按 会话 × 标签 缓存,标签关闭时显式回收(见 disposeSidebarTerminal) ----
const models = new Map<string, SidebarTerminalModel>();
const modelKey = (sid: string, tabId: string): string => `${sid}::${tabId}`;

function modelFor(sid: string, tabId: TabId, environment: TerminalEnvironment, local: boolean): SidebarTerminalModel {
  const key = modelKey(sid, String(tabId));
  let model = models.get(key);
  if (model === undefined) {
    // 标签 id 本身就是这条终端的身份:品牌类型在编译期防串号,运行时就是字符串。
    model = new SidebarTerminalModel(String(tabId) as WebTerminalId, environment, local);
    models.set(key, model);
  }
  return model;
}

/** 标签被关掉时回收它的终端(由 DockSidebar 的标签消失检测调用)。 */
export function disposeSidebarTerminal(sid: string, tabId: string): void {
  const key = modelKey(sid, tabId);
  const model = models.get(key);
  if (model === undefined) return;
  models.delete(key);
  model.dispose();
}

/** 会话切换/关闭时回收它下面所有终端。 */
export function disposeSidebarTerminalsOf(sid: string): void {
  for (const key of [...models.keys()]) {
    if (!key.startsWith(`${sid}::`)) continue;
    const model = models.get(key);
    models.delete(key);
    model?.dispose();
  }
}

/** 主题只用于触发重新取色(颜色真的从 xterm 容器的 computed style 读);本项目没有 dsh 的主题服务。 */
const THEME: ThemeSnapshot = {
  preference: 'system',
  fontSize: 13,
  active: { id: 'teleforge', colorScheme: 'dark', tokens: {} },
  themes: [],
  revision: 1,
};

interface Props {
  tabId: TabId;
  sid: string;
  /** 会话工作区根:只用于状态里展示的 cwd(真正的 cwd 由服务端决定)。 */
  cwd: string;
  /** 本机 shell 还是远端 SSH shell(与服务端 start.mode 对应) */
  local: boolean;
  /** 面板里的「新建终端」按钮:宿主负责再开一条终端标签 */
  onNewTerminal: () => void;
}

export default function TerminalPanelHost({ tabId, sid, cwd, local, onNewTerminal }: Props) {
  const environment = useMemo<TerminalEnvironment>(() => ({ cwd, ...LIMITS }), [cwd]);
  const model = useMemo(() => modelFor(sid, tabId, environment, local), [sid, tabId, environment, local]);
  // 挂载时确保连接;卸载不留副作用(dsh 的视图在 DOM 卸载后仍存活)。
  useEffect(() => model.mount(), [model]);

  const view = useCallback(() => model, [model]);
  const source = model.state;

  // 面板通过 keyedHooks.terminal 拿到 useTerminal(key, selector?)。
  const useTerminal = useMemo(() => {
    function useTerminalHook<Selected>(
      key: string,
      selector?: (value: TerminalViewState | undefined) => Selected,
      equal?: (left: Selected, right: Selected) => boolean,
    ): Selected | TerminalViewState | undefined {
      void key; // 一个宿主 = 一条标签,key 恒指向本模型的 state
      const cache = useRef<{ value: Selected | TerminalViewState | undefined } | null>(null);
      const get = (): Selected | TerminalViewState | undefined => {
        const snapshot = source.getSnapshot();
        const next = selector === undefined ? snapshot : selector(snapshot);
        const cached = cache.current;
        const same = cached !== null
          && (equal !== undefined ? equal(cached.value as Selected, next as Selected) : Object.is(cached.value, next));
        if (same && cached !== null) return cached.value;
        cache.current = { value: next };
        return next;
      };
      return useSyncExternalStore(source.subscribe, get, get);
    }
    return useTerminalHook as unknown as KeyedSnapshotSelectorHook<TerminalViewState>;
  }, [source]);

  const useTheme = useCallback(<Selected,>(selector: (value: ThemeSnapshot) => Selected): Selected => selector(THEME), []);

  const t = useCallback<TranslateNS<'sidebarTerminal'>>((key, params) => {
    const template = (zh as Record<string, string>)[key] ?? String(key);
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''));
  }, []);

  const sessions = useMemo(() => ({ byId: { [sid]: cwd === '' ? {} : { cwd } } }), [sid, cwd]);
  const useSessions = useCallback<UseSessions>((selector) => selector(sessions), [sessions]);

  const openNew = useRef(onNewTerminal);
  openNew.current = onNewTerminal;
  const tab = useMemo<PanelTabInfo>(() => ({
    id: tabId,
    // 终端不吃标签记录的中止信号:它跟随 /ws/term 通道,而不是标签的可见性。
    signal: new AbortController().signal,
    visible: true,
    refreshShortcut: undefined,
    actions: {
      bindCommands: () => () => {},
      // dsh 的 TerminalBody 用 openResource 打开终端资源;本项目不涉及。
      openResource: () => {},
      // 「新建终端」:再开一条终端标签(dsh 的 replaceTab 语义在右栏里退化成新增)。
      openTab: (kind) => { if (kind === 'terminal') openNew.current(); },
      close: () => {},
    },
  }), [tabId]);

  const useTabInfo = useCallback(() => ({ tab }), [tab]);

  return (
    <TerminalBody
      useTabInfo={useTabInfo}
      sessionId={sid}
      useSessions={useSessions}
      view={view}
      useTerminal={useTerminal}
      useTheme={useTheme}
      t={t}
    />
  );
}
