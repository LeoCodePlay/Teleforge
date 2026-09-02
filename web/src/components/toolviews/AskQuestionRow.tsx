// 提问行(照搬 harness ui-tool/toolviews/ask-question-row):
// 交互结局单行摘要——运行中'等待回答';已答'已回答 N 项';失败/取消按错误呈现。
// 问题本体由 AskPanel(composer takeover)渲染。

import React from 'react';
import type { ToolCallInfo } from '../../types';
import { ToolRow } from '../ToolRow';
import { IconQuestionOutline14 } from '../icons';
import { toolRowModel } from '../../utils/toolRowModel';

function askSummary(call: ToolCallInfo): { summary: string; state: 'running' | 'ok' | 'error' } {
  if (call.ok === undefined) return { summary: '等待回答', state: 'running' };
  if (!call.ok) return { summary: '提问未完成', state: 'error' };
  let n = 0;
  try {
    const parsed = JSON.parse(String(call.result ?? '[]'));
    if (Array.isArray(parsed)) n = parsed.length;
    else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.answers)) n = parsed.answers.length;
  } catch {
    const m = String(call.result ?? '').match(/已回答\s*(\d+)/);
    if (m) n = Number(m[1]);
  }
  return { summary: `已回答 ${n} 项`, state: 'ok' };
}

export function AskQuestionRow({ call, inspect }: { call: ToolCallInfo; inspect?: () => void }) {
  const m = toolRowModel(call);
  const { summary, state } = askSummary(call);
  return (
    <ToolRow
      variant="ask"
      toolName={call.tool}
      icon={<IconQuestionOutline14 size={14} />}
      title={m.title}
      summary={summary}
      body={m.body}
      output={m.output}
      state={state === 'error' ? m.state : m.state === 'running' ? 'running' : state}
      errorSummary={m.errorSummary}
      inspect={inspect}
    />
  );
}