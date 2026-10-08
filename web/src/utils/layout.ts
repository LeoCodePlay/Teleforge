// 三栏布局(左栏 + 中间对话区 + 右栏)的宽度约束。
//
// 为什么要有这个模块:左栏和右栏都能拖拽调宽,但「给中间对话区留多少」是两边**共享**的规则。
// 各自只按视口比例夹自己(旧行为:左栏 ≤ 60% 视口、右栏 ≤ 视口 - 420)时,
// 两侧同时拉宽 —— 或者一侧已经很宽 —— 中间对话区会被挤成一条缝,所以上限必须扣掉另一侧已占的宽度。
// 数值放在这里而不是各组件里:只有一个来源,左右两根拖把不会互相跑偏。

/** 中间对话区的硬底线(px):任何侧栏拖拽 / 视口变化都不能把它压得比这更窄 */
export const MIN_MAIN_WIDTH = 420;

/** 左栏(会话列表)最小宽度,与 App.scss 的 .sidebar-left min-width 一致 */
export const LEFT_SIDEBAR_MIN = 220;
/** 左栏最宽 = 视口的这个比例(超宽屏上左栏不该一路拉长) */
export const LEFT_SIDEBAR_MAX_RATIO = 0.6;

/** 量出另一条侧栏当前占的像素宽度;查不到(收起 / 未挂载)按 0 算。 */
export function otherSidebarWidth(selector: string): number {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return 0;
  // 覆盖式抽屉不占布局宽度:<1280 平板的左栏是 position:absolute 的浮层,它盖在对话区**上面**,
  // 把它算进预留量只会白白压低右栏的上限(平板上右栏会直接被压到最小值,再也拖不宽)。
  const pos = window.getComputedStyle(el).position;
  if (pos === 'absolute' || pos === 'fixed') return 0;
  return el.offsetWidth;
}

/**
 * 侧栏宽度上限 = 视口宽 - 对话区底线 - 另一条侧栏已占宽度。
 * @param otherSelector 另一条侧栏的选择器(左栏 '.sidebar-left' / 右栏 '.sidebar-right')
 * @param min 这条侧栏自己的最小宽度:窗口实在太窄时至少给到它,免得算出负上限
 */
export function sidebarMaxWidth(otherSelector: string, min: number): number {
  return Math.max(min, window.innerWidth - MIN_MAIN_WIDTH - otherSidebarWidth(otherSelector));
}
