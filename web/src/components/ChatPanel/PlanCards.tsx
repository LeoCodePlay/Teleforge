// 计划卡片与计划全文面板(移植自 deepseek-harness client/ui-plan 的 PlanCard / PlanPreview)。
//
// dsh 的两个契约点(逐条对齐):
// 1. **卡片挂在回合尾部**(`conversation.chat.turnTail`),一个 `exit_plan_mode` 调用一张:
//    40×40 的 markdown 文件图标 + 标题 + 「计划 · Markdown」+ 右侧「打开」胶囊按钮;整张卡片可点。
// 2. **标题只认一级 `#` 标题**(dsh 客户端 `submittedPlan` 的正则 `/^#\s+(\S[^\r\n]*)/`)——
//    没有 H1 标题就不生成卡片(与服务端执行校验 `^#\s+\S` 同口径);服务端 `firstHeading`
//    接受 1–6 级,那只用于通用工具卡的标题,不用在这里。
//
// 计划正文就在日志的 tool/call arguments 里(不需要额外事件),所以卡片与全文都能从历史恢复。
import React, { useMemo, useState } from 'react';
import type { ChatMessage } from '../../types';
import { IconClose16, IconFile16 } from '../icons/icons';
import { renderMarkdown } from './assistantText';
import './PlanCards.scss';

/** 一份已提交的计划:调用 id(去重/定位用)、markdown 正文、H1 标题 */
export interface SubmittedPlan { callId: string; markdown: string; title: string }

/** 从一条消息的工具段里挑出 `exit_plan_mode` 的提交(dsh submittedPlan 的等价物) */
export function submittedPlansOf(msgs: ChatMessage[]): SubmittedPlan[] {
  const out: SubmittedPlan[] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    for (const seg of m.segments || []) {
      if (seg.kind !== 'tools') continue;
      for (const t of seg.tools || []) {
        if (t.tool !== 'exit_plan_mode' || !t.args) continue;
        let markdown = '';
        try {
          const parsed = JSON.parse(t.args);
          markdown = typeof parsed?.plan === 'string' ? parsed.plan : '';
        } catch { continue; } // 参数不是合法 JSON:留在通用工具行里,不冒充计划
        if (!markdown) continue;
        // 只认一级标题(与 dsh 客户端一致);没有就不生成卡片
        const title = /^#\s+(\S[^\r\n]*)/.exec(markdown.trim())?.[1];
        if (!title) continue;
        const callId = String(t.id || `${out.length}`);
        if (seen.has(callId)) continue;
        seen.add(callId);
        out.push({ callId, markdown, title });
      }
    }
  }
  return out;
}

/** 回合尾部的计划卡片组(一张都没有时整块不渲染) */
export function PlanCards({ msgs, onOpen }: { msgs: ChatMessage[]; onOpen: (plan: SubmittedPlan) => void }) {
  const plans = useMemo(() => submittedPlansOf(msgs), [msgs]);
  if (!plans.length) return null;
  return (
    <div className="plan-cards" data-plan-artifacts>
      {plans.map((plan) => (
        <button key={plan.callId} type="button" className="plan-card" data-plan-card={plan.callId}
          aria-label={`打开计划:${plan.title}`}
          onClick={() => onOpen(plan)}>
          <span className="plan-card-icon" aria-hidden><IconFile16 size={20} /></span>
          <span className="plan-card-details">
            <span className="plan-card-title">{plan.title}</span>
            <span className="plan-card-desc">计划 · Markdown</span>
          </span>
          <span className="plan-card-open">打开</span>
        </button>
      ))}
    </div>
  );
}

/**
 * 计划全文面板:按 markdown 渲染,标题取自计划的首个 H1。
 * dsh 把它送进右侧栏的资源标签;这里做成同形的浮层面板(markdown 正文 + 标题 + 关闭)。
 */
export function PlanPreviewPanel({ plan, onClose, onJump }: {
  plan: SubmittedPlan;
  onClose: () => void;
  /** 「查看全文」:该计划所属的那条消息(用于滚动定位) */
  onJump?: () => void;
}) {
  const html = useMemo(() => renderMarkdown(plan.markdown), [plan.markdown]);
  return (
    <div className="plan-preview-backdrop" role="presentation" onClick={onClose}>
      <section className="plan-preview" aria-label={plan.title} data-plan-preview={plan.callId}
        onClick={(e) => e.stopPropagation()}>
        <header className="plan-preview-head">
          <span className="plan-preview-icon" aria-hidden><IconFile16 size={16} /></span>
          <h2 className="plan-preview-title">{plan.title}</h2>
          <button type="button" className="plan-preview-close" aria-label="关闭计划预览" onClick={onClose}>
            <IconClose16 size={14} />
          </button>
        </header>
        <div className="plan-preview-body">
          {/* 计划是 markdown 文档:与助手正文同一套渲染(marked + DOMPurify) */}
          <div className="plan-preview-doc" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
        <footer className="plan-preview-foot">
          <span className="plan-preview-hint">计划 · Markdown</span>
          {onJump && (
            <button type="button" className="plan-preview-jump" onClick={onJump}>定位到该计划</button>
          )}
        </footer>
      </section>
    </div>
  );
}
