// 长按手势:pointerdown 启动定时器,移动超过阈值(滚动)或提前抬手则取消。
// 触发后置 swallowClick 标记,吞掉紧接的 click,避免「长按弹出菜单」的同时触发行选中。
// 供 FileManager / LocalFileManager / SessionPanel / ConsolePanel 等触屏右键菜单复用;
// 桌面右键(onContextMenu)原路径不变,二者共用同一个打开菜单函数。
import { useRef } from 'react';

export function useLongPress(
  onLongPress: (x: number, y: number) => void,
  opts?: { delay?: number; moveThreshold?: number }
) {
  const timer = useRef<number | null>(null);
  const start = useRef({ x: 0, y: 0 });
  const swallowClick = useRef(false);
  const cbRef = useRef(onLongPress);
  cbRef.current = onLongPress;
  const clear = () => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return; // 仅触屏
    start.current = { x: e.clientX, y: e.clientY };
    clear();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      swallowClick.current = true;
      window.setTimeout(() => { swallowClick.current = false; }, 600);
      cbRef.current(e.clientX, e.clientY);
    }, opts?.delay ?? 500);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (timer.current === null) return;
    const t = opts?.moveThreshold ?? 10;
    if (Math.abs(e.clientX - start.current.x) > t || Math.abs(e.clientY - start.current.y) > t) clear();
  };
  const onPointerUp = () => clear();
  const onPointerCancel = () => clear();
  /** 长按后的第一个 click 应被吞掉:行 onClick 开头调用 */
  const wasLongPress = () => swallowClick.current;
  return { bind: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel }, wasLongPress };
}
