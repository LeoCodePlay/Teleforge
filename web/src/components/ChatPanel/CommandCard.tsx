// 命令卡片(照搬 deepseek-harness ui-conversation/chat/GenericCommandCard):
// 斜杠命令在对话流中的呈现——运行中=API 图标 + 标题 + 分隔点 + 「正在运行」摘要;
// 完成/失败=标题 + 结果文本(失败红色)。多行结果可展开查看正文。
import React from 'react';
import { DisclosureRow, useDisclosure } from '../DisclosureRow/DisclosureRow';
import { IconApiOutline14 } from '../icons/icons';
import { StateDot } from '../StateDot/StateDot';
import './CommandCard.scss';

export interface CommandCardProps {
  /** 命令名(不含斜杠),如 'compact' */
  name: string;
  /** 运行状态:running=进行中;ok=成功;error=失败 */
  state: 'running' | 'ok' | 'error';
  /** 折叠态摘要文本(运行中=进行中文案;完成=结果文本;失败=错误原因) */
  text?: string;
}

export function CommandCard({ name, state, text }: CommandCardProps) {
  const { open, toggle } = useDisclosure(false);
  const title = `/${name}`;
  const summary = text
    ?? (state === 'running' ? '正在运行…' : state === 'error' ? '命令执行失败' : '命令已完成');
  const body = text && text.includes('\n') ? text : null;
  return (
    <div className="dsh-command" data-state={state}>
      <DisclosureRow
        icon={state === 'error' ? <StateDot state="error" size={14} /> : <IconApiOutline14 size={14} />}
        title={title}
        open={open}
        expandable={body !== null}
        expandOnRowClick
        onToggle={toggle}
        collapsedContent={(
          <>
            <span className="dsh-sep" aria-hidden />
            <span className="dsh-summary" data-error={state === 'error' || undefined}>{summary}</span>
          </>
        )}
      >
        {body !== null && <pre className="dsh-command-body" data-error={state === 'error' || undefined}>{body}</pre>}
      </DisclosureRow>
    </div>
  );
}
