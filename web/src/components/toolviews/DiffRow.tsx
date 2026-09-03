// 文件改动卡视图(照搬 harness ui-tool/toolviews/file-mutation-row + DiffBlock):
// 编辑类用 args 的 old_string/new_string 呈现 -/+ 两侧(红/绿);写入类用 path + 结果文本。
// harness 的真实 diff hunk 依赖后端结构化 diff 输出,当前降级为上述近似。

import React from 'react';
import type { ToolCallInfo } from '../../types';
import { ToolRow } from '../ToolRow/ToolRow';
import { IconEditOutline16 } from '../icons/icons';
import { toolRowModel, relativizeToCwd } from '../../utils/toolRowModel';
import './DiffRow.scss';

function parseArgs(argsRaw?: string | null): Record<string, unknown> {
  if (!argsRaw) return {};
  try { return JSON.parse(argsRaw) || {}; } catch { return {}; }
}

export function DiffRow({ call, workspace, onOpenFile, inspect }: {
  call: ToolCallInfo;
  workspace?: string;
  onOpenFile?: (path: string) => void;
  inspect?: () => void;
}) {
  const m = toolRowModel(call);
  const args = parseArgs(call.args);
  const isEdit = call.tool.startsWith('edit');
  const path = m.filePath ? relativizeToCwd(m.filePath, workspace) : '';
  const oldS = String(args.old_string ?? '');
  const newS = String(args.new_string ?? '');
  const diffCard = call.ok !== undefined && (
    isEdit && (oldS || newS)
      ? (
        <div className="dsh-diff">
          {path && <div className="dsh-diff-path">{path}</div>}
          {oldS.split('\n').map((l, i) => <div key={`d${i}`} className="dsh-diff-line del">- {l}</div>)}
          {newS.split('\n').map((l, i) => <div key={`a${i}`} className="dsh-diff-line add">+ {l}</div>)}
          {m.output && <div className="dsh-diff-result">{m.output}</div>}
        </div>
      )
      : (path && m.output)
        ? (
          <div className="dsh-diff">
            <div className="dsh-diff-path">{path}</div>
            <div className="dsh-diff-result">{m.output}</div>
          </div>
        )
        : null
  );
  return (
    <ToolRow
      variant={isEdit ? 'edit' : 'write'}
      toolName={call.tool}
      icon={<IconEditOutline16 size={14} />}
      title={m.title}
      summary={path || m.summary}
      output={isEdit ? null : m.output}
      errorSummary={m.errorSummary}
      state={m.state}
      filePath={m.filePath}
      onOpenFile={onOpenFile}
      card={diffCard}
      inspect={inspect}
    />
  );
}