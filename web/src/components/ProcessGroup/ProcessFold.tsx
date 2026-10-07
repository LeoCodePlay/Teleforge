// 回合过程折叠行(对齐 dsh 的 TurnProcessNodeView)。
//
// 这是「完成对话后收起过程」的那个控件,折叠行只有一句:
//   「已完成,用时 2分19秒」▾
// 它把整轮的工具活动收起来,展开后**完整铺开、不限高、不出滚动条**。
//
// 与 ProcessGroup(内层工具分组)的分工(照 dsh 的两层结构,别混):
//   本组件 = 回合级折叠,展开后不限高、不出滚动条(dsh 的 uncapped);
//   ProcessGroup = **组级**折叠,每个"一段工具活动"有自己的组头,组体限高 min(400px,50vh)
//   并带上下渐隐(dsh 的 ChatGroupSeat)。
// 所以层级是:回合折叠行 ▾ → 过程组组头(「已读取文件并修改了文件」)▾ → 具体工具行。
// 内层**不能**设成 flat:那样"一段工具调用"就没有自己的折叠行了,与 dsh 不一致。
//
// 样式照搬 dsh 的 TurnProcessNodeView.module.css:一行文字 + chevron,
// 底部一条 0.5px 分隔线(harness 原样保留)。
import React from 'react';
import { turnProcessParts } from '../../utils/processGroups';
import type { TurnEndReason } from '../../utils/processGroups';
import { IconChevronDown } from './processIcons';
import './ProcessFold.scss';

export function ProcessFold({ reason, elapsedMs, open, onToggle, hasContent = true }: {
  /** 回合结束原因(aborted/error 不显示耗时,并换成「已停止」/「处理失败」) */
  reason?: TurnEndReason;
  /** 回合耗时(ms);缺省显示不带时长的「已完成」 */
  elapsedMs?: number;
  open: boolean;
  onToggle: () => void;
  /** 没有过程可展开时(纯文本回复)不渲染 chevron,行也不可点 */
  hasContent?: boolean;
}) {
  const { prefix, parts } = turnProcessParts(reason, elapsedMs);
  return (
    <button type="button" className="pf" data-open={open || undefined}
      data-turn-process="" data-reason={reason || undefined}
      aria-expanded={hasContent ? open : undefined}
      disabled={!hasContent}
      onClick={() => { if (hasContent) onToggle(); }}>
      {/* 无障碍状态播报(与 dsh 的 visuallyHidden role="status" 同效)。
          与显示文案分开:中断时显示「已停止」,播报给屏幕阅读器的是稳定措辞。 */}
      <span className="pf-sr" role="status" aria-live="polite" aria-atomic="true">
        {reason === 'aborted' ? '已停止' : reason === 'error' ? '处理失败' : '已完成'}
      </span>
      <span className="pf-label">
        {prefix}
        {/* 数字单独套等宽 + tabular-nums:耗时变化时行宽不抖(dsh 的 .durationNumber) */}
        {parts.map((p, i) => (p.numeric
          ? <span key={i} className="pf-num">{p.text}</span>
          : <span key={i}>{p.text}</span>))}
      </span>
      {hasContent && <IconChevronDown className="pf-chevron" />}
    </button>
  );
}
