// 「计划」chip(移植自 deepseek-harness client/ui-plan 的 PlanModeControl)。
//
// 与 dsh 逐条一致:
// - 只在"有效目标 = 计划模式"时渲染:`target = pending ? !active : active`(折叠后的宿主值,
//   不是前端乐观值);不显示时整块不渲染。
// - 一个 14px 图标位 + 文案「计划」;静止是计划轮廓图,悬停/键盘聚焦换成"圆圈叉"——
//   提示这一下点下去是**关闭**计划模式(`/plan off`)。
// - 点击走 `/plan off`;失败时 chip 保持可见并显示「退出计划模式失败」(title 是错误原文)。
import React, { useState } from 'react';
import './PlanChip.scss';

/** 计划轮廓图(harness IconPlanOutlineRegular 同形) */
function PlanGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 14V2.5h6.2l-1 2.2 1 2.2H3.5" stroke="currentColor" strokeWidth="1.3"
        strokeLinejoin="round" strokeLinecap="round" />
      <path d="M3.5 2.5v11.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** 圆圈叉(harness IconCloseCircleFillRegular 同形):悬停/聚焦时替换计划图 */
function CloseCircleGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" fill="currentColor" />
      <path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" stroke="var(--bg, #fff)" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export default function PlanChip({ active, pending, leaving, error, onExit }: {
  /** 日志里生效的计划模式(harness plan.active) */
  active: boolean;
  /** 已选但还没到 step 边界的取值(harness plan.pending);undefined = 没有待生效的选择 */
  pending?: boolean;
  /** 正在执行 /plan off */
  leaving?: boolean;
  /** 退出失败的错误原文(title 属性用它) */
  error?: string | null;
  onExit: () => void;
}) {
  const [hover, setHover] = useState(false);
  // 有效目标:有 pending 时以 pending 为准(与 dsh 的 `pending ? !active : active` 同式)
  const target = pending === undefined ? active : !active;
  if (!target) return null;
  const disabled = !!leaving;
  return (
    <span className="plan-chip-wrap">
      <button
        type="button"
        className="plan-chip"
        aria-label="计划模式已开启,按下关闭"
        title="计划模式已开启 — 点击关闭(/plan off)"
        disabled={disabled}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        onClick={onExit}
      >
        <span className="plan-chip-glyph" aria-hidden>
          {hover && !disabled ? <CloseCircleGlyph /> : <PlanGlyph />}
        </span>
        计划
      </button>
      {error ? <span className="plan-chip-error" role="status" title={error}>退出计划模式失败</span> : null}
    </span>
  );
}
