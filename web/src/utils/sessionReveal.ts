/* 任务列表里「当前会话行」的可见性保证 —— 纯函数,便于单测(组件只做 DOM 取值与赋值)。

   一条会话横条会在两处被挤出可见范围:
   1. 组内切片:分组默认只放前 5 条,其余压在「查看更多」之下 —— 当前会话若排在切片之外,
      它根本不在渲染结果里,列表再怎么滚也够不着;
   2. 列表高度:侧栏上分栏高度固定,远程/本地两个分区的分组叠起来常比它长 —— 当前会话
      所在分组可能整块落到可视区之外(刚发过消息的会话尤其容易撞上,它所在的组会重排)。

   对应两个口径:
   - groupVisibleCount:组内至少渲染到第几条(与 harness 会话树「水位线」同一条口径:
     基线 5 条,当前会话把它抬到该会话所在序号);
   - revealScrollTop:列表该滚到哪里才能把目标行带进可视区(已经在区内就不动)。 */

/**
 * 组内至少要渲染的条数:当前会话不能被「查看更多」压在切片之外。
 * @param shown 用户点「查看更多」后累积的条数(基线 5,每点一次加 10)
 * @param focusIndex 当前会话在该组内的下标;不在本组时为 -1
 */
export function groupVisibleCount(shown: number, focusIndex: number): number {
  return Math.max(shown, focusIndex + 1);
}

/** 把一行滚进列表可视区所需的量(视口坐标系,由组件测量后传入) */
export interface RowRevealMetrics {
  /** 列表可视区上边(viewport 坐标) */
  viewTop: number;
  /** 列表可视区下边(viewport 坐标) */
  viewBottom: number;
  /** 目标行上边(viewport 坐标) */
  rowTop: number;
  /** 目标行下边(viewport 坐标) */
  rowBottom: number;
  /**
   * 顶部吸附的分区工具行(.s-sec-head)高度:它 sticky 在列表顶上,滚到最上面时会把行盖住,
   * 所以可视上边要让出这一段,否则「滚到了但看不见」。
   */
  stickyTop: number;
  /** 行与可视边之间留的余量,避免贴边时 hover 描边/圆角被裁掉 */
  pad?: number;
}

/**
 * 计算把目标行带进可视区需要的 scrollTop。
 * 已经在可视区内 → null:不动列表,免得把正在翻看别处的用户硬拽回来。
 */
export function revealScrollTop(current: number, m: RowRevealMetrics): number | null {
  const pad = m.pad ?? 4;
  const top = m.viewTop + m.stickyTop + pad;
  const bottom = m.viewBottom - pad;
  if (m.rowTop >= top && m.rowBottom <= bottom) return null;
  // 行在可视区上方 → 顶端对齐;在下方 → 底端对齐(scrollIntoView({block:'nearest'}) 的同一语义)
  const next = m.rowTop < top ? current - (top - m.rowTop) : current + (m.rowBottom - bottom);
  return Math.max(0, next);
}
