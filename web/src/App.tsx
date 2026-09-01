import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { ServerStatus, Session } from './types';
import SshConnectModal from './components/SshConnectModal';
import SessionPanel from './components/SessionPanel';
import WorkspacePanel from './components/WorkspacePanel';
import ChatPanel from './components/ChatPanel';
import ConsolePanel from './components/ConsolePanel';
import FileViewer from './components/FileViewer';
import SettingsPanel from './components/SettingsPanel';
import { LlmProvider } from './llm-context';
import { useFeedback } from './feedback';

const STATUS_LABEL: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中…',
  reconnecting: '重连中…',
  disconnected: '未连接'
};

interface ViewerState {
  path: string;
  name: string;
}

// 本地面板首次浏览默认起点(浏览器拿不到真实本机家目录,用简便占位;list_local_dir 缺省 path 时服务端回退 localFs.home)
const localHome = null;

export default function App() {
  const { confirm } = useFeedback();
  const [status, setStatus] = useState<ServerStatus>({
    status: 'disconnected', host: null, port: null, username: null,
    platform: null, home: null, workspace: null, localWorkspace: null, agentBusy: false, busySessions: [], llmModel: null
  });
  const [activeTab, setActiveTab] = useState('agent');
  const [viewer, setViewer] = useState<ViewerState | null>(null); // {path, name}
  const [localCwd, setLocalCwd] = useState('');   // 本地面板当前目录
  const [remoteCwd, setRemoteCwd] = useState(''); // 远程面板当前目录
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sshOpen, setSshOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [leftWidth, setLeftWidth] = useState(320);
  const leftRef = useRef<HTMLElement>(null);

  // 左侧边栏拖拽调整宽度
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = leftRef.current?.offsetWidth || 320;
    const onMove = (ev: PointerEvent) => {
      const w = Math.min(Math.max(startW + ev.clientX - startX, 220), window.innerWidth * 0.6);
      setLeftWidth(w);
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

  // ---- 历史会话状态 ----
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionSeq, setSessionSeq] = useState(0); // 会话切换/新建后自增,触发 ChatPanel 重载

  const refreshFrom = (r: any) => {
    setSessions(r.sessions || []);
    setActiveSessionId(r.active ?? null);
  };

  // 初始化拉取会话列表;并按服务端推送的 sessions 快照刷新(新消息/清空后 msgCount 与时间变化)
  useEffect(() => {
    api.request('session_list', {}, 8000)
      .then((r) => { setSessions(r.sessions || []); setActiveSessionId(r.active || null); })
      .catch(() => {});
    const off = api.on('sessions', (m: any) => {
      setSessions(m.sessions || []);
      setActiveSessionId(m.active ?? null);
    });
    // 后台会话任务结束时也会推送 sessions_changed:静默刷新列表,不打扰当前聊天视图
    const offChanged = api.on('agent', (m: any) => {
      if (m.event !== 'sessions_changed') return;
      api.request('session_list', {}, 8000)
        .then((r) => { setSessions(r.sessions || []); setActiveSessionId(r.active ?? null); })
        .catch(() => {});
    });
    return () => { off(); offChanged(); };
  }, []);

  const refreshSessions = (r: any) => {
    setSessions(r.sessions || []);
    setActiveSessionId(r.active ?? null);
    setSessionSeq((n) => n + 1);
  };
  const newSession = () => api.request('session_create', {}, 8000).then(refreshSessions).catch(() => {});
  const switchSession = (id: string) => api.request('session_switch', { id }, 8000).then(refreshSessions).catch(() => {});
  // 在新对话中分支:克隆当前会话为新会话并切换。at 为 turns 索引时截断到该条消息
  // (用于从任意历史消息处分支),缺省 -1 从尾部整体克隆
  const forkSession = (at = -1) => api.request('session_fork', { at }, 8000).then(refreshSessions).catch(() => {});
  const renameSession = (id: string, title: string) => api.request('session_rename', { id, title }, 8000).then(refreshSessions).catch(() => {});
  const deleteSession = async (id: string) => {
    if (id === activeSessionId) return;
    const ok = await confirm({
      title: '删除会话',
      message: '删除该会话?其对话记录将被永久删除,不可恢复',
      confirmLabel: '删除',
      danger: true
    });
    if (!ok) return;
    api.request('session_delete', { id }, 8000).then(refreshSessions).catch(() => {});
  };

  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    api.connect();
    const offStatus = api.on('status', setStatus);
    return () => { offStatus(); api.close(); };
  }, []);

  const connected = status.status === 'connected';
  // 多会话并行:busySessions 是运行中的会话集合;聊天区只关心"当前活跃会话"是否在运行
  const busySessions = status.busySessions || [];
  const activeBusy = activeSessionId != null && busySessions.includes(activeSessionId);

  const handleOpenFile = (path: string) => {
    const name = path.split('/').filter(Boolean).pop() || path;
    setViewer({ path, name });
  };

  // 本地文件用 local: 前缀区分,FileViewer 内按前缀分流读取/保存
  const handleOpenLocalFile = (path: string) => {
    const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
    setViewer({ path: `local:${path}`, name });
  };

  // 选择本地工作区:通知服务端切换,并在状态里记住
  const onSetLocalWorkspace = (p: string) =>
    api.request('set_local_workspace', { path: p }, 20000)
      .then(() => setStatus((s) => ({ ...s, localWorkspace: p })))
      .catch(() => {});

  // ---- 按服务器保存的工作区历史:key = "host:port",每个服务器记住添加/打开过的工作区 ----
  const WS_KEY = 'sshai.wsByHost';
  const loadWsByHost = (): Record<string, string[]> => {
    try {
      const o = JSON.parse(localStorage.getItem(WS_KEY) || '{}');
      return o && typeof o === 'object' ? o : {};
    } catch { return {}; }
  };
  const saveWsByHost = (m: Record<string, string[]>) => localStorage.setItem(WS_KEY, JSON.stringify(m));
  const [wsByHost, setWsByHost] = useState<Record<string, string[]>>(loadWsByHost);

  const onWorkspaceSet = (ws: string) => {
    setStatus((s) => ({ ...s, workspace: ws }));
    // 记录到当前服务器的历史,方便下次连接该服务器时直接切换
    const st = statusRef.current;
    const key = st.host ? `${st.host}:${st.port || 22}` : '';
    if (!key) return;
    setWsByHost((m) => {
      const list = m[key] ? m[key].filter((x) => x !== ws) : [];
      list.unshift(ws); // 最近使用的排最前
      const next = { ...m, [key]: list };
      saveWsByHost(next);
      return next;
    });
  };

  return (
    <LlmProvider>
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <button className="ghost edge-toggle" title={leftOpen ? '收起左侧栏' : '展开左侧栏'} onClick={() => setLeftOpen((v) => !v)}>{leftOpen ? '◀' : '▶'}</button>
          <div className="brand">⟠ Teleforge</div>
        </div>
        <div className="topbar-center">
          <span className="stat">平台 {status.platform || '—'}</span>
          <span className="stat">模型 {status.llmModel || '未配置'}</span>
        </div>
        <div className="topbar-right">
          <button
            className={`conn-chip ${connected ? 'ok' : status.status === 'disconnected' ? 'off' : 'warn'}`}
            title="SSH 连接管理"
            onClick={() => setSshOpen(true)}
          >
            {connected
              ? `● 已连接 ${status.username}@${status.host}`
              : status.status === 'disconnected'
                ? '● 未连接 · 点击 SSH 连接'
                : `● ${STATUS_LABEL[status.status] || status.status}`}
          </button>
          <button className="ghost edge-toggle" title="设置" onClick={() => setSettingsOpen(true)}>⚙</button>
        </div>
      </header>

      <div className="layout">
        <aside ref={leftRef} style={{ width: leftWidth }} className={`sidebar sidebar-left ${leftOpen ? '' : 'hidden'}`}>
          <div className="resizer" title="拖动调整宽度" onPointerDown={startResize} />
          <SessionPanel
            sessions={sessions}
            activeId={activeSessionId}
            busyIds={busySessions}
            onNew={newSession}
            onSwitch={switchSession}
            onRename={renameSession}
            onDelete={deleteSession}
          />
          <WorkspacePanel
            connected={connected}
            workspace={status.workspace}
            home={status.home}
            localWorkspace={status.localWorkspace}
            localHome={localHome}
            localCwd={localCwd}
            remoteCwd={remoteCwd}
            onLocalCwdChange={setLocalCwd}
            onRemoteCwdChange={setRemoteCwd}
            onSetLocalWorkspace={onSetLocalWorkspace}
            onOpenFile={handleOpenFile}
            onOpenLocalFile={handleOpenLocalFile}
          />
        </aside>

        <main className="main">
          <div className="tabs">
            <button className={activeTab === 'agent' ? 'tab active' : 'tab'} onClick={() => setActiveTab('agent')}>
              💬 AI 编程助手
            </button>
            <button className={activeTab === 'console' ? 'tab active' : 'tab'} onClick={() => setActiveTab('console')}>
              ⌨️ 命令台
            </button>
          </div>
          <div className="tab-body">
            {activeTab === 'agent' && (
              <ChatPanel key="agent" connected={connected} workspace={status.workspace} busy={activeBusy} sid={activeSessionId} sessionSeq={sessionSeq}
              home={status.home} savedWs={wsByHost[status.host ? `${status.host}:${status.port || 22}` : ''] || []}
              onWorkspaceSet={onWorkspaceSet} onFork={forkSession} />
            )}
            {/* 终端常驻挂载:切走再切回不销毁会话,用 CSS 隐藏 */}
            <div className={`tab-pane ${activeTab === 'console' ? '' : 'hide'}`}>
              <ConsolePanel connected={connected} visible={activeTab === 'console'} />
            </div>
          </div>
        </main>
      </div>

      {viewer && <FileViewer path={viewer.path} name={viewer.name} onClose={() => setViewer(null)} />}
      {settingsOpen && <SettingsPanel connected={connected} onClose={() => setSettingsOpen(false)} />}
      {sshOpen && <SshConnectModal status={status} onClose={() => setSshOpen(false)} />}
    </div>
    </LlmProvider>
  );
}