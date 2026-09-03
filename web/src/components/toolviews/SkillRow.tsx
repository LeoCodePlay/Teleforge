// 技能调用行(对齐 deepseek-harness ui-conversation/ContextInjectionRow 的呈现):
// 前导 = 技能图标(错误换红点),标题 = 上下文注入,2x2 分隔点 + 技能名摘要;
// 展开体为「指令卡」:标题栏 + <pre> 指令正文(后端 skill 工具的 <skill_content> 输出,
// 即注入到上下文的 skills 完整内容)。
// 进行中扫光带 / 悬停 chevron / 展开折叠由 ToolRow 基类承担,与其它工具行一致。

import React from 'react';
import type { ToolCallInfo } from '../../types';
import { ToolRow } from '../ToolRow';
import { IconSkillOutline16 } from '../icons';

function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return nl === -1 ? text : text.slice(0, nl);
}

/** 技能名是行摘要唯一来源(harness 语义:skill 工具 args 只有 name) */
function skillName(call: ToolCallInfo): string {
  const raw = call.args ?? '';
  if (!raw) return call.id ?? 'skill';
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const name = v?.name;
    if (typeof name === 'string' && name !== '') return firstLine(name);
  } catch {
    // 流式截断的 JSON 前缀:直读首行,比回查目录更稳
  }
  return firstLine(raw);
}

export function SkillRow({ call, inspect }: {
  call: ToolCallInfo;
  inspect?: () => void;
}) {
  const name = skillName(call);
  const settled = call.ok !== undefined;
  const state = !settled ? 'running' : (call.ok ? 'ok' : 'error') as 'running' | 'ok' | 'error';
  const output = settled ? String(call.result ?? '') || null : null;
  const errorSummary = state === 'error' && output !== null ? firstLine(output) : null;
  const card = output !== null ? (
    <div className="dsh-skill" data-error={state === 'error' || undefined}>
      <div className="dsh-skill-header">指令</div>
      <pre className="dsh-skill-body" data-error={state === 'error' || undefined}>{output}</pre>
    </div>
  ) : null;
  return (
    <ToolRow
      variant="others"
      toolName="skill"
      icon={<IconSkillOutline16 size={14} />}
      title="上下文注入"
      summary={name}
      body={null}
      output={null}
      errorSummary={errorSummary}
      state={state}
      card={card}
      inspect={inspect}
    />
  );
}