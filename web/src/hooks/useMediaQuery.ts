// 响应式断点钩子:内部封装 matchMedia,监听变化返回实时布尔。
// 与 App.scss/styles.scss 里的媒体查询保持同一套断点(见各 scss 顶部注释):
//   <768 phone / 768-1279 tablet / ≥1280 desktop
import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches); // 订阅前先同步一次,避免首帧闪烁
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** <768:手机(底部 Tab 单栏) */
export function useIsPhone(): boolean { return useMediaQuery('(max-width: 767px)'); }
/** 768-1279:平板/窄窗口(侧栏抽屉化) */
export function useIsTablet(): boolean { return useMediaQuery('(min-width: 768px) and (max-width: 1279px)'); }
/** ≥1280:桌面三栏 */
export function useIsDesktop(): boolean { return useMediaQuery('(min-width: 1280px)'); }
/** 触摸优先设备(触控笔+触摸屏):用来决定是否渲染终端切换器等触控增强 */
export function useCoarsePointer(): boolean { return useMediaQuery('(pointer: coarse)'); }
