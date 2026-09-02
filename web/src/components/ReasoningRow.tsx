// 思考折叠行(照搬 deepseek-harness ui-conversation/chat/ReasoningRow):
// 默认折叠的 "思考" 行——折叠态=Think 图标 + 标题 + 2x2 分隔点 + 单行省略摘要;
// 流式(running)时摘要取最后一行且跟随末尾;展开态=缩进 22px 的灰色 pre-wrap 正文;
// running 态叠加 2.6s 循环扫光带。

import React from 'react';
import { DisclosureRow, useDisclosure } from './DisclosureRow';
import { IconThinkOutline14 } from './icons';

function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return nl === -1 ? text : text.slice(0, nl);
}

function latestLine(text: string): string {
  const visible = text.trimEnd();
  const nl = visible.lastIndexOf('\n');
  return nl === -1 ? visible : visible.slice(nl + 1);
}

export function ReasoningRow({ text, running = false }: { text: string; running?: boolean }) {
  const { open, toggle } = useDisclosure(false);
  const summary = running ? latestLine(text) : firstLine(text);
  return (
    <div className="dsh-thinking" data-state={running ? 'running' : 'ok'}>
      {running && <span className="dsh-visuallyHidden">思考中</span>}
      <DisclosureRow
        icon={<IconThinkOutline14 size={14} />}
        title="思考"
        open={open}
        expandable
        expandOnRowClick
        onToggle={toggle}
        collapsedContent={summary !== '' && (
          <>
            <span className="dsh-sep" aria-hidden />
            <span className="dsh-summary" data-follow-end={running || undefined}>{summary}</span>
          </>
        )}
      >
        <div className="dsh-thinking-body">{text}</div>
      </DisclosureRow>
    </div>
  );
}