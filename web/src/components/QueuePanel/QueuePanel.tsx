// 消息待执行队列面板(显示在输入框上方):
// 对话进行中发送的消息默认进入队列等待执行,当前轮结束后按 FIFO 自动逐条执行。
// 每条右侧提供操作:立即执行(注入当前运行,不等队列)/ 编辑(撤回输入框重写)/ 删除。
// 纯受控渲染:数据与操作都由 ChatPanel 传入,本组件不做任何数据获取。
import React from 'react';
import './QueuePanel.scss';

/** 待执行队列项(与后端 queueSnapshot 的 {id, text} 结构一致) */
export interface QueueItem {
  id: number;
  text: string;
}

// 操作图标:同消息操作栏的线性风格
const IconRun = () => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4.5 3.2v9.6a.5.5 0 0 0 .76.43l7.2-4.8a.5.5 0 0 0 0-.86l-7.2-4.8a.5.5 0 0 0-.76.43z" fill="currentColor" />
  </svg>
);
const IconEdit = () => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M10.2 2.8l3 3L5 14H2v-3l8.2-8.2zM8 4l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
);
const IconTrash = () => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M2.5 4h11M6.5 4V2.8c0-.4.3-.8.8-.8h1.4c.4 0 .8.4.8.8V4M4 4l.6 8.2c.04.5.45.8.95.8h4.9c.5 0 .9-.3.95-.8L12 4M6.5 7v4M9.5 7v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
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
        <span className="queue-badge" aria-hidden>⏳</span>
        <span className="queue-title">等待执行</span>
        <span className="queue-count">{queue.length} 条</span>
        <span className="queue-hint muted">当前对话结束后按顺序自动执行</span>
      </div>
      <div className="queue-list">
        {queue.map((item, i) => (
          <div className="queue-item" key={item.id}>
            <span className="queue-idx">{i + 1}</span>
            <span className="queue-text" title={item.text}>{item.text}</span>
            <span className="queue-status">等待执行</span>
            <div className="queue-actions">
              <button type="button" className="queue-action action-icon" aria-label="立即执行"
                data-tip="立即执行:注入当前对话,不等待队列,由 Agent 在下一步响应"
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
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}