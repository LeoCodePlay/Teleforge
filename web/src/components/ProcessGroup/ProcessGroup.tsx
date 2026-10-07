// 过程组组件(照搬 deepseek-harness ui-chat/chat/ChatGroupSeat):
// 一行组头(活动图标 ↔ chevron 交叉淡入 + 动态标题 + 运行时 shimmer)+ 可折叠的组体。
//
// 观感上的三个关键点(缺一个就不像):
//   1. **图标与 chevron 交叉淡入**:折叠时显示"在干什么"的活动图标,悬停或展开时淡出成
//      上/下箭头。不是两个图标并排,而是同一个 16px 槽里的透明度互换(dsh 的 .leading)。
//   2. **运行时标签有扫光**:直接用 dsh 的 TextShimmer 原件(遮罩式扫光),结束后消失。
//   3. **组体有高度上限 + 上下渐隐**:`min(400px, 50vh)` 之后内部滚动,可滚动的那一侧
//      用 24px 渐隐遮罩暗示"下面还有",而不是直接切断。
import React, { useEffect, useRef, useState } from 'react';
import { TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ActivitySummary, ProcessActivity } from '../../utils/processGroups';
import { groupTitle, isGroupLive } from '../../utils/processGroups';
import { PROCESS_ICONS, IconChevronDown, IconChevronUp } from './processIcons';
import { useProcessScroll } from './useProcessScroll';
import './ProcessGroup.scss';

type TitleActivity = ProcessActivity | 'thinking';

/** 标题最短驻留时间:运行中标题每步都变,不节流会不停闪烁(dsh 的 PROCESS_TITLE_MINIMUM_MS) */
const TITLE_MIN_MS = 150;

/** 节流后的实时标题:变化太频繁时保持上一个至少 150ms,避免标签抖动到看不清 */
function useStableTitle(desired: string, active: boolean): string {
  const [shown, setShown] = useState(desired);
  const shownRef = useRef(shown);
  const desiredRef = useRef(desired);
  const atRef = useRef(Date.now());
  useEffect(() => {
    desiredRef.current = desired;
    if (!active || shownRef.current === desired) return;
    const remain = TITLE_MIN_MS - (Date.now() - atRef.current);
    const commit = () => { const next = desiredRef.current; shownRef.current = next; atRef.current = Date.now(); setShown(next); };
    if (remain <= 0) { commit(); return; }
    const t = setTimeout(commit, remain);
    return () => clearTimeout(t);
  }, [active, desired]);
  return active ? shown : desired;
}

// 组体的滚动与渐隐交给 useProcessScroll(dsh 的 use-process-scroll 原件):
// 滚到底跟随内容增长、滚离底部暂停跟随、到滚动边缘把滚轮交回外层文本记录,
// 两端还能滚时上报 edges 给渐隐遮罩。

export function ProcessGroup({ summary, live, collapsed, defaultOpen = false, capped = true, flat = false, children }: {
  summary: ActivitySummary;
  /** 组里是否还有在跑的工具:标题 shimmer 与"实时详情"据此决定 */
  live: boolean;
  /** 是否启用折叠(dsh 的 stepGrouping:standard=总是折叠,detailed=回合结束后才折叠,verbose=不折叠) */
  collapsed: boolean;
  /** 初始是否展开。外层已有回合级折叠时用 true:点开外层就该直接看到工具行,不必再点一次 */
  defaultOpen?: boolean;
  /** 是否限制组体高度(dsh 只在折叠分组模式下限高 min(400px,50vh));
   *  设为 false 则完整铺开、不出滚动条 —— 外层折叠已承担收起职责时用 false */
  capped?: boolean;
  /** 平铺模式:不渲染组头(不折叠)、不限高。
   *  用于"外层已有回合级折叠"的场景 —— 点开外层就该一眼看到全部工具行,
   *  而不是再看到一个需要二次点击的组头,或一个内部滚动区。 */
  flat?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(flat || defaultOpen);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const activity: TitleActivity = live ? (summary.running ?? 'thinking') : (summary.counts[0]?.kind ?? 'thinking');
  const title = useStableTitle(groupTitle(summary, !live), live);
  // 平铺模式:组头不渲染、永远展开、不限高 —— 外层折叠已经承担了收起职责
  const showHeader = collapsed && !flat;
  const bodyHidden = !flat && collapsed && !open;
  const bodyExpanded = flat || !collapsed || !capped;
  // dsh 的 grouped:这一形态是否保留「折叠 + 限高」,决定组体要不要滚动跟随与渐隐
  const grouped = !bodyExpanded;
  const { edges, events, initialize } = useProcessScroll(bodyRef, contentRef, open, grouped);

  // 手动展开先定落点(dsh 同款):还没结束的组定位到底部并跟随增长,
  // 已结束的组从顶部开始、不启用跟随。
  const toggle = () => {
    if (!open) initialize(live ? 'bottom' : 'top');
    setOpen((v) => !v);
  };

  const bodyClasses = ['dsh-pg-body'];
  if (bodyExpanded) bodyClasses.push('expanded');
  if (grouped && edges.canScrollUp) bodyClasses.push('fade-top');
  if (grouped && edges.canScrollDown) bodyClasses.push('fade-bottom');

  return (
    <div className="dsh-procgroup" data-process-activity={activity} data-live={live || undefined}
      data-collapsed={collapsed || undefined} data-flat={flat || undefined}
      data-group-expanded-mode={!grouped || undefined}>
      {/* 折叠态才显示组头(dsh: header 用 hidden={!grouped} 控制) */}
      {showHeader && (
        <button type="button" className="dsh-pg-title" aria-expanded={open}
          data-process-title onClick={(e) => { e.currentTarget.focus(); toggle(); }}>
          <span className="dsh-pg-leading" aria-hidden>
            <span className="dsh-pg-icon">{PROCESS_ICONS[activity]}</span>
            {/* dsh 同款:展开/折叠换的是两个图标(不旋转同一个) */}
            <span className="dsh-pg-chevron">{open ? <IconChevronUp /> : <IconChevronDown />}</span>
          </span>
          {/* dsh 同款:外层 TextShimmer 决定是否扫光,内层携带 label 类名 */}
          <TextShimmer active={live}>
            <TextShimmer className="dsh-pg-label">{title}</TextShimmer>
          </TextShimmer>
        </button>
      )}
      <div ref={bodyRef} hidden={bodyHidden || undefined} className={bodyClasses.join(' ')}
        data-process-body {...events}>
        <div ref={contentRef} className="dsh-pg-content">{children}</div>
      </div>
    </div>
  );
}

/** 由外层决定:该组是否还有在跑的东西(避免组件自己重算) */
export { isGroupLive };
export type { ActivitySummary };
