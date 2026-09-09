// 消息待执行队列面板(显示在输入框上方):
// 对话进行中发送的消息默认进入队列等待执行,当前轮结束后按 FIFO 自动逐条执行。
// 每条右侧提供操作:立即执行(注入当前运行,不等队列)/ 编辑(撤回输入框重写)/ 删除。
// 纯受控渲染:数据与操作都由 ChatPanel 传入,本组件不做任何数据获取。
//
// 视觉语言:一条「待命轴」——头部脉冲点与列表节点同轴贯穿,第一条(下一个执行)常亮,
// 其余为空心节点;文字之外的装饰(徽标/胶囊/描边/emoji)一律不做,操作图标只在行悬浮时浮现。
import React from 'react';
import './QueuePanel.scss';

/** 待执行队列项(与后端 queueSnapshot 的 {id, text, attach} 结构一致;attach=附件数) */
export interface QueueItem {
  id: number;
  text: string;
  /** 该条消息携带的附件数(0/缺省 = 无附件) */
  attach?: number;
}

// 操作图标:与消息操作栏同一笔触(14px 网格 / 1.3 描边 / 圆头)
const IconRun = () => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M5 3.4v9.2a.45.45 0 0 0 .69.38l6.9-4.6a.45.45 0 0 0 0-.76l-6.9-4.6A.45.45 0 0 0 5 3.4z" fill="currentColor" />
  </svg>
);
const IconEdit = () => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M10.2 2.9l2.9 2.9L5.4 13.5H2.5v-2.9l7.7-7.7z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);
const IconTrash = () => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M2.9 4.2h10.2M6.4 4.2V3.1c0-.4.3-.7.7-.7h1.8c.4 0 .7.3.7.7v1.1M4.4 4.2l.6 8c.04.5.4.8.9.8h4.2c.5 0 .86-.3.9-.8l.6-8M6.6 6.8v4M9.4 6.8v4" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
/* 附件:细线回形针,与计数并排(替代跨平台渲染发虚的 📎 emoji) */
const IconPaperclip = () => (
  <svg width={11} height={11} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M10.6 4.6 5.4 9.8a2.1 2.1 0 0 0 3 3l5.2-5.2a3.6 3.6 0 0 0-5.1-5.1L3 7.8a5 5 0 0 0 7.1 7.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

interface QueuePanelProps {
  queue: QueueItem[];
  onRunNow: (item: QueueItem) => void;
  onEdit: (item: QueueItem) => void;
  onDelete: (item: QueueItem) => void;
}

export default function QueuePanel({ queue, onRunNow, onEdit, onDelete }: QueuePanelProps) {
  if (!queue.length) return null;
  return (
    <div className="queue-panel" role="region" aria-label="待执行消息队列">
      <div className="queue-head">
        <span className="queue-pulse" aria-hidden />
        <span className="queue-title">等待执行</span>
        <span className="queue-count">{queue.length} 条</span>
        <span className="queue-hint">本轮结束后按顺序自动执行</span>
      </div>
      <ul className="queue-list">
        {queue.map((item, i) => (
          <li
            className={`queue-item${i === 0 ? ' is-next' : ''}`}
            key={item.id}
            aria-current={i === 0 ? 'true' : undefined}
            style={{ '--i': i } as React.CSSProperties}
          >
            {/* 待命轴节点:第一条 = 下一个执行 */}
            <span className="queue-node" aria-hidden />
            <span className="queue-text" data-tip={item.text} data-tip-ellipsis="">{item.text}</span>
            {!!item.attach && (
              <span className="queue-attach" data-tip={`${item.attach} 个附件`}>
                <IconPaperclip />
                {item.attach}
              </span>
            )}
            <span className="queue-actions">
              <button type="button" className="queue-action action-icon run" aria-label="立即执行"
                data-tip="立即执行:打断当前回复,立即切换回复这条消息"
                onClick={() => onRunNow(item)}>
                <IconRun />
              </button>
              <button type="button" className="queue-action action-icon" aria-label="编辑"
                data-tip="编辑:撤回输入框重新编辑,发送后重新排队"
                onClick={() => onEdit(item)}>
                <IconEdit />
              </button>
              <button type="button" className="queue-action action-icon danger" aria-label="删除"
                data-tip="删除:从队列中移除,不再执行"
                onClick={() => onDelete(item)}>
                <IconTrash />
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
