import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const QUICK = ['ls -la', 'pwd', 'node -v', 'git status', 'df -h .'];
const encoder = new TextEncoder();

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

type TermState = 'idle' | 'starting' | 'running' | 'closed';

interface ConsolePanelProps {
  connected: boolean;
  visible: boolean;
}

// 真实终端:xterm.js 前端 + 服务端 /ws/term PTY shell 通道
// 文本帧(JSON)= 控制消息,二进制帧 = 终端原始数据(键盘输入上行 / 屏幕输出下行)
export default function ConsolePanel({ connected, visible }: ConsolePanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const connectedRef = useRef(connected);
  const stateRef = useRef<TermState>('idle');
  const pendingRef = useRef<string[]>([]);   // shell 就绪前缓存的键盘输入
  const restartWantedRef = useRef(false);
  const manualCloseRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsFailNotifiedRef = useRef(false); // 通道连接失败提示只写一次,避免重试刷屏
  const [termState, setTermState] = useState<TermState>('idle');
  const [wsFail, setWsFail] = useState(false); // 终端通道 WebSocket 连接失败(如服务端未重启)

  connectedRef.current = connected;

  const setState = (s: TermState) => { stateRef.current = s; setTermState(s); };

  // 发送控制消息(JSON 文本帧)
  const sendCtrl = (o: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(o)); } catch {} }
  };

  // 发送键盘输入(二进制帧)
  const sendInput = (data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) { try { ws.send(encoder.encode(data)); } catch {} }
  };

  // 打开新 shell 会话
  const start = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return;
    if (stateRef.current === 'running' || stateRef.current === 'starting') return;
    setState('starting');
    pendingRef.current = [];
    sendCtrl({ type: 'start', cols: termRef.current?.cols || 80, rows: termRef.current?.rows || 24 });
  };

  // 重启:先 kill 旧 shell,收到 exit 后自动开新的
  const restart = () => {
    if (stateRef.current === 'running' || stateRef.current === 'starting') {
      restartWantedRef.current = true;
      sendCtrl({ type: 'kill' });
    } else {
      start();
    }
  };

  // ---- 挂载:创建终端 + 终端专用 WebSocket ----
  useEffect(() => {
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
    if (hostRef.current) term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;
    term.write(gray('SSH 交互式终端\r\n'));
    term.write(gray('等待 SSH 连接后自动打开…\r\n'));

    // 键盘输入 -> 上行;shell 未就绪时先缓存
    term.onData((data) => {
      if (stateRef.current === 'running') sendInput(data);
      else if (stateRef.current === 'starting') pendingRef.current.push(data);
    });

    // 容器尺寸变化 -> fit -> 通知远端 PTY 改窗口
    const doFit = () => {
      const host = hostRef.current;
      if (!host || !host.clientWidth || !host.clientHeight) return; // 隐藏时跳过
      const before = `${term.cols}x${term.rows}`;
      try { fit.fit(); } catch {}
      if (`${term.cols}x${term.rows}` !== before) sendCtrl({ type: 'resize', cols: term.cols, rows: term.rows });
    };
    const ro = new ResizeObserver(() => doFit());
    if (hostRef.current) ro.observe(hostRef.current);

    // 终端专用 WebSocket(独立于主 api 连接);连接失败自动重试
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const onTermMessage = (e: MessageEvent) => {
      if (typeof e.data === 'string') {
        let m: any;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'ready') {
          setState('running');
          const p = pendingRef.current; pendingRef.current = [];
          for (const d of p) sendInput(d);
          if (visible) term.focus();
        } else if (m.type === 'exit') {
          const wasRunning = stateRef.current === 'running' || stateRef.current === 'starting';
          setState('closed');
          if (restartWantedRef.current) {
            restartWantedRef.current = false;
            setTimeout(() => start(), 150);
          } else if (wasRunning) {
            term.write('\r\n' + gray('[终端会话已结束] 点击下方"重新打开"启动新终端') + '\r\n');
          }
        } else if (m.type === 'error') {
          setState('closed');
          term.write('\r\n' + red(`[错误] ${m.error}`) + '\r\n');
        }
      } else {
        term.write(new Uint8Array(e.data)); // shell 输出直接进终端
      }
    };

    const connectTermWs = () => {
      if (manualCloseRef.current) return;
      const ws = new WebSocket(`${proto}://${location.host}/ws/term`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        setWsFail(false);
        wsFailNotifiedRef.current = false;
        if (connectedRef.current && (stateRef.current === 'idle' || stateRef.current === 'closed')) start();
      };
      ws.onmessage = onTermMessage;
      ws.onclose = () => {
        if (manualCloseRef.current) return;
        setWsFail(true);
        if (stateRef.current === 'running' || stateRef.current === 'starting') setState('closed');
        // 只提示一次,避免重试循环刷屏
        if (!wsFailNotifiedRef.current) {
          wsFailNotifiedRef.current = true;
          term.write('\r\n' + red('[终端通道连接失败:服务端可能未更新到新版本,请重启服务端进程;正在自动重试…]') + '\r\n');
        }
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connectTermWs();
        }, 2000);
      };
      ws.onerror = () => {};
    };
    connectTermWs();

    return () => {
      manualCloseRef.current = true;
      ro.disconnect();
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
      try { term.dispose(); } catch {}
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // SSH 连接状态变化:上线后自动开终端(重连场景)
  useEffect(() => {
    if (connected && (termState === 'idle' || termState === 'closed')) start();
    if (!connected && termState === 'running') {
      termRef.current?.write('\r\n' + gray('[SSH 连接断开,等待重连…重连后自动恢复终端]') + '\r\n');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, termState]);

  // tab 切换回来:重新适配尺寸并聚焦
  useEffect(() => {
    if (visible) {
      const host = hostRef.current;
      if (host && host.clientWidth && host.clientHeight) {
        try { fitRef.current?.fit(); } catch {}
        sendCtrl({ type: 'resize', cols: termRef.current?.cols || 80, rows: termRef.current?.rows || 24 });
      }
      setTimeout(() => termRef.current?.focus(), 0);
    }
  }, [visible]);

  // 快捷命令:像手敲一样写入终端
  const runQuick = (cmd: string) => {
    if (stateRef.current !== 'running') return;
    sendInput(cmd + '\r');
  };

  // 右键粘贴(CMD / Windows Terminal 习惯)
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (stateRef.current !== 'running') return;
    navigator.clipboard?.readText?.().then((t) => { if (t) sendInput(t); }).catch(() => {});
  };

  const STATE_LABEL: Record<TermState, string> = {
    idle: wsFail ? '通道连接失败,重试中…' : connected ? '正在打开…' : '等待 SSH 连接',
    starting: '正在打开…',
    running: '已连接',
    closed: wsFail ? '通道连接失败,重试中…' : '已结束'
  };

  return (
    <div className="consolewrap">
      <div className="xterm-host" ref={hostRef} onContextMenu={onContextMenu} onClick={() => termRef.current?.focus()} />
      <div className="term-bar">
        <span className={`term-state ${termState === 'running' ? 'ok' : termState === 'closed' ? 'err' : ''}`}>
          ● {STATE_LABEL[termState]}
        </span>
        {wsFail && <span className="term-state err">请重启服务端进程(新终端功能需要新版服务端)</span>}
        <div className="quick">
          {QUICK.map((q) => (
            <button key={q} className="chip-btn" disabled={termState !== 'running'} onClick={() => runQuick(q)}>{q}</button>
          ))}
        </div>
        <div className="grow" />
        <button className="chip-btn" onClick={() => termRef.current?.clear()}>清屏</button>
        <button className="chip-btn" disabled={!connected || termState === 'starting'} onClick={restart}>
          {termState === 'running' ? '重启终端' : '重新打开'}
        </button>
      </div>
    </div>
  );
}