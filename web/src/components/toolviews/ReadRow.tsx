// 读文件卡视图(照搬 harness ui-tool/toolviews/read-row + ReadBlock):
// 路径横幅 + 等宽正文。harness 的行号 gutter/语法高亮依赖后端带行号输出,
// 当前 read_file 返回无行号片段,降级为 path label + 等宽纯文本(不引入 shiki)。

import React from 'react';
import type { ToolCallInfo } from '../../types';
import { ToolRow } from '../ToolRow';
import { IconBrowseOutline16 } from '../icons';
import { toolRowModel, relativizeToCwd } from '../../toolRowModel';

function parseArgs(argsRaw?: string | null): Record<string, unknown> {
  if (!argsRaw) return {};
  try { return JSON.parse(argsRaw) || {}; } catch { return {}; }
}

/** 从内容头部 '文件 path(共 N 字节...):\n...' 剥离路径横幅,返回 {path, body} */
function splitReadContent(result?: string | null, argsPath?: string): { path: string; body: string } {
  const text = String(result ?? '');
  const m = text.match(/^文件 ([^\n(]+)(?:\([^)]*\))?:\n?/);
  if (m) return { path: m[1], body: text.slice(m.index! + m[0].length) };
  return { path: String(argsPath ?? ''), body: text };
}

export function ReadRow({ call, workspace, onOpenFile, inspect }: {
  call: ToolCallInfo;
  workspace?: string;
  onOpenFile?: (path: string) => void;
  inspect?: () => void;
}) {
  const m = toolRowModel(call);
  const args = parseArgs(call.args);
  const { path, body } = splitReadContent(call.result, typeof args.path === 'string' ? args.path : '');
  const relPath = relativizeToCwd(path, workspace);
  const readCard = call.ok !== undefined && body !== '' ? (
    <div className="dsh-read">
      <div className="dsh-read-banner">
        <span className="dsh-read-path">{relPath}</span>
      </div>
      <div className="dsh-read-body">{body}</div>
    </div>
  ) : null;
  return (
    <ToolRow
      variant="read"
      toolName={call.tool}
      icon={<IconBrowseOutline16 size={14} />}
      title={m.title}
      summary={m.filePath ? relativizeToCwd(m.filePath, workspace) : m.summary}
      output={null}
      errorSummary={m.errorSummary}
      state={m.state}
      filePath={m.filePath}
      onOpenFile={onOpenFile}
      card={readCard}
      inspect={inspect}
    />
  );
}