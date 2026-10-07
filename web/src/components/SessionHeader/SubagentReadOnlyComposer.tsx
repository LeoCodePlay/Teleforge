// 只读输入位 —— 逐行照搬 deepseek-harness 的 SubagentReadOnlyComposer。
//
// 为什么需要它:dsh 在「一次性子智能体」或「父会话不在线」时,会用这一块**顶掉**正常输入框,
// 明确告诉用户"这里不能继续发消息",而不是给一个禁用的输入框让人猜。本项目的子智能体全部是
// 一次性派发,所以这里恒为 one-shot 文案;保留 reason 参数以便将来接可续聊子会话。

import React from 'react';
import { tSub } from './locales';
import css from './SubagentReadOnlyComposer.module.css';

/** 为什么这一段对话不接受人类输入。 */
export type SubagentReadOnlyReason = 'one-shot' | 'parent-unavailable' | 'unknown';

export function SubagentReadOnlyComposer({ reason }: { reason: SubagentReadOnlyReason }) {
  const oneShot = reason === 'one-shot';
  return (
    <div className={css.frame} role="status" data-subagent-readonly="">
      <strong>{tSub(oneShot ? 'readonly.oneShot.title' : 'readonly.title')}</strong>
      <span>
        {tSub(reason === 'unknown' ? 'readonly.unknown.body' : oneShot ? 'readonly.oneShot.body' : 'readonly.body')}
      </span>
    </div>
  );
}
