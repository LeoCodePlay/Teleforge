// 视觉视口(virtual keyboard)遮挡量:键盘弹出时把底部内容顶上去。
// iOS Safari:键盘弹出不改变 window.innerHeight,但 visualViewport 缩小——
// offset = 视觉视口底边相对布局视口底边被键盘遮挡的高度。
// Android(配合 <meta interactive-widget=resizes-content>):布局视口本身已缩放,offset 恒为 0。
// 由 App 在 phone 档转成 .app 的 padding-bottom,让 composer/xterm 不被键盘遮挡。
import { useEffect, useState } from 'react';

export function useVisualViewportInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) { setInset(0); return; }
    const update = () => {
      const k = Math.max(0, (vv.height + vv.offsetTop) - window.innerHeight);
      setInset(Math.round(k));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
  }, []);
  return inset;
}
