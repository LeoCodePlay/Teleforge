// 子代理工具行(subagent 工具专属视图):
// 与其它工具卡同构(ToolRow),额外在折叠态行尾给一个「查看会话」入口 ——
// 点开右侧子代理面板,回看这次派发的完整对话(父会话只留一条结论,过程在这里看)。
// runId 由后端 tool/result 的 meta.subagent 带回来;运行中还没有 runId,从面板列表进入。

import React from 'react';
import type { ToolCallInfo } from '../../types';
import { ToolRow } from '../ToolRow/ToolRow';
import { IconSparkle16 } from '../icons/icons';
import { toolRowModel } from '../../utils/toolRowModel';

export function SubagentRow({ call, onOpenSubagent }: {
  call: ToolCallInfo;
  onOpenSubagent?: (runId: string) => void;
}) {
  const m = toolRowModel(call);
  const runId = call.meta?.subagent?.runId;
  const openable = !!runId && !!onOpenSubagent;
  return (
    <ToolRow
      variant={m.variant}
      toolName={call.tool}
      icon={<IconSparkle16 size={14} />}
      title={m.title}
      summary={m.summary}
      body={m.body}
      output={m.output}
      errorSummary={m.errorSummary}
      state={m.state}
      trailingAction={openable ? { label: '查看会话', onClick: () => onOpenSubagent!(runId!) } : undefined}
    />
  );
}
