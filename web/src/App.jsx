import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import ConnectPanel from './components/ConnectPanel.jsx';
import WorkspacePanel from './components/WorkspacePanel.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import ConsolePanel from './components/ConsolePanel.jsx';
import FileViewer from './components/FileViewer.jsx';

const STATUS_LABEL = {
  connected: '已连接',
  connecting: '连接中…',
  reconnecting: '重连中…',
  disconnected: '未连接'
};

export default function App() {
  const [status, setStatus] = useState({
    status: 'disconnected', host: null, port: null, username: null,
    platform: null, home: null, workspace: null, agentBusy: false, llmModel: null
  });
  const [activeTab, setActiveTab] = useState('agent');
  const [viewer, setViewer] = useState(null); // {path, name}

  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    api.connect();
    const offStatus = api.on('status', setStatus);
    return () => { offStatus(); api.close(); };
  }, []);

  const connected = status.status === 'connected';
  const busy = status.agentBusy;

  const handleOpenFile = (path) => {
    const name = path.split('/').filter(Boolean).pop() || path;
    setViewer({ path, name });
  };

  const onWorkspaceSet = (ws) => setStatus((s) => ({ ...s, workspace: ws }));

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">⟠ SSH AI 编程工具</div>
        <div className="topbar-center">
          <span className="stat">平台 {status.platform || '—'}</span>
          <span className="stat">模型 {status.llmModel || '未配置'}</span>
        </div>
        <div className="topbar-right">
          {status.workspace && <span className="ws-path chip" title={status.workspace}>📂 {status.workspace}</span>}
          <span className={`conn chip ${connected ? 'ok' : status.status === 'disconnected' ? '' : 'warn'}`}>
            ● {STATUS_LABEL[status.status] || status.status}
          </span>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <ConnectPanel status={status} />
          <WorkspacePanel
            connected={connected}
            workspace={status.workspace}
            home={status.home}
            platform={status.platform}
            onWorkspaceSet={onWorkspaceSet}
            onOpenFile={handleOpenFile}
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
            {activeTab === 'agent'
              ? <ChatPanel key="agent" connected={connected} workspace={status.workspace} busy={busy} />
              : <ConsolePanel key="console" connected={connected} />}
          </div>
        </main>
      </div>

      {viewer && <FileViewer path={viewer.path} name={viewer.name} onClose={() => setViewer(null)} />}
    </div>
  );
}