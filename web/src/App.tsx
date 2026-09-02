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
import { LlmProvider } from './context/llm-context';
import { useFeedback } from './context/feedback';

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

// 本地面板起点:真实家目录来自服务端 status 事件(localHome = os.homedir())
export default function App() {
  const { confirm, toast } = useFeedback();
  const [status, setStatus] = useState<ServerStatus>({
    status: 'disconnected', host: null, port: null, username: null,
    platform: null, home: null, workspace: null, localWorkspace: null, localHome: null, agentBusy: false, busySessions: [], llmModel: null
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

  // 会话按服务器/本地模式隔离:活动连接(或连接状态)变化时,重新拉取当前作用域的会话列表
  const scopeKey = status.status === 'connected' && status.host
    ? `${status.username}@${status.host}:${status.port || 22}`
    : status.status === 'disconnected' ? 'local' : null;
  const prevScopeRef = useRef('local'); // 初始为本地模式,避免挂载时重复拉取
  useEffect(() => {
    if (!scopeKey || scopeKey === prevScopeRef.current) return;
    prevScopeRef.current = scopeKey;
    api.request('session_list', {}, 8000)
      .then((r) => { setSessions(r.sessions || []); setActiveSessionId(r.active || null); setSessionSeq((n) => n + 1); })
      .catch(() => {});
  }, [scopeKey]);

  // 当前作用域标签(左上角会话面板标题提示用)
  const scopeLabel = status.status === 'connected' && status.host ? `${status.username}@${status.host}` : '本地工作区';

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
  const newSession = () => api.request('session_create', {}, 8000).then(refreshSessions).catch((e) => toast.error(`新建会话失败: ${(e as Error).message}`));
  // 切换会话(点击当前会话也会重新触发 session_switch + 重载,用于加载失败/进行中时重试)
  const switchSession = (id: string) => api.request('session_switch', { id }, 8000).then(refreshSessions).catch((e) => toast.error(`切换会话失败: ${(e as Error).message}`));
  // 点击其他服务器后台运行的会话:先切回该服务器(conn_switch),再打开该会话。
  // connKey = 服务端作用域键(username@host:port 或 'local');'local' 需断开连接才可达,直接忽略
  const switchForeignSession = (id: string, connKey: string) => {
    if (connKey === scopeKey) { switchSession(id); return; }
    if (connKey === 'local') return;
    const conn = (status.conns || []).find((c) => `${c.username}@${c.host}:${c.port || 22}` === connKey && c.status === 'connected');
    if (!conn) return;
    api.request('conn_switch', { id: conn.id }, 8000)
      .then(() => api.request('session_switch', { id }, 8000))
      .then(refreshSessions)
      .catch((e) => toast.error(`切换会话失败: ${(e as Error).message}`));
  };
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
  // 多连接池:统计当前在线连接数(含活动连接),用于顶栏提示「可快速切换」
  const connCount = (status.conns || []).filter((c) => c.status === 'connected').length;
  const multiConn = connCount > 1;
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

  // ---- 本机保存的本地工作区历史(跨服务器全局,最近使用的排最前),与远程历史对称 ----
  const LOCAL_WS_KEY = 'sshai.localWorkspaces';
  const loadLocalWs = (): string[] => {
    try {
      const a = JSON.parse(localStorage.getItem(LOCAL_WS_KEY) || '[]');
      return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
    } catch { return []; }
  };
  const saveLocalWs = (list: string[]) => localStorage.setItem(LOCAL_WS_KEY, JSON.stringify(list));
  const [localWs, setLocalWs] = useState<string[]>(loadLocalWs);

  // 选择本地工作区:通知服务端切换,记录到历史,并在状态里记住
  const onSetLocalWorkspace = (p: string) =>
    api.request('set_local_workspace', { path: p }, 20000)
      .then(() => {
        setStatus((s) => ({ ...s, localWorkspace: p }));
        setLocalWs((m) => {
          const next = [p, ...(m || []).filter((x) => x !== p)];
          saveLocalWs(next);
          return next;
        });
      })
      .catch(() => {});

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

  // 从当前服务器的工作区历史中删除一条记录(仅删快捷记录,不影响远程目录)
  const onDeleteWs = (ws: string) => {
    const st = statusRef.current;
    const key = st.host ? `${st.host}:${st.port || 22}` : '';
    if (!key) return;
    setWsByHost((m) => {
      const list = (m[key] || []).filter((x) => x !== ws);
      const next = { ...m, [key]: list };
      saveWsByHost(next);
      return next;
    });
  };

  // 从本地工作区历史中删除一条记录
  const onDeleteLocalWs = (p: string) => {
    setLocalWs((m) => {
      const next = (m || []).filter((x) => x !== p);
      saveLocalWs(next);
      return next;
    });
  };

  return (
    <LlmProvider>
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <button className="ghost edge-toggle" title={leftOpen ? '收起左侧栏' : '展开左侧栏'} onClick={() => setLeftOpen((v) => !v)}>{leftOpen ? '◀' : '▶'}</button>
          <div className="brand"><img className="brand-logo" src="/logo-64.png" alt="" /> Teleforge</div>
        </div>
        <div className="topbar-right">
          <button
            className={`conn-chip ${connected ? 'ok' : status.status === 'disconnected' ? 'off' : 'warn'}`}
            title="SSH 连接管理"
            onClick={() => setSshOpen(true)}
          >
            {connected
              ? `● 已连接 ${status.username}@${status.host}${multiConn ? ` · 在线${connCount}台(点开可切换)` : ''}`
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
            scopeLabel={scopeLabel}
            scopeKey={scopeKey}
            onNew={newSession}
            onSwitch={switchSession}
            onSwitchForeign={switchForeignSession}
            onRename={renameSession}
            onDelete={deleteSession}
          />
          <WorkspacePanel
            connected={connected}
            workspace={status.workspace}
            home={status.home}
            localWorkspace={status.localWorkspace}
            localHome={status.localHome}
            localCwd={localCwd}
            remoteCwd={remoteCwd}
            onLocalCwdChange={setLocalCwd}
            onRemoteCwdChange={setRemoteCwd}
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
              <ChatPanel key="agent" connected={connected} workspace={status.workspace} localWorkspace={status.localWorkspace} busy={activeBusy} sid={activeSessionId} sessionSeq={sessionSeq}
              home={status.home} savedWs={wsByHost[status.host ? `${status.host}:${status.port || 22}` : ''] || []}
              localHome={status.localHome} savedLocalWs={localWs}
              onWorkspaceSet={onWorkspaceSet} onLocalWorkspaceSet={onSetLocalWorkspace}
              onDeleteWs={onDeleteWs} onDeleteLocalWs={onDeleteLocalWs} onFork={forkSession} />
            )}
            {/* 终端常驻挂载:切走再切回不销毁会话,用 CSS 隐藏 */}
            <div className={`tab-pane ${activeTab === 'console' ? '' : 'hide'}`}>
              <ConsolePanel connected={connected} visible={activeTab === 'console'} activeConn={status.activeConn ?? null} />
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