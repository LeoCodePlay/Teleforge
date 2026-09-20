/* 固定定位菜单的「滚动收拢」判据:只有会带着菜单锚点一起移动的滚动才收起菜单。

   菜单是 fixed 定位,锚点坐标在打开那一刻定格:
   - 滚动元素在面板内(列表/面包屑自滚)→ 菜单与行错位,必须收起;
   - 滚动元素包含面板(外层容器滚动)→ 面板整体位移,同样错位,必须收起;
   - 无关区域的滚动(聊天流式吸底、代码编辑器自滚等)→ 锚点不动,菜单应当留在原地。

   旧实现监听 window 捕获阶段的 scroll 后无条件关闭:AI 回复流式触底每帧都会发 scroll,
   于是「右键弹出的菜单刚打开就被 AI 回复打断隐藏」。 */
export function scrollMovesPanel(root: HTMLElement | null, e: Event): boolean {
  if (!root) return true;
  const el = e.target instanceof Document ? e.target.documentElement : e.target as Node | null;
  if (!el) return true;
  return root.contains(el) || el.contains(root);
}
