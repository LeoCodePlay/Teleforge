import React, { useState } from 'react';
import FileManager from './FileManager';
import LocalFileManager from './LocalFileManager';
import LocalDirBrowser from './LocalDirBrowser';

interface WorkspacePanelProps {
  connected: boolean;
  workspace: string | null;
  home: string | null;
  localWorkspace: string | null;
  localHome: string | null;
  localCwd: string;
  remoteCwd: string;
  onLocalCwdChange: (p: string) => void;
  onRemoteCwdChange: (p: string) => void;
  onSetLocalWorkspace: (p: string) => void;
  onOpenFile: (path: string) => void;
  onOpenLocalFile: (path: string) => void;
}

// 左侧面板:本地/远程文件 Tab;选择本地工作区改动本地面板
export default function WorkspacePanel(props: WorkspacePanelProps) {
  const [tab, setTab] = useState<'local' | 'remote'>('remote');
  const [pickLocal, setPickLocal] = useState(false);
  return (
    <div className="panel">
      <div className="panel-title row">
        <button className={`fm-tab ${tab === 'remote' ? 'on' : ''}`} onClick={() => setTab('remote')}>远程文件</button>
        <button className={`fm-tab ${tab === 'local' ? 'on' : ''}`} onClick={() => setTab('local')}>本地文件</button>
        <span className="grow" />
        {tab === 'local' && <button className="ghost sm" onClick={() => setPickLocal(true)}>选择本地工作区</button>}
      </div>
      {tab === 'remote' ? (
        !props.connected ? <div className="muted">连接服务器后即可浏览远程目录</div>
        : <FileManager workspace={props.workspace} home={props.home} localCwd={props.localCwd} onCwdChange={props.onRemoteCwdChange} onOpenFile={props.onOpenFile} />
      ) : (
        !props.localWorkspace ? (
          <div className="muted">尚未选择本地工作区。<button className="link" onClick={() => setPickLocal(true)}>现在选择</button></div>
        ) : (
          <LocalFileManager workspace={props.localWorkspace} home={props.localHome} remoteCwd={props.remoteCwd} onCwdChange={props.onLocalCwdChange} onOpenLocalFile={props.onOpenLocalFile} />
        )
      )}
      {pickLocal && <LocalDirBrowser home={props.localHome} onClose={() => setPickLocal(false)} onPick={(p) => { props.onSetLocalWorkspace(p); setPickLocal(false); }} />}
    </div>
  );
}