import { useEffect } from 'react';
import type { RefObject } from 'react';

// 面包屑横向行(快捷跳转路径):滚轮→横向滚动 + 按住拖拽滚动。
// 原生横向滚动条被全局隐藏(见 styles.scss 滚动条章节),只在滚动时会由
// scrollbar-ui.ts 悬浮显示拇指——普通滚轮此时只会带动整页滚动,行内既滚动
// 不了也看不到滚动条。本 Hook 补上两种直接的驱动方式,滚动时拇指自然点亮。
const DRAG_THRESHOLD = 4;

export function useHorizontalScroller(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const canScrollX = () => el.scrollWidth > el.clientWidth + 1;
    const syncGrab = () => el.classList.toggle('dx-grab', canScrollX());

    /* ---- 鼠标滚轮 → 横向滚动 ----
       passive:false 才能 preventDefault,阻止滚动穿透到整页/纵向容器 */
    const onWheel = (e: WheelEvent) => {
      if (!canScrollX()) return;
      e.preventDefault();
      el.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });

    /* ---- 按住拖拽滚动(与触控板拖动的方向一致:内容跟随指针移动) ---- */
    let pid = -1;
    let startX = 0;
    let startLeft = 0;
    let dragging = false;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (!canScrollX()) return;
      // 触屏:不 preventDefault——保留浏览器原生的触摸横滑(惯性滚动),
      // pointermove 兜底仅对鼠标生效(pointerType==='touch' 交给浏览器,避免双重滚动)
      if (e.pointerType === 'touch') return;
      e.preventDefault(); // 阻止拖拽时选中文字
      pid = e.pointerId;
      startX = e.clientX;
      startLeft = el.scrollLeft;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return; // 触屏滑动交给浏览器原生滚动(见 onPointerDown)
      if (pid !== e.pointerId) return;
      if (!dragging && Math.abs(e.clientX - startX) < DRAG_THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        el.classList.add('dx-scrolling');
      }
      el.scrollLeft = startLeft - (e.clientX - startX);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pid !== e.pointerId) return;
      pid = -1;
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dx-scrolling');
      // 拖完松手会补发一次 click,吞掉它,避免误触发某个面包屑的跳转
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', swallow, true);
      window.setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    };
    el.addEventListener('pointerdown', onPointerDown);
    // 指针可能移出元素范围,移动/抬起监听挂在 window 上保证拖拽不中断
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    /* ---- 可拖拽提示:溢出时才点亮 grab 光标 ----
       容器宽度变化(ResizeObserver)与路径内容变化(MutationObserver)都会重算 */
    syncGrab();
    const ro = new ResizeObserver(syncGrab);
    ro.observe(el);
    const mo = new MutationObserver(syncGrab);
    mo.observe(el, { childList: true, subtree: true });

    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      ro.disconnect();
      mo.disconnect();
      el.classList.remove('dx-scrolling', 'dx-grab');
    };
  }, [ref]);
}