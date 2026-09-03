import React, { useState } from 'react';
import FileManager from './FileManager';
import LocalFileManager from './LocalFileManager';

interface WorkspacePanelProps {
  connected: boolean;
  workspace: string | null;
  home: string | null;
  connId: string | null; // 当前活动连接 id,切换服务器时驱动远程文件面板刷新
  localWorkspace: string | null;
  localHome: string | null;
  localCwd: string;
  remoteCwd: string;
  onLocalCwdChange: (p: string) => void;
  onRemoteCwdChange: (p: string) => void;
  onOpenFile: (path: string) => void;
  onOpenLocalFile: (path: string) => void;
}

// 左侧面板:本地/远程文件 Tab;选择本地工作区入口在右下角工作区栏
// 两个文件管理器保持挂载,切 Tab 仅用 CSS 隐藏:切走再切回不销毁组件,
// 当前目录/列表/选中状态全部保留,避免重新加载并跳回工作区目录
export default function WorkspacePanel(props: WorkspacePanelProps) {
  const [tab, setTab] = useState<'local' | 'remote'>('remote');
  return (
    <div className="panel">
      <div className="panel-title row">
        <button className={`fm-tab ${tab === 'remote' ? 'on' : ''}`} onClick={() => setTab('remote')}>远程文件</button>
        <button className={`fm-tab ${tab === 'local' ? 'on' : ''}`} onClick={() => setTab('local')}>本地文件</button>
        <span className="grow" />
      </div>
      <div className={`fm-pane ${tab === 'remote' ? '' : 'hide'}`}>
        {!props.connected ? <div className="muted">连接服务器后即可浏览远程目录</div>
          : <FileManager workspace={props.workspace} home={props.home} connId={props.connId} localCwd={props.localCwd} onCwdChange={props.onRemoteCwdChange} onOpenFile={props.onOpenFile} />}
      </div>
      <div className={`fm-pane ${tab === 'local' ? '' : 'hide'}`}>
        {/* 本地文件:未选工作区时默认显示本地家目录(C盘默认文件夹),选择工作区后切到工作区目录 */}
        <LocalFileManager workspace={props.localWorkspace} home={props.localHome} remoteCwd={props.remoteCwd} onCwdChange={props.onLocalCwdChange} onOpenLocalFile={props.onOpenLocalFile} />
      </div>
    </div>
  );
}