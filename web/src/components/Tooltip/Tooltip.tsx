// 全局自定义 tooltip(替代浏览器原生 title 提示):
// 在应用根部挂载一次 <TooltipHost />,之后任意 HTML 元素挂 data-tip="提示文本"
// (支持表达式 data-tip={...};可选 data-tip-side="top|bottom|left|right",默认 top),
// 悬停(hover)或键盘聚焦时统一渲染液态玻璃风格气泡。不在元素外包壳,零布局侵入。
// 可选扩展属性:
//   data-tip-ellipsis 仅当元素文本被省略号截断(scrollWidth > clientWidth)时弹出,否则静默;
//   data-tip-follow    气泡跟随鼠标位置出现在指针旁边(而非目标元素居中)。
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './Tooltip.scss';

type Side = 'top' | 'bottom' | 'left' | 'right';

interface TipState {
  text: string;
  el: Element;
  side: Side;
}

const SHOW_DELAY = 240; // 悬停多少毫秒后显示,避免划过时频繁跳动

export default function TooltipHost() {
  const [tip, setTip] = useState<TipState | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [ready, setReady] = useState(false); // 已按真实气泡尺寸定位完成,可以显示(避免先用 0 尺寸定位导致跳动)
  const [tick, setTick] = useState(0); // 滚动/缩放时自增,触发重新定位
  const ar = useRef({ text: '', el: null as Element | null, side: 'top' as Side }); // 悬停中的目标快照
  const lastMouse = useRef<{ x: number; y: number } | null>(null); // 最近一次鼠标位置(follow 模式定位用)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };

  const hide = () => { clearTimer(); ar.current.el = null; setTip(null); setPos(null); setReady(false); };

  const show = (el: Element, mouse?: { x: number; y: number }) => {
    const text = el.getAttribute('data-tip');
    if (text === null || text === '') { hide(); return; }
    // data-tip-ellipsis:文本未被截断(无省略号)时不弹提示
    if (el.hasAttribute('data-tip-ellipsis')) {
      const node = el as HTMLElement;
      if (node.scrollWidth <= node.clientWidth + 1) { hide(); return; }
    }
    // 切到新提示目标:立即收起当前气泡,避免旧气泡滞留 240ms 后突然跳到新目标位置
    if (ar.current.el) { setTip(null); setPos(null); setReady(false); }
    ar.current = { text, el, side: (el.getAttribute('data-tip-side') || 'top') as Side };
    if (mouse) lastMouse.current = mouse;
    clearTimer();
    // 延迟显示:同元素内部移动(子节点 mouseover)不重启计时
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!ar.current.el) return;
      // 先挂载气泡(隐藏)以便测量真实尺寸,定位完成后才显示,避免出现跳动
      setReady(false);
      setTip({ text: ar.current.text, el: ar.current.el, side: ar.current.side });
      setPos(null);
    }, SHOW_DELAY);
  };

  // 跟随鼠标:气泡出现在指针右下侧,越界时翻转到左上侧并夹紧在视口内
  const followPos = (mx: number, my: number, w: number, h: number) => {
    const gap = 12;
    let x = mx + gap;
    let y = my + gap;
    if (x + w > window.innerWidth - 6) x = mx - w - gap;
    if (y + h > window.innerHeight - 6) y = my - h - gap;
    return {
      x: Math.max(6, Math.min(x, window.innerWidth - w - 6)),
      y: Math.max(6, Math.min(y, window.innerHeight - h - 6)),
    };
  };

  // 气泡出现后按目标矩形 + 气泡实际尺寸定位,并夹紧在视口内(放不下自动翻转方向)。
  // 用 useLayoutEffect 在浏览器绘制前同步完成测量与定位,确保首帧即正确位置,绝无跳动。
  useLayoutEffect(() => {
    if (!tip) return;
    const w = boxRef.current?.offsetWidth || 0;
    const h = boxRef.current?.offsetHeight || 0;
    // data-tip-follow:直接跟随鼠标位置
    if (tip.el.hasAttribute('data-tip-follow') && lastMouse.current) {
      setPos(followPos(lastMouse.current.x, lastMouse.current.y, w, h));
      setReady(true);
      return;
    }
    const rect = tip.el.getBoundingClientRect();
    const gap = 8;
    let x = rect.left + rect.width / 2 - w / 2;
    let y: number;
    if (tip.side === 'top') y = rect.top - h - gap;
    else if (tip.side === 'bottom') y = rect.bottom + gap;
    else if (tip.side === 'left') { x = rect.left - w - gap; y = rect.top + rect.height / 2 - h / 2; }
    else { x = rect.right + gap; y = rect.top + rect.height / 2 - h / 2; }
    const pushIn = () => {
      x = Math.max(6, Math.min(x, window.innerWidth - w - 6));
      y = Math.max(6, Math.min(y, window.innerHeight - h - 6));
    };
    pushIn();
    if (tip.side === 'top' && y < 6) { x = rect.left + rect.width / 2 - w / 2; y = rect.bottom + gap; pushIn(); }
    else if (tip.side === 'bottom' && y + h + 6 > window.innerHeight) { y = rect.top - h - gap; pushIn(); }
    setPos({ x, y });
    setReady(true);
  }, [tip, tick]);

  useEffect(() => {
    const doc = document;
    let moveThrottle = 0; // follow 模式实时重定位的节流阈值(毫秒)

    const onOver = (e: MouseEvent) => {
      const t = e.target as Element | null;
      const el = t ? t.closest('[data-tip]') : null;
      if (el === ar.current.el) { lastMouse.current = { x: e.clientX, y: e.clientY }; return; } // 同一目标内移动,不重启计时
      if (el) show(el, { x: e.clientX, y: e.clientY });
      else if (tip || ar.current.el) hide();
    };
    // follow 模式:气泡已显示时跟着鼠标走(指针移动即更新位置)
    const onMove = (e: MouseEvent) => {
      const m = { x: e.clientX, y: e.clientY };
      lastMouse.current = m;
      const cur = ar.current.el;
      if (cur && cur.hasAttribute('data-tip-follow')) {
        const now = performance.now();
        if (now - moveThrottle < 40) return;
        moveThrottle = now;
        const w = boxRef.current?.offsetWidth || 0;
        const h = boxRef.current?.offsetHeight || 0;
        setPos(followPos(m.x, m.y, w, h));
      }
    };
    const onOut = (e: MouseEvent) => {
      const rel = e.relatedTarget as Node | null;
      const cur = ar.current.el;
      if (!cur) return;
      if (rel && cur.contains(rel)) return; // 仍在同一目标内部
      hide();
    };
    // 键盘聚焦也弹出提示(focus 类元素),鼠标悬停与聚焦互不干扰
    const onFocus = (e: FocusEvent) => {
      const t = e.target as Element | null;
      const el = t ? t.closest('[data-tip]') : null;
      if (!el || el === ar.current.el) return;
      hide();
      show(el);
    };
    const onBlur = (e: FocusEvent) => {
      if (ar.current.el && ar.current.el.contains(e.target as Node)) return;
      hide();
    };
    // 滚动/窗口变化时重新定位(目标仍在视口内的场景,如滚动容器)
    const onScrollResize = () => { ar.current.el && setTick((n) => n + 1); };

    doc.addEventListener('mouseover', onOver, true);
    doc.addEventListener('mousemove', onMove, true);
    doc.addEventListener('mouseout', onOut, true);
    doc.addEventListener('focusin', onFocus, true);
    doc.addEventListener('focusout', onBlur, true);
    doc.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize);
    return () => {
      doc.removeEventListener('mouseover', onOver, true);
      doc.removeEventListener('mousemove', onMove, true);
      doc.removeEventListener('mouseout', onOut, true);
      doc.removeEventListener('focusin', onFocus, true);
      doc.removeEventListener('focusout', onBlur, true);
      doc.removeEventListener('scroll', onScrollResize, true);
      window.removeEventListener('resize', onScrollResize);
      clearTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    tip ? (
      <div ref={boxRef} className="tip-host" role="tooltip"
        style={{
          left: pos?.x ?? 0,
          top: pos?.y ?? 0,
          visibility: ready && pos ? 'visible' : 'hidden',
          transform: `translateX(0)`,
        }}>
        {tip.text}
      </div>
    ) : null,
    document.body
  );
}
