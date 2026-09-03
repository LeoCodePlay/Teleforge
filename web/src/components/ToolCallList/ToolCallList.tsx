// 工具调用列表(照搬 harness ui-tool/ToolCallTree 的原子分发语义):
// 每条工具调用 = 一行 ToolRow(替代原 ToolRun 的"组头+卡片"两级结构),
// 按 toolName 分发到专属视图,未注册兜底 GenericToolCard。当前工具扁平无嵌套子调用。

import React from 'react';
import type { ToolCallInfo } from '../../types';
import { TerminalRow } from '../toolviews/TerminalRow';
import { ReadRow } from '../toolviews/ReadRow';
import { SearchRow } from '../toolviews/SearchRow';
import { DiffRow } from '../toolviews/DiffRow';
import { TodoRow } from '../toolviews/TodoRow';
import { AskQuestionRow } from '../toolviews/AskQuestionRow';
import { WebSearchRow } from '../toolviews/WebSearchRow';
import { SkillRow } from '../toolviews/SkillRow';
import { GenericToolCard } from '../toolviews/GenericToolCard';
import './ToolCallList.scss';

interface ToolCallListProps {
  tools: ToolCallInfo[];
  workspace?: string;
  onOpenFile?: (path: string) => void;
}

export function ToolCallList({ tools, workspace, onOpenFile }: ToolCallListProps) {
  if (!tools || tools.length === 0) return null;
  return (
    <div className="dsh-tooltree">
      {tools.map((call, i) => (
        <ToolCallBranch key={call.id ?? i} call={call} workspace={workspace} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}

function ToolCallBranch({ call, workspace, onOpenFile }: { call: ToolCallInfo; workspace?: string; onOpenFile?: (path: string) => void }) {
  const name = call.tool || '';
  const inspect = undefined; // 轨迹跳转当前项目无对应面板,预留
  let view: React.ReactNode;
  if (name === 'run_command' || name === 'run_local_command') {
    view = <TerminalRow call={call} onOpenFile={onOpenFile} inspect={inspect} />;
  } else if (name === 'read_file' || name === 'read_local_file') {
    view = <ReadRow call={call} workspace={workspace} onOpenFile={onOpenFile} inspect={inspect} />;
  } else if (name === 'search_code' || name === 'search_local_code') {
    view = <SearchRow call={call} workspace={workspace} inspect={inspect} />;
  } else if (name === 'write_file' || name === 'write_local_file' || name === 'edit_file' || name === 'edit_local_file') {
    view = <DiffRow call={call} workspace={workspace} onOpenFile={onOpenFile} inspect={inspect} />;
  } else if (name === 'todo_write') {
    view = <TodoRow call={call} inspect={inspect} />;
  } else if (name === 'ask_user_question') {
    view = <AskQuestionRow call={call} inspect={inspect} />;
  } else if (name === 'web_search') {
    view = <WebSearchRow call={call} inspect={inspect} />;
  } else if (name === 'skill') {
    view = <SkillRow call={call} inspect={inspect} />;
  } else {
    view = <GenericToolCard call={call} onOpenFile={onOpenFile} inspect={inspect} />;
  }
  return (
    <div className="dsh-callRow" data-chat-call-id={call.id}>
      {view}
    </div>
  );
}