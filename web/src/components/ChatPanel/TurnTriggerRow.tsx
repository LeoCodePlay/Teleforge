// 「触发这一轮的通知」行 —— 逐条照搬 deepseek-harness 的 ui-chat/chat/TurnTriggerNodeView。
//
// 为什么单独成一层:后台子代理结算、自动化任务到点、目标续跑这类消息**不是用户打的字**,
// 但确实触发了这一轮回复。dsh 把它们渲染成一条独立可展开的通知行(图标 + 标题 + 时间 + 箭头),
// 展开才是模型可见正文 —— 而不是伪装成用户气泡。dsh 的原话:把"运行时替子代理说的话"与
// "用户说的话"合并,会替子代理认领它从未说过的话。
//
// 对应 dsh 的三处:
//   - 标题/图标选法:turn-trigger.ts 的 turnTriggerDetails(kind → title/icon);
//   - 结构:TurnTriggerNodeView(折叠行 = 图标 + 标题 + 时间 + 箭头;展开 = 一句解释 + 正文);
//   - 样式:TurnTriggerNodeView.module.css(0.5px 边框 + xl 圆角 + 三级文字色,悬停提亮)。
import React, { useId, useState } from 'react';
import { IconAgentPreset, IconChevronDown, IconChevronUp } from '../ProcessGroup/processIcons';
import './TurnTriggerRow.scss';

/** 一条非人类消息的来源归属(与服务端 session.ts 的 MessageSource 对象形态一致) */
export interface MessageSource {
  kind: string;
  form?: string;
  summary?: string;
  senderSessionId?: string;
}

/**
 * 来源 kind → 折叠行标题(中文口径与 dsh 的 zh 词表逐条对齐:
 * message.trigger.subagent = 「子任务状态更新」、schedule = 「自动化任务」、
 * goal = 「继续执行目标」、agent-message = 「收到任务消息」……)。
 */
const TITLES: Record<string, string> = {
  'subagent-settled': '子任务状态更新',
  schedule: '自动化任务',
  goal: '继续执行目标',
  'agent-message': '收到任务消息',
  'team-message': '收到团队消息',
  webhook: '收到外部事件',
  github: '收到 GitHub 事件',
  'tool-jobs': '后台任务状态更新',
  'cordis-host-runner': '插件状态更新',
  request: '收到执行请求'
};

/** 折叠行标题:未知 kind 回落到"收到执行请求"(dsh 对未登记来源也是这个末档) */
export function triggerTitle(kind: string): string {
  return TITLES[kind] ?? TITLES.request;
}

/** 时间:与消息时间同一口径(几点几分),没有时间就不画 */
function clockOf(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function TurnTriggerRow({ source, content, time }: {
  source: MessageSource;
  /** 模型可见正文(展开后才显示) */
  content?: string;
  time?: number;
}) {
  // 默认收起:dsh 同款(折叠行已经把"发生了什么"说清楚了,正文按需展开)
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const title = triggerTitle(source.kind);
  const timeText = clockOf(time);
  return (
    <section className="ttr" data-turn-trigger={source.kind}
      data-trigger-form={source.form || undefined}
      data-trigger-sender={source.senderSessionId || undefined}>
      <button type="button" className="ttr-header" aria-expanded={open} aria-controls={bodyId}
        onClick={(e) => { e.currentTarget.focus(); setOpen((v) => !v); }}>
        <span className="ttr-icon" aria-hidden><IconAgentPreset size={14} /></span>
        <span className="ttr-title">{title}</span>
        {timeText && <time className="ttr-time" dateTime={new Date(time || 0).toISOString()}>{timeText}</time>}
        <span className="ttr-chevron" aria-hidden>{open ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}</span>
      </button>
      {open && (
        <div id={bodyId} className="ttr-body">
          <p className="ttr-explanation">这条通知触发了本轮回复。</p>
          <div className="ttr-content">{content || ''}</div>
        </div>
      )}
    </section>
  );
}

export default TurnTriggerRow;
