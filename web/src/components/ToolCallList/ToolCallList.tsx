// 工具调用列表(照搬 harness ui-tool/ToolCallTree 的原子分发语义):
// 每条工具调用 = 一行 ToolRow(替代原 ToolRun 的"组头+卡片"两级结构),
// 按 toolName 分发到专属视图,未注册兜底 GenericToolCard。当前工具扁平无嵌套子调用。

import React, { memo } from 'react';
import type { ToolCallInfo } from '../../types';
import type { LightboxSrc } from '../Attachments/Attachments';
import { MessageAttachments } from '../Attachments/Attachments';
import { TerminalRow } from '../toolviews/TerminalRow';
import { ReadRow } from '../toolviews/ReadRow';
import { SearchRow } from '../toolviews/SearchRow';
import { DiffRow } from '../toolviews/DiffRow';
import { TodoRow } from '../toolviews/TodoRow';
import { AskQuestionRow } from '../toolviews/AskQuestionRow';
import { WebSearchRow } from '../toolviews/WebSearchRow';
import { SkillRow } from '../toolviews/SkillRow';
import { GenericToolCard } from '../toolviews/GenericToolCard';
import { BrowserRow } from '../toolviews/BrowserRow';
import { SubagentRow } from '../toolviews/SubagentRow';
import { PresentRow } from '../toolviews/PresentRow';
import './ToolCallList.scss';

interface ToolCallListProps {
  tools: ToolCallInfo[];
  workspace?: string;
  onOpenFile?: (path: string) => void;
  /** 打开子智能体会话,回看这次派发的完整对话(runId 来自 tool/result 的 meta) */
  onOpenSubagent?: (runId: string) => void;
  /** 打开灯箱查看工具产出的图片(截图类工具);不传则图片只内联展示、不可放大 */
  onOpenImage?: (src: LightboxSrc) => void;
}

// memo:按 tools 数组引用判定。ChatPanel 的 tool_call/tool_result 事件走不可变更新,
// 只有工具组真实变化时本列表才重渲染;流式文本/输入变化不再牵动全部历史的工具卡。
export const ToolCallList = memo(function ToolCallList({ tools, workspace, onOpenFile, onOpenSubagent, onOpenImage }: ToolCallListProps) {
  if (!tools || tools.length === 0) return null;
  return (
    <div className="dsh-tooltree">
      {tools.map((call, i) => (
        <ToolCallBranch key={call.id ?? i} call={call} workspace={workspace} onOpenFile={onOpenFile} onOpenSubagent={onOpenSubagent} onOpenImage={onOpenImage} />
      ))}
    </div>
  );
});

function ToolCallBranch({ call, workspace, onOpenFile, onOpenSubagent, onOpenImage }: { call: ToolCallInfo; workspace?: string; onOpenFile?: (path: string) => void; onOpenSubagent?: (runId: string) => void; onOpenImage?: (src: LightboxSrc) => void }) {
  const name = call.tool || '';
  const inspect = undefined; // 轨迹跳转当前项目无对应面板,预留
  let view: React.ReactNode;
  if (name === 'run_command' || name === 'run_local_command') {
    view = <TerminalRow call={call} onOpenFile={onOpenFile} inspect={inspect} />;
  } else if (name === 'read_file' || name === 'read_local_file') {
    view = <ReadRow call={call} workspace={workspace} onOpenFile={onOpenFile} inspect={inspect} />;
  } else if (name === 'search_code' || name === 'search_local_code' || name === 'glob' || name === 'grep' || name === 'glob_local' || name === 'grep_local') {
    // glob/grep 同样走搜索卡片:grep 侧输出就是 'path:line:content',glob 侧只有文件
    // 路径(无 ':行号:'),卡片自然退化成路径清单 + 原文输出
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
  } else if (name === 'subagent') {
    // 子智能体:父会话只留一条结论,行尾给「查看会话」进子会话看过程
    view = <SubagentRow call={call} onOpenSubagent={onOpenSubagent} />;
  } else if (name === 'present') {
    // 交付成果物:专属行(文件名 + 说明),而不是把参数 JSON 摊给用户看
    view = <PresentRow call={call} inspect={inspect} />;
  } else if (name.startsWith('browser_') || name.startsWith('computer_')) {
    // 电脑操控工具复用浏览器卡片:同样用 meta.screenshot 展示截图(computer_screenshot 会带上)
    view = <BrowserRow call={call} inspect={inspect} />;
  } else {
    view = <GenericToolCard call={call} onOpenFile={onOpenFile} inspect={inspect} />;
  }
  return (
    <div className="dsh-callRow" data-chat-call-id={call.id}>
      {view}
      {/* 工具产出的图片(截图类)在卡片下方直接展示:与消息附件同一套渲染与灯箱,
          用户不必展开折叠的工具卡才看得到。历史回放与实时事件走同一条数据路径。 */}
      {!!call.attachments?.length && (
        <div className="dsh-callAtts">
          <MessageAttachments items={call.attachments} onOpen={(src) => onOpenImage?.(src)} />
        </div>
      )}
    </div>
  );
}