// 压缩标记行(照搬 deepseek-harness ui-conversation/chat/CompactionItem):
// 对话流中一次上下文压缩贡献的标记行——默认折叠的「手动压缩/上下文压缩」行,
// 折叠态=API 图标 + 标题 + 2x2 分隔点 + 单行摘要(已压缩 N 条早期消息);
// 展开态=缩进 22px 的灰色 pre-wrap 摘要正文。它报告模型从该处起不再看到
// 被压缩的历史(其上的对话保持原样),摘要本身是写给模型的,标记行只作披露。

import React from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { DisclosureRow, useDisclosure } from '../DisclosureRow/DisclosureRow';
import { IconApiOutline14 } from '../icons/icons';
import './CompactionRow.scss';

// 摘要正文是结构化 checkpoint(Markdown,参照 harness COMPACTION_INSTRUCTION 的 8 段结构),
// 展开态用与助手回复同款的安全 Markdown 渲染(harness 的 CompactionItem 也用 MarkdownText)。
const mdParser = new Marked({ gfm: true, breaks: true });
function renderMarkdown(text = '') {
  if (!text || !text.trim()) return '';
  const html = mdParser.parse(text) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

interface CompactionRowProps {
  /** 压缩摘要完整文本(服务端 compaction/done 事件投影而来) */
  content: string;
  /** 被压缩的消息条数(缺省 0 视为未知) */
  dropCount?: number;
  /** 是否手动压缩(/compact 命令);false=运行中自动压缩 */
  manual?: boolean;
  /** 自动压缩进行中(服务端 compaction_start 投影):本行显示运行态,完成时由
   *  compaction_done 原地改写为完成态,不再另插一行 */
  running?: boolean;
  /** 压缩未完成(服务端 compaction_failed 投影):摘要不可用,历史已保持完整、未做任何裁剪。
   *  与 running 的区别是「已结束且没有换来摘要」——必须如实披露,不能让用户以为压缩成功。 */
  failed?: boolean;
  /** failed 时的原因(摘要请求失败 / 压缩无收益 / 摘要为空 / mock 模式 …) */
  reason?: string;
}

export function CompactionRow({ content, dropCount = 0, manual = false, running = false, failed = false, reason }: CompactionRowProps) {
  const { open, toggle } = useDisclosure(false);
  const title = manual ? '手动压缩' : '上下文压缩';
  // 状态优先级:运行中 > 失败 > 完成。失败态既没有条数,也没有可展开的摘要正文。
  const brief = running
    ? '正在把早期对话压缩为摘要…'
    : failed
      ? `压缩未完成 · 已保持完整历史不做裁剪${reason ? `(${reason})` : ''}`
      : dropCount > 0
        ? `已压缩 ${dropCount} 条早期消息 · 点击查看压缩摘要`
        : '早期对话已压缩为摘要 · 点击查看';
  const expandable = !running && !failed;
  return (
    <div className="dsh-compaction" data-state={running ? 'running' : failed ? 'failed' : open ? 'open' : 'collapsed'}>
      <DisclosureRow
        icon={<IconApiOutline14 size={14} />}
        title={title}
        open={open}
        expandable={expandable}
        expandOnRowClick={expandable}
        onToggle={toggle}
        collapsedContent={(
          <>
            <span className="dsh-sep" aria-hidden />
            <span className="dsh-summary">{brief}</span>
          </>
        )}
      >
        <div className="dsh-compaction-body">
          <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
        </div>
      </DisclosureRow>
    </div>
  );
}
