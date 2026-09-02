// 任务计划行(照搬 harness ui-tool/toolviews/todo-row):
// 单行摘要 '完成 X / 共 Y',展开可看 Input/Output。待办本体由 TodoPanel 呈现。

import React from 'react';
import type { ToolCallInfo } from '../../types';
import { ToolRow } from '../ToolRow';
import { IconChecklistOutline14 } from '../icons';
import { toolRowModel } from '../../toolRowModel';

function summarizeTodos(argsRaw?: string | null): { done: number; total: number } {
  if (!argsRaw) return { done: 0, total: 0 };
  try {
    const args = JSON.parse(argsRaw);
    const todos = Array.isArray(args?.todos) ? args.todos : [];
    return { done: todos.filter((t: any) => t?.status === 'completed').length, total: todos.length };
  } catch {
    return { done: 0, total: 0 };
  }
}

export function TodoRow({ call, inspect }: { call: ToolCallInfo; inspect?: () => void }) {
  const m = toolRowModel(call);
  const { done, total } = summarizeTodos(call.args);
  return (
    <ToolRow
      variant="todo"
      toolName={call.tool}
      icon={<IconChecklistOutline14 size={14} />}
      title={m.title}
      summary={total ? `完成 ${done} / 共 ${total}` : '任务计划'}
      body={m.body}
      output={m.output}
      state={m.state}
      inspect={inspect}
    />
  );
}