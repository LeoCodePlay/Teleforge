import React from 'react';
import FileManager from './FileManager';

interface WorkspacePanelProps {
  connected: boolean;
  workspace: string | null;
  home: string | null;
  onOpenFile: (path: string) => void;
}

// 左侧面板:只保留文件管理器(工作区切换/添加已移至对话输入框下方的工作区栏)
export default function WorkspacePanel({ connected, workspace, home, onOpenFile }: WorkspacePanelProps) {
  return (
    <div className="panel">
      <div className="panel-title">远程文件</div>
      {!connected ? (
        <div className="muted">连接服务器后即可浏览远程目录</div>
      ) : (
        <>
          <FileManager workspace={workspace} home={home} onOpenFile={onOpenFile} />
        </>
      )}
    </div>
  );
}