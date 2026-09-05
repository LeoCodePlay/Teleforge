import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useCoarsePointer } from '../../hooks/useMediaQuery';
import '@xterm/xterm/css/xterm.css';
import './ConsolePanel.scss';

const QUICK = ['ls -la', 'pwd', 'node -v', 'git status', 'df -h .'];
const encoder = new TextEncoder();

type TermMode = 'remote' | 'local';
type TermState = 'idle' | 'starting' | 'running' | 'closed';

// Campbell 配色(Windows Terminal 的 CMD 主题)
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

const gray = (s: string) => `\x1b[90m${s}\x1b[0m`;
const red = (s: string) => `\x1b[91m${s}\x1b[0m`;

// 写剪贴板:优先 Clipboard API,非安全上下文降级为隐藏 textarea + execCommand
const writeClipboard = async (text: string) => {
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  } catch {}
};

// 读剪贴板并注入终端(仅右键/快捷键触发,读取失败静默忽略)
const readClipboard = (): Promise<string> =>
  navigator.clipboard?.readText?.() ?? Promise.resolve('');

interface TermMenuState { x: number; y: number; hasSel: boolean }

// 右键菜单估计尺寸,用于把菜单限制在窗口内
const MENU_W = 150, MENU_H = 96;

// 单个终端会话(每个远程/本地终端一份):持有自己的 xterm、WebSocket 与状态。
// 所有会话并列常驻、互不影响;切换只是显示/隐藏,不销毁对方。
interface TermSession {
  id: number;
  mode: TermMode;
  name: string;
  term: Terminal;
  fit: FitAddon;
  ws: WebSocket | null;
  state: TermState;
  pending: string[];        // shell 就绪前缓存的键盘输入
  restartWanted: boolean;
  wsFail: boolean;
  wsFailNotified: boolean;
  hasSel: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  manualClose: boolean;
}

// 渲染用的描述(驱动列表与窗口面板);name 为用户自定义名(空串=未重命名,用默认名)
interface TermDesc {
  id: number;
  mode: TermMode;
  name: string;
  state: TermState;
  wsFail: boolean;
}

interface ConsolePanelProps {
  connected: boolean;
  visible: boolean;
  /** 当前活动连接 id;切换服务器时远程终端自动重开,面向新服务器 */
  activeConn?: string | null;
  /** 当前活动 SSH 连接的 IP(未连接时为 null);远程终端未重命名时显示它 */
  hostIp?: string | null;
}

