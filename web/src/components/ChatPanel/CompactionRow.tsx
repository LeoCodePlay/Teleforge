// 压缩标记行(照搬 deepseek-harness ui-conversation/chat/CompactionItem):
// 对话流中一次上下文压缩贡献的标记行——默认折叠的「手动压缩/上下文压缩」行,
// 折叠态=API 图标 + 标题 + 2x2 分隔点 + 单行摘要(已压缩 N 条早期消息);
// 展开态=缩进 22px 的灰色 pre-wrap 摘要正文。它报告模型从该处起不再看到
// 被压缩的历史(其上的对话保持原样),摘要本身是写给模型的,标记行只作披露。

import React from 'react';
import { DisclosureRow, useDisclosure } from '../DisclosureRow/DisclosureRow';
import { IconApiOutline14 } from '../icons/icons';
import './CompactionRow.scss';

interface CompactionRowProps {
  /** 压缩摘要完整文本(服务端 compaction/done 事件投影而来) */
  content: string;
  /** 被压缩的消息条数(缺省 0 视为未知) */
  dropCount?: number;
  /** 是否手动压缩(/compact 命令);false=运行中自动压缩 */
  manual?: boolean;
}

export function CompactionRow({ content, dropCount = 0, manual = false }: CompactionRowProps) {
  const { open, toggle } = useDisclosure(false);
  const title = manual ? '手动压缩' : '上下文压缩';
  const brief = dropCount > 0
    ? `已压缩 ${dropCount} 条早期消息 · 点击查看压缩摘要`
    : '早期对话已压缩为摘要 · 点击查看';
  return (
    <div className="dsh-compaction" data-state={open ? 'open' : 'collapsed'}>
      <DisclosureRow
        icon={<IconApiOutline14 size={14} />}
        title={title}
        open={open}
        expandable
        expandOnRowClick
        onToggle={toggle}
        collapsedContent={(
          <>
            <span className="dsh-sep" aria-hidden />
            <span className="dsh-summary">{brief}</span>
          </>
        )}
      >
        <div className="dsh-compaction-body">{content}</div>
      </DisclosureRow>
    </div>
  );
}