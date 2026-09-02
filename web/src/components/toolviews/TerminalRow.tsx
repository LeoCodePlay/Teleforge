// 终端卡视图(照搬 harness ui-tool/toolviews/bash-sample + TerminalBlock):
// run_command / run_local_command 专属展开体——StateDot 状态 + 命令提示行
// (工作目录 $ command)+ 退出码/信号胶囊 + 输出文本。
// 结构化字段来自 tool_result 的 meta(card:'terminal'),缺失时从 args/content 解析兜底。

import React from 'react';
import type { ToolCallInfo } from '../../types';
import { ToolRow } from '../ToolRow';
import { StateDot } from '../StateDot';
import { IconApiOutline14 } from '../icons';
import { toolRowModel } from '../../toolRowModel';

function parseArgs(argsRaw?: string | null): Record<string, unknown> {
  if (!argsRaw) return {};
  try { return JSON.parse(argsRaw) || {}; } catch { return {}; }
}

/** 从结果文本首行 '[退出码 N, 信号 SIGX]' 解析(meta 缺失时兜底) */
function parseExitFromContent(result?: string | null): number | string | null {
  if (!result) return null;
  const m = String(result).match(/\[退出码 ([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

export function TerminalCard({ call }: { call: ToolCallInfo }) {
  const meta = call.meta || {};
  const args = parseArgs(call.args);
  const command = String(meta.command ?? args.command ?? '');
  const cwd = String(meta.cwd ?? '');
  const running = call.ok === undefined;
  const exitCode = running ? null : (meta.exitCode ?? parseExitFromContent(call.result));
  const signal = meta.signal ?? null;
  const timedOut = !!meta.timedOut;
  const output = running ? null : String(call.result ?? '').replace(/^\[退出码[^\]]*\]\n?/, '');
  const failed = !running && (Number(exitCode) !== 0 || signal || timedOut);
  // 工作目录提示:仅取末段目录名(harness 语义:短提示即可,完整路径在命令里)
  const shortCwd = cwd ? `~/${cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''}` : '$';
  return (
    <div className="dsh-terminal" data-running={running || undefined}>
      <div className="dsh-term-header">
        <StateDot state={running ? 'ongoing' : failed ? 'error' : 'done'} />
        <span className="dsh-term-prompt">
          {shortCwd} <b>{command}</b>
        </span>
        {!running && (exitCode != null || signal || timedOut) && (
          <span className="dsh-term-pill" data-error={failed || undefined}>
            {timedOut ? '超时' : signal ? `信号 ${signal}` : `退出码 ${exitCode}`}
          </span>
        )}
      </div>
      {!running && <div className="dsh-term-output">{output || '(无输出)'}</div>}
    </div>
  );
}

export function TerminalRow({ call, onOpenFile, inspect }: {
  call: ToolCallInfo;
  onOpenFile?: (path: string) => void;
  inspect?: () => void;
}) {
  const m = toolRowModel(call);
  const args = parseArgs(call.args);
  const desc = typeof args.description === 'string' && args.description ? args.description : null;
  return (
    <ToolRow
      variant="bash"
      toolName={call.tool}
      icon={<IconApiOutline14 size={14} />}
      title={m.title}
      summary={desc ?? m.summary}
      output={m.output}
      errorSummary={m.errorSummary}
      state={m.state}
      card={<TerminalCard call={call} />}
      onOpenFile={onOpenFile}
      inspect={inspect}
    />
  );
}