// 真实终端:xterm.js 前端 + 服务端 /ws/term shell 通道(每个会话一条独立 WS)
// 文本帧(JSON)= 控制消息,二进制帧 = 终端原始数据(键盘输入上行 / 屏幕输出下行)
export default function ConsolePanel({ connected, visible, activeConn, hostIp }: ConsolePanelProps) {
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // 终端列表与当前可见 id;默认一个远程 + 一个本地终端
  const [descs, setDescs] = useState<TermDesc[]>(() => [
    { id: 1, mode: 'remote', name: '', state: 'idle', wsFail: false },
    { id: 2, mode: 'local', name: '', state: 'idle', wsFail: false }
  ]);
  const [activeId, setActiveId] = useState<number>(1);
  const activeIdRef = useRef(1);
  activeIdRef.current = activeId;

  const nextIdRef = useRef(3);
  const sessions = useRef<Map<number, TermSession>>(new Map());   // id -> 会话对象
  const hosts = useRef<Map<number, HTMLDivElement | null>>(new Map()); // id -> 宿主容器
  const ros = useRef<Map<number, ResizeObserver>>(new Map());     // id -> 尺寸观察器

  const [menu, setMenu] = useState<TermMenuState | null>(null); // 右键菜单(xterm 区)
  const menuRef = useRef<HTMLDivElement>(null);

  // 列表项右键菜单(重命名/删除)与内联重命名编辑
  interface ListMenuState { id: number; x: number; y: number }
  const [listMenu, setListMenu] = useState<ListMenuState | null>(null);
  const listMenuRef = useRef<HTMLDivElement>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [editText, setEditText] = useState('');

  // 触摸优先设备:右侧 200px 终端列表在手机上隐藏,改用工具栏切换器
  const coarse = useCoarsePointer();
  // 移动端终端切换器(粗指针才渲染):点击 ⌨ 终端 ▾ 弹出列表
  const [termMenuOpen, setTermMenuOpen] = useState(false);
  const termMenuRef = useRef<HTMLDivElement>(null);

  // 列表拖拽排序状态
  const [drag, setDrag] = useState<{ id: number; over: number; pos: 'before' | 'after' } | null>(null);
  const suppressClickRef = useRef(false); // 拖放后抑制紧随的 click 误触发切换

  // 右侧终端列表宽度(可拖拽调整)
  const [listW, setListW] = useState(200);
  const listRef = useRef<HTMLDivElement>(null);

  const getSession = (id: number) => sessions.current.get(id) || null;

  const setStateOf = (ses: TermSession, s: TermState) => {
    ses.state = s;
    setDescs((p) => p.map((d) => (d.id === ses.id ? { ...d, state: s } : d)));
  };
  const setWsFailOf = (ses: TermSession, v: boolean) => {
    ses.wsFail = v;
    setDescs((p) => p.map((d) => (d.id === ses.id ? { ...d, wsFail: v } : d)));
  };

  // 发送控制消息(JSON 文本帧)
  const sendCtrl = (ses: TermSession, o: Record<string, unknown>) => {
    const ws = ses.ws;
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(o)); } catch {} }
  };
  // 发送键盘输入(二进制帧)
  const sendInput = (ses: TermSession, data: string) => {
    const ws = ses.ws;
    if (ws && ws.readyState === 1) { try { ws.send(encoder.encode(data)); } catch {} }
  };
  const writeLine = (ses: TermSession, s: string) => { try { ses.term.write(s); } catch {} };

  // 打开 shell 会话
  const startSession = (ses: TermSession) => {
    const ws = ses.ws;
    if (!ws || ws.readyState !== 1) return;
    if (ses.state === 'running' || ses.state === 'starting') return;
    setStateOf(ses, 'starting');
    ses.pending = [];
    sendCtrl(ses, { type: 'start', mode: ses.mode, cols: ses.term.cols || 80, rows: ses.term.rows || 24 });
  };

  // 重启会话:先 kill 旧 shell,收到 exit 后自动开新的
  const restartSession = (ses: TermSession) => {
    if (ses.state === 'running' || ses.state === 'starting') {
      ses.restartWanted = true;
      sendCtrl(ses, { type: 'kill' });
    } else {
      startSession(ses);
    }
  };

  // 复制当前可见终端的选中文本
  const copySelection = () => {
    const ses = getSession(activeIdRef.current);
    if (!ses?.term.hasSelection()) return;
    writeClipboard(ses.term.getSelection());
  };

  // 从剪贴板粘贴到当前可见终端
  const pasteClipboard = () => {
    const ses = getSession(activeIdRef.current);
    if (!ses || ses.state !== 'running') return;
    readClipboard().then((t) => { if (t) sendInput(ses, t); }).catch(() => {});
  };

  // 创建会话对象(xterm + 事件绑定 + 独立 WebSocket;宿主容器后续 ref 时挂上)
  const styleAttach = useCallback((ses: TermSession, host: HTMLDivElement) => {
    hosts.current.set(ses.id, host);
    ses.term.open(host);
    const doFit = () => {
      if (!host || !host.clientWidth || !host.clientHeight) return; // 隐藏时跳过
      const before = `${ses.term.cols}x${ses.term.rows}`;
      try { ses.fit.fit(); } catch {}
      if (`${ses.term.cols}x${ses.term.rows}` !== before) sendCtrl(ses, { type: 'resize', cols: ses.term.cols, rows: ses.term.rows });
    };
    const ro = new ResizeObserver(() => doFit());
    ro.observe(host);
    ros.current.set(ses.id, ro);
    doFit();
  }, []);

  // 创建完整会话(建 xterm、接 WS、自动发起连接;完全独立于其它会话)
  const createSession = (id: number, mode: TermMode, name: string): TermSession => {
    const term = new Terminal({
      theme: CAMPBELL,
      fontFamily: '"Cascadia Mono", Consolas, "JetBrains Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
      rightClickSelectsWord: false
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const ses: TermSession = {
      id, mode, name, term, fit, ws: null,
      state: 'idle', pending: [], restartWanted: false,
      wsFail: false, wsFailNotified: false, hasSel: false, reconnectTimer: null, manualClose: false
    };

    // 键盘输入 -> 上行;shell 未就绪时先缓存
    term.onData((data) => {
      if (ses.state === 'running') sendInput(ses, data);
      else if (ses.state === 'starting') ses.pending.push(data);
    });
    // 跟踪是否选中文本(供复制功能/右键菜单使用)
    term.onSelectionChange(() => { ses.hasSel = term.hasSelection(); });
    // 快捷键:Ctrl+Shift+C 复制(粘贴走 xterm 原生 paste 事件,不再自定义拦截——否则与
    // xterm 内置的 textarea paste 事件重复触发,会导致一次 Ctrl+V 粘两段)
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      const mod = ev.ctrlKey || ev.metaKey;
      if (!mod) return true;
      const k = ev.key.toLowerCase();
      if (ev.shiftKey && k === 'c') { copySelection(); return false; }
      return true;
    });

    writeLine(ses, gray(`${mode === 'remote' ? '远程' : '本地'}终端:${methodLabel(mode)}\r\n`) + gray('等待连接后自动打开…\r\n'));

    // 独立 WebSocket;连接失败自动重试
    const connectWs = () => {
      if (ses.manualClose) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      let ws: WebSocket;
      try { ws = new WebSocket(`${proto}://${location.host}/ws/term`); } catch { return; }
      ws.binaryType = 'arraybuffer';
      ses.ws = ws;
      const onMessage = (e: MessageEvent) => {
        if (typeof e.data === 'string') {
          let m: any;
          try { m = JSON.parse(e.data); } catch { return; }
          if (m.type === 'ready') {
            setStateOf(ses, 'running');
            const p = ses.pending; ses.pending = [];
            for (const d of p) sendInput(ses, d);
            if (visibleRef.current && activeIdRef.current === ses.id) ses.term.focus();
          } else if (m.type === 'exit') {
            const wasRunning = ses.state === 'running' || ses.state === 'starting';
            setStateOf(ses, 'closed');
            if (ses.restartWanted) {
              ses.restartWanted = false;
              setTimeout(() => startSession(ses), 150);
            } else if (wasRunning) {
              writeLine(ses, '\r\n' + gray('[终端会话已结束] 点击"重启终端"启动新会话') + '\r\n');
            }
          } else if (m.type === 'error') {
            setStateOf(ses, 'closed');
            writeLine(ses, '\r\n' + red(`[错误] ${m.error}`) + '\r\n');
          }
        } else {
          try { ses.term.write(new Uint8Array(e.data)); } catch {} // shell 输出直接进终端
        }
      };
      ws.onopen = () => {
        setWsFailOf(ses, false);
        ses.wsFailNotified = false;
        const canOpen = ses.mode === 'local' || connectedRef.current;
        if (canOpen && (ses.state === 'idle' || ses.state === 'closed')) startSession(ses);
      };
      ws.onmessage = onMessage;
      ws.onclose = () => {
        if (ses.manualClose) return;
        setWsFailOf(ses, true);
        if (ses.state === 'running' || ses.state === 'starting') setStateOf(ses, 'closed');
        if (!ses.wsFailNotified) {
          ses.wsFailNotified = true;
          writeLine(ses, '\r\n' + red('[终端通道连接失败:服务端可能未更新到新版本,请重启服务端进程;正在自动重试…]') + '\r\n');
        }
        ses.reconnectTimer = setTimeout(() => { ses.reconnectTimer = null; connectWs(); }, 2000);
      };
      ws.onerror = () => {};
    };
    connectWs();
    return ses;
  };

  // 释放会话(删除终端时)
  const disposeSession = (ses: TermSession) => {
    ses.manualClose = true;
    if (ses.reconnectTimer) { clearTimeout(ses.reconnectTimer); ses.reconnectTimer = null; }
    try { ses.ws?.close(); } catch {}
    ses.ws = null;
    try { ses.term.dispose(); } catch {}
    const ro = ros.current.get(ses.id);
    if (ro) { try { ro.disconnect(); } catch {} ros.current.delete(ses.id); }
    hosts.current.delete(ses.id);
    sessions.current.delete(ses.id);
  };

  // 打开一个新的远程/本地终端(往返可独立常驻)
  const addTerminal = (mode: TermMode) => {
    const id = nextIdRef.current++;
    const ses = createSession(id, mode, '');
    sessions.current.set(id, ses);
    setDescs((p) => [...p, { id, mode, name: '', state: 'idle', wsFail: false }]);
    setActiveId(id);
  };

  // 重命名终端(空名 = 恢复默认名:远程显示 IP/离线,本地显示「本地」)
  const renameTerminal = (id: number, name: string) => {
    const n = name.trim();
    const ses = sessions.current.get(id);
    if (ses) ses.name = n;
    setDescs((p) => p.map((d) => (d.id === id ? { ...d, name: n } : d)));
  };

  // 拖拽排序:把 id 移动到 overId 之前/之后
  const reorderList = (id: number, overId: number, pos: 'before' | 'after') => {
    if (id === overId) return;
    setDescs((p) => {
      const item = p.find((d) => d.id === id);
      const arr = p.filter((d) => d.id !== id);
      if (!item || arr.length === 0) return p;
      let to = arr.findIndex((d) => d.id === overId);
      if (pos === 'after') to += 1;
      arr.splice(to, 0, item);
      return arr;
    });
  };

  // 右侧终端列表拖拽调宽
  const startListResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = listRef.current?.offsetWidth || 200;
    const onMove = (ev: PointerEvent) => {
      const w = Math.min(Math.max(startW + (startX - ev.clientX), 150), window.innerWidth * 0.45);
      setListW(w);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  // 删除终端:至少保留一个
  const removeTerminal = (id: number) => {
    if (descs.length <= 1) return; // 至少保留一个
    const ses = sessions.current.get(id);
    if (ses) disposeSession(ses);
    const kept = descs.filter((d) => d.id !== id);
    if (id === activeId) {
      // 优先切到同类型(远程/本地)的一个,否则最后一个
      const mode = ses?.mode || 'remote';
      const next = kept.find((d) => d.mode === mode) || kept[kept.length - 1];
      setActiveId(next.id);
    }
    setDescs(kept);
  };

  const activeDesc = descs.find((d) => d.id === activeId) || descs[0];
  const visibleDescId = activeDesc?.id ?? null;

  // --- 初始:挂载默认列表(远程 + 本地)的会话 ---
  const createdInitial = useRef(false);
  useEffect(() => {
    if (createdInitial.current) return;
    createdInitial.current = true;
    for (const d of descs) {
      const ses = createSession(d.id, d.mode, d.name);
      sessions.current.set(d.id, ses);
      // 宿主容器在 DOM 提交阶段已先挂载(ref 回调已存进 hosts);此处若已存在则补挂 xterm
      const host = hosts.current.get(d.id);
      if (host) styleAttach(ses, host);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 宿主容器 ref 回调(稳定引用,经 dataset 取 id):挂 xterm / 尺寸适配
  const hostRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const id = Number(el.dataset.tid);
    if (!Number.isFinite(id)) return;
    hosts.current.set(id, el);
    const ses = sessions.current.get(id);
    if (ses) styleAttach(ses, el);
  }, [styleAttach]);

  // SSH 连接状态变化/切换服务器:只影响远程会话(本地终端独立运行,不受影响)
  const prevConnRef = useRef<{ conn: string | null | undefined; connected: boolean }>({ conn: activeConn, connected });
  useEffect(() => {
    const prev = prevConnRef.current;
    prevConnRef.current = { conn: activeConn, connected };
    for (const ses of sessions.current.values()) {
      if (ses.mode !== 'remote') continue;
      if (connected && (ses.state === 'idle' || ses.state === 'closed')) startSession(ses);
      if (!connected && (ses.state === 'running' || ses.state === 'starting')) {
        writeLine(ses, '\r\n' + gray('[SSH 连接断开,等待重连…重连后自动恢复终端]') + '\r\n');
        setStateOf(ses, 'closed');
      }
      if (prev.conn !== activeConn && connected) {
        writeLine(ses, '\r\n' + gray('[已切换服务器,正在重启终端…]') + '\r\n');
        restartSession(ses); // 复用既有 kill->exit->auto-start 流程,避免竞态
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConn, connected]);

  // 切回命令台 / 切换可见终端:重新适配尺寸并聚焦
  useEffect(() => {
    if (!visible) return;
    const ses = getSession(activeId);
    if (!ses) return;
    const host = hosts.current.get(activeId);
    if (host && host.clientWidth && host.clientHeight) {
      try { ses.fit.fit(); } catch {}
      sendCtrl(ses, { type: 'resize', cols: ses.term.cols || 80, rows: ses.term.rows || 24 });
    }
    setTimeout(() => ses.term.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, activeId]);

  // 快捷命令:像手敲一样写入当前可见终端
  const runQuick = (cmd: string) => {
    const ses = getSession(activeId);
    if (!ses || ses.state !== 'running') return;
    sendInput(ses, cmd + '\r');
  };

  // 右键菜单:复制 / 粘贴
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const ses = getSession(activeId);
    setMenu({
      x: Math.max(8, Math.min(e.clientX, window.innerWidth - MENU_W - 8)),
      y: Math.max(8, Math.min(e.clientY, window.innerHeight - MENU_H - 8)),
      hasSel: !!ses?.hasSel
    });
  };

  // 右键菜单(终端区 & 列表项)与移动端终端切换器:点击菜单外 / Esc 关闭
  useEffect(() => {
    if (!menu && !listMenu && !termMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menu && menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
      if (listMenu && listMenuRef.current && !listMenuRef.current.contains(e.target as Node)) setListMenu(null);
      if (termMenuOpen && termMenuRef.current && !termMenuRef.current.contains(e.target as Node)) setTermMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenu(null); setListMenu(null); setTermMenuOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu, listMenu, termMenuOpen]);

  if (!activeDesc) return null;

  const st = activeDesc.state;
  const STATE_LABEL =
    st === 'idle'
      ? (activeDesc.wsFail ? '通道连接失败,重试中…' : (activeDesc.mode === 'local' || connected) ? '正在打开…' : '等待 SSH 连接')
      : st === 'starting' ? '正在打开…'
      : st === 'running' ? '已连接'
      : (activeDesc.wsFail ? '通道连接失败,重试中…' : '已结束');

  // 列表显示名:自定义名优先;否则远程显示 SSH IP(未连接显示「离线」),本地固定「本地」
  const dispName = (d: TermDesc) => {
    if (d.name.trim() !== '') return d.name.trim();
    if (d.mode === 'remote') return connected ? (hostIp || 'SSH') : '离线';
    return '本地';
  };

  // 内联重命名:提交(输入为空 = 恢复默认名),Esc 取消
  const commitRename = () => {
    const id = editId;
    if (id == null) return;
    setEditId(null);
    renameTerminal(id, editText.trim() === '' ? '' : editText);
  };

  const dotClass = (s: TermState) => {
    if (s === 'running') return 'ok';
    if (s === 'starting') return 'busy';
    if (s === 'closed') return 'err';
    return '';
  };

  const restartActive = () => {
    const ses = getSession(activeId);
    if (ses) restartSession(ses);
  };
  const clearActive = () => {
    getSession(activeId)?.term.clear();
  };

  return (
    <div className="consolewrap">
      <div className="console-main">
        <div className="xterm-area" onContextMenu={onContextMenu} onClick={() => getSession(activeId)?.term.focus()}>
          {/* 每个终端一个绝对定位面板,隐藏时仅 visibility:hidden(保持尺寸与渲染,
              屏幕内容/滚动缓存原样保留,切换瞬间即见;带出 scenes 的会话互不干涉) */}
          {descs.map((d) => (
            <div key={d.id} className={`xterm-pane ${d.id === visibleDescId ? '' : 'off'}`}>
              <div className="xterm-host" data-tid={d.id} ref={hostRef} />
            </div>
          ))}
        </div>
        {menu && (
          <div
            className="term-menu"
            ref={menuRef}
            style={{ left: menu.x, top: menu.y }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button className="term-menu-item" disabled={!menu.hasSel} onClick={() => { copySelection(); setMenu(null); }}>
              <span>复制</span><span className="term-menu-key">Ctrl+Shift+C</span>
            </button>
            <button className="term-menu-item" disabled={st !== 'running'} onClick={() => { pasteClipboard(); setMenu(null); }}>
              <span>粘贴</span><span className="term-menu-key">Ctrl+Shift+V</span>
            </button>
          </div>
        )}
        <div className="term-bar">
          <span className={`term-state ${st === 'running' ? 'ok' : st === 'closed' ? 'err' : ''}`}>
            ● {STATE_LABEL}
          </span>
          {activeDesc.wsFail && <span className="term-state err">请重启服务端进程(新终端功能需要新版服务端)</span>}
          <div className="quick">
            {QUICK.map((q) => (
              <button key={q} className="chip-btn" disabled={st !== 'running'} onClick={() => runQuick(q)}>{q}</button>
            ))}
          </div>
          <div className="grow" />
          {/* 触屏设备:右侧终端列表在手机上隐藏,这里提供终端切换器(桌面鼠标无此控件) */}
          {coarse && (
            <div className="term-switch" ref={termMenuRef}>
              <button className="chip-btn" onClick={() => setTermMenuOpen((v) => !v)}>
                ⌨ 终端 ({descs.length}) ▾
              </button>
              {termMenuOpen && (
                <div className="term-mobile-list">
                  {descs.map((d) => (
                    <div key={d.id}
                      className={`term-mobile-item${d.id === visibleDescId ? ' active' : ''}`}
                      onClick={() => { setActiveId(d.id); setTermMenuOpen(false); }}>
                      <i className={`term-dot ${dotClass(d.state)}`} />
                      <span>{d.mode === 'remote' ? '🌐 ' : '💻 '}{dispName(d)}</span>
                    </div>
                  ))}
                  <div className="ctx-sep" />
                  <div className="term-mobile-add">
                    <button className="chip-btn" onClick={() => addTerminal('remote')}>＋远程</button>
                    <button className="chip-btn" onClick={() => addTerminal('local')}>＋本地</button>
                  </div>
                </div>
              )}
            </div>
          )}
          <button className="chip-btn" onClick={clearActive}>清屏</button>
          <button className="chip-btn" disabled={(activeDesc.mode === 'remote' && !connected) || st === 'starting'} onClick={restartActive}>
            {st === 'running' ? '重启终端' : '重新打开'}
          </button>
        </div>
      </div>

      {/* 右侧终端列表(可拖拽排序;名称即用即显:远程 = IP/离线,本地 = 本地) */}
      <aside ref={listRef} className="term-list" style={{ width: listW }}>
        <div className="term-list-resizer" data-tip="拖动调整宽度" onPointerDown={startListResize} />
        <div className="term-list-head">
          <span className="term-list-title">终端</span>
          <div className="term-list-add">
            <button className="chip-btn" onClick={() => addTerminal('remote')}>＋远程</button>
            <button className="chip-btn" onClick={() => addTerminal('local')}>＋本地</button>
          </div>
        </div>
        <div className="term-list-items">
          {descs.map((d) => {
            const isDrag = drag?.id === d.id;
            const isOver = !!drag && drag.id !== d.id && drag.over === d.id;
            const dnm = dispName(d);
            return (
              <div
                key={d.id}
                className={`term-list-item ${d.id === visibleDescId ? 'active' : ''} ${isDrag ? 'dragging' : ''} ${isOver && drag?.pos === 'before' ? 'drop-before' : ''} ${isOver && drag?.pos === 'after' ? 'drop-after' : ''}`}
                draggable
                onClick={() => { if (suppressClickRef.current) return; setActiveId(d.id); }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu(null);
                  setListMenu({
                    id: d.id,
                    x: Math.max(8, Math.min(e.clientX, window.innerWidth - MENU_W - 8)),
                    y: Math.max(8, Math.min(e.clientY, window.innerHeight - 130))
                  });
                }}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', String(d.id));
                  setDrag({ id: d.id, over: d.id, pos: 'after' });
                }}
                onDragOver={(e) => {
                  if (!drag || drag.id === d.id) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  const r = e.currentTarget.getBoundingClientRect();
                  const pos = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
                  setDrag((p) => (p && p.over === d.id && p.pos === pos ? p : { id: p ? p.id : d.id, over: d.id, pos }));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag) reorderList(drag.id, d.id, drag.pos);
                  setDrag(null);
                }}
                onDragEnd={() => {
                  if (drag) { suppressClickRef.current = true; setTimeout(() => { suppressClickRef.current = false; }, 0); }
                  setDrag(null);
                }}
              >
                <i className={`term-dot ${dotClass(d.state)}`} />
                {editId === d.id ? (
                  <input
                    className="term-edit"
                    autoFocus
                    value={editText}
                    placeholder={dnm}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditId(null); }}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="term-list-name">{d.mode === 'remote' ? '🌐 ' : '💻 '}{dnm}</span>
                )}
                <button
                  className="term-list-del action-icon danger"
                  disabled={descs.length <= 1}
                  data-tip={descs.length <= 1 ? '至少保留一个终端' : '删除此终端'}
                  onClick={(e) => { e.stopPropagation(); removeTerminal(d.id); }}
                >✕</button>
              </div>
            );
          })}
        </div>
        {listMenu && (
          <div
            className="term-menu"
            ref={listMenuRef}
            style={{ left: listMenu.x, top: listMenu.y }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button className="term-menu-item" data-tip="输入空可恢复默认名" onClick={() => {
              const d = descs.find((x) => x.id === listMenu.id);
              setEditId(listMenu.id);
              setEditText(d?.name || '');
              setListMenu(null);
            }}>
              <span>重命名</span>
            </button>
            <button className="term-menu-item" disabled={descs.length <= 1} onClick={() => {
              const id = listMenu.id;
              setListMenu(null);
              if (descs.length > 1) removeTerminal(id);
            }}>
              <span>删除终端</span>{descs.length <= 1 && <span className="term-menu-key">至少保留一个</span>}
            </button>
          </div>
        )}
        <div className="term-list-hint">拖拽排序 · 右键重命名/删除 · 远程终端跟随当前 SSH 服务器</div>
      </aside>
    </div>
  );
}

function methodLabel(mode: TermMode): string {
  if (mode === 'remote') return 'SSH 服务器交互式 shell';
  const isWin = typeof navigator !== 'undefined' ? /win/i.test(navigator.platform) : false;
  return isWin ? '本机 shell(PowerShell,无则 CMD)' : '本机 shell(bash)';
}