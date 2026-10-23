// 完整命令文本(照搬 dsh ui-primitives 的 CommandText:上游 e8b9e119da + 88311637f8)。
//
// 两个要点:
//   1. **不截断** —— 以前命令是 nowrap + ellipsis,长命令只看得到前半截;
//      这里改成单行横向滚动(white-space: pre),一个字符都不少。
//   2. **只给溢出的文本加 Tab 停靠点** —— 不溢出时 tabIndex / role / aria-label 全不加,
//      否则每张命令卡都会在 Tab 序列里多停一次,纯噪音(上游正是这条修复)。
// 溢出判定要跟着字号变化、字体加载完成、容器缩放一起更新,所以 ResizeObserver 与
// document.fonts 的 loadingdone 都挂上(与上游同一套测量时机)。
import React, { useLayoutEffect, useRef, useState } from 'react';
import './CommandText.scss';

export function CommandText({ text, label, className }: {
  /** 原始命令(不截断) */
  text: string;
  /** 可横向滚动时的无障碍名称 */
  label: string;
  /** 调用方的排版类(字号/颜色/字重) */
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // +1 容忍亚像素取整(上游 f1dcb15b9c 在同类测量上也做了容差)
    const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    const fonts = 'fonts' in document ? document.fonts : undefined;
    fonts?.addEventListener('loadingdone', measure);
    return () => {
      ro?.disconnect();
      fonts?.removeEventListener('loadingdone', measure);
    };
  }, [text]);
  return (
    <span ref={ref} className={className ? `cmdtext ${className}` : 'cmdtext'} data-command-text
      tabIndex={overflow ? 0 : undefined}
      role={overflow ? 'group' : undefined}
      aria-label={overflow ? label : undefined}>{text}</span>
  );
}
