// 工作区分组拖拽排序(任务列表):一套指针手势同时覆盖桌面与触屏——
// - 桌面:按住分组头移动超过 slop(默认 4px)即进入拖拽,原地不动松手仍是「点击折叠」
// - 触屏:长按 delay(默认 500ms,与 useLongPress 同阈值)不直接起拖,而是回调 onLongPress
//   由调用方弹分组菜单(排序入口挪到菜单里的「拖动排序」,再调 reorder 起拖);
//   长按前的移动超过 TOUCH_SLOP 即取消长按,轻扫照旧交给列表滚动,不抢手势
// 约定(调用方负责在 DOM 上标注):
// - 分组根节点带 data-group-key(唯一 key)与 data-section-id(所属分区)
// - 排序只在同一 sectionId 内生效:远程任务列表 / 本地任务列表各自独立,跨分区不响应
// 交互:拖拽期间就实时换位——指针越过某个分组的中线,被拖分组立刻让位/前移(与标签拖拽同款手感),
// 松手才把最终顺序交给调用方持久化;不画插入指示线,位置本身的变化就是落点反馈。
// 观感:被拖分组用行内 transform 跟着指针走(半透明浮起的「虚影」),落下时原地归位。
import { useCallback, useEffect, useRef, useState } from 'react';

export interface GroupDragState {
  /** 被拖起的分组 key */
  key: string;
  /** 拖拽所属分区(只有同分区的分组参与换位) */
  sectionId: string;
  /** 拖拽期间的实时顺序(该分区的完整 key 列表),调用方按它渲染 */
  keys: string[];
}

interface Options {
  /** 分组所在的滚动容器:用它采集同分区分组,并在拖到上下边缘时自动滚动 */
  rootRef: React.RefObject<HTMLElement>;
  /** 松手提交:该分区内分组的最新完整顺序 */
  onCommit: (sectionId: string, keys: string[]) => void;
  /** 触屏长按分组头(坐标 = 按下点):交给调用方弹分组菜单;起拖改由菜单项调 reorder */
  onLongPress?: (key: string, sectionId: string, x: number, y: number) => void;
  /** 触屏长按进入拖拽的时长(ms) */
  delay?: number;
  /** 桌面按下后移动多少像素算拖拽 */
  slop?: number;
}

const TOUCH_SLOP = 10;      // 触屏长按期间的容错位移:超过即认为用户在滚动列表
const EDGE = 28;            // 自动滚动触发区(距列表上下边缘)
const EDGE_SPEED = 9;       // 自动滚动速度(每帧像素)
const SWALLOW_MS = 600;     // 拖拽结束后的 click 吞掉窗口(与 useLongPress 一致)

export function useGroupReorder({ rootRef, onCommit, onLongPress, delay = 500, slop = 4 }: Options) {
  const [drag, setDrag] = useState<GroupDragState | null>(null);
  const dragRef = useRef<(GroupDragState & { startKeys: string[] }) | null>(null);
  // 已按下但还没进入拖拽:桌面等位移阈值,触屏等长按定时器
  const pending = useRef<{ key: string; sectionId: string; x: number; y: number; touch: boolean; timer: number | null } | null>(null);
  const swallow = useRef(false);
  const swallowTimer = useRef<number | null>(null);
  const dragEl = useRef<HTMLElement | null>(null); // 被拖起的那个分组元素(虚影本体)
  const grabOffset = useRef(0);                    // 按下时指针到分组中心的偏移:跟手时保持这个手感
  const dy = useRef(0);                            // 当前跟手位移:读 rect 要先减掉它才是流内基准位置
  const lastY = useRef(0);
  const raf = useRef(0);
  const dir = useRef(0);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const longPressRef = useRef(onLongPress);
  longPressRef.current = onLongPress;

  /** 同一分区内的分组元素(文档顺序 = 当前渲染顺序) */
  const sectionItems = useCallback((sectionId: string): HTMLElement[] => {
    const root = rootRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>('[data-group-key]'))
      .filter((el) => el.dataset.sectionId === sectionId);
  }, [rootRef]);

  const clearPending = useCallback(() => {
    const p = pending.current;
    if (p && p.timer !== null) clearTimeout(p.timer);
    pending.current = null;
  }, []);

  const stopAutoScroll = useCallback(() => {
    dir.current = 0;
    if (raf.current) { cancelAnimationFrame(raf.current); raf.current = 0; }
  }, []);

  /**
   * 按指针纵坐标实时算出该分区的目标顺序:
   * 取「中点在指针之下的第一个分组」作为插入位,被拖项插到它前面(都不到则插末尾)。
   * 每次都按当前 DOM 顺序重算——DOM 就是上一帧换位后的结果,所以不会来回抖。
   */
  const updateOrder = useCallback((y: number) => {
    const d = dragRef.current;
    if (!d) return;
    const others = sectionItems(d.sectionId).filter((el) => el.dataset.groupKey !== d.key);
    let at = others.length;
    for (let i = 0; i < others.length; i++) {
      const r = others[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) { at = i; break; }
    }
    const keys = [
      ...others.slice(0, at).map((el) => el.dataset.groupKey!),
      d.key,
      ...others.slice(at).map((el) => el.dataset.groupKey!)
    ];
    if (keys.length === d.keys.length && keys.every((k, i) => k === d.keys[i])) return; // 顺序没变不重渲染
    d.keys = keys;
    setDrag({ key: d.key, sectionId: d.sectionId, keys });
  }, [sectionItems]);

  /**
   * 跟手虚影:被拖分组用 transform 跟着指针走。
   * transform 不参与布局,所以换位判定照旧读各分组在流内的位置(与绑定顺序无关);
   * 读自己被拖元素的 rect 时要先减掉当前位移,才是它在流内的基准中心。
   */
  const followPointer = useCallback((y: number) => {
    const el = dragEl.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const baseCenter = r.top + r.height / 2 - dy.current;
    dy.current = (y + grabOffset.current) - baseCenter;
    el.style.transform = `translateY(${dy.current}px)`;
  }, []);

  /** 自动滚动帧:滚动会改变各分组与指针的相对位置,滚完要重算顺序 */
  const tick = useCallback(function tickFn() {
    raf.current = 0;
    const root = rootRef.current;
    const d = dragRef.current;
    if (!root || !dir.current || !d) return;
    const before = root.scrollTop;
    root.scrollTop = before + dir.current * EDGE_SPEED;
    if (root.scrollTop !== before) {
      updateOrder(lastY.current);
      followPointer(lastY.current);
    }
    if (dir.current) raf.current = requestAnimationFrame(tickFn);
  }, [rootRef, followPointer, updateOrder]);

  const autoScroll = useCallback((y: number) => {
    const root = rootRef.current;
    if (!root) return;
    const r = root.getBoundingClientRect();
    const next = y < r.top + EDGE ? -1 : y > r.bottom - EDGE ? 1 : 0;
    if (next === dir.current) return;
    dir.current = next;
    if (next && !raf.current) raf.current = requestAnimationFrame(tick);
    if (!next && raf.current) { cancelAnimationFrame(raf.current); raf.current = 0; }
  }, [rootRef, tick]);

  /** 触屏拖拽期间必须掐掉列表滚动:touchmove 只能靠非 passive 监听 preventDefault */
  const blockTouchScroll = useCallback((e: TouchEvent) => {
    if (e.cancelable) e.preventDefault();
  }, []);

  /** 拖拽刚结束:浏览器补发的那个 click 不能被当成「点击折叠」。
      消费掉第一次 click 即复位(不必等满 SWALLOW_MS),超时只是「拖到别处松手、根本没有 click」时的兜底。
      复位监听挂在冒泡阶段:React 的 onClick(root 上)先跑并读到 true,到这里才复位 */
  const armSwallow = useCallback(() => {
    swallow.current = true;
    if (swallowTimer.current !== null) clearTimeout(swallowTimer.current);
    swallowTimer.current = window.setTimeout(() => {
      swallow.current = false;
      swallowTimer.current = null;
    }, SWALLOW_MS);
    window.addEventListener('click', function once() {
      window.removeEventListener('click', once);
      swallow.current = false;
      if (swallowTimer.current !== null) { clearTimeout(swallowTimer.current); swallowTimer.current = null; }
    }, false);
  }, []);

  /** 结束(或取消)拖拽;commit=true 且顺序真的变过才提交 */
  const finish = useCallback((commit: boolean) => {
    const d = dragRef.current;
    clearPending();
    // 没进过拖拽(按下即抬起 = 普通点击,或触屏长按被移动取消):不能吞 click,否则点分组头折不动
    if (!d) { stopAutoScroll(); return; }
    armSwallow();
    dragRef.current = null;
    stopAutoScroll();
    setDrag(null);
    document.removeEventListener('touchmove', blockTouchScroll);
    // 虚影落回原位(行内 transform/z-index 是拖拽期间临时加的)
    const el = dragEl.current;
    if (el) { el.style.transform = ''; el.style.zIndex = ''; }
    dragEl.current = null;
    dy.current = 0;
    if (!commit) return;
    const moved = d.keys.length !== d.startKeys.length || d.keys.some((k, i) => k !== d.startKeys[i]);
    if (moved) commitRef.current(d.sectionId, d.keys);
  }, [armSwallow, blockTouchScroll, clearPending, stopAutoScroll]);

  /** 真正进入拖拽:此时才上拖起态、封锁触屏滚动 */
  const begin = useCallback((key: string, sectionId: string, y: number) => {
    clearPending();
    if (dragRef.current) return;
    swallow.current = true; // 拖完松手时浏览器还会补一个 click,不能被当成「点击折叠」
    const items = sectionItems(sectionId);
    const keys = items.map((el) => el.dataset.groupKey!);
    dragRef.current = { key, sectionId, keys, startKeys: keys };
    lastY.current = y;
    // 记下按下手感(指针到分组中心),并让虚影立刻上浮一层
    dragEl.current = items.find((el) => el.dataset.groupKey === key) || null;
    dy.current = 0;
    if (dragEl.current) {
      const r = dragEl.current.getBoundingClientRect();
      grabOffset.current = (r.top + r.height / 2) - y;
      dragEl.current.style.zIndex = '30';
    }
    document.addEventListener('touchmove', blockTouchScroll, { passive: false });
    setDrag({ key, sectionId, keys });
    updateOrder(y);
    followPointer(y);
  }, [blockTouchScroll, clearPending, followPointer, sectionItems, updateOrder]);

  /** 分组头按下:桌面等位移,触屏等长按(组内按钮不参与拖拽) */
  const bindHeader = useCallback((e: React.PointerEvent, key: string, sectionId: string) => {
    if (dragRef.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as HTMLElement).closest?.('button')) return;
    clearPending();
    const touch = e.pointerType !== 'mouse';
    pending.current = {
      key, sectionId, x: e.clientX, y: e.clientY, touch,
      timer: touch ? window.setTimeout(() => {
        const p = pending.current;
        pending.current = null;
        if (!p) return;
        // 长按 = 弹分组菜单(不再直接起拖):紧跟其后的 click 要吞掉,否则松手会顺带折叠/展开分组
        armSwallow();
        longPressRef.current?.(p.key, p.sectionId, p.x, p.y);
      }, delay) : null
    };
  }, [armSwallow, clearPending, delay]);

  // window 级监听常驻(未按下时首个判断即返回,开销可忽略);
  // 通过 ref 转发到最新一次渲染的逻辑,避免监听像闭包一样锁住旧 state
  const latest = useRef<(e: PointerEvent) => void>(() => {});
  latest.current = (e: PointerEvent) => {
    const p = pending.current;
    if (p && !dragRef.current) {
      const over = Math.abs(e.clientX - p.x) > (p.touch ? TOUCH_SLOP : slop)
        || Math.abs(e.clientY - p.y) > (p.touch ? TOUCH_SLOP : slop);
      // 触屏:动了就是在滚列表,放弃长按;桌面:够远即开始拖拽
      if (over) { if (p.touch) clearPending(); else begin(p.key, p.sectionId, e.clientY); }
    }
    if (!dragRef.current) return;
    lastY.current = e.clientY;
    updateOrder(e.clientY); // 先按流内位置换位
    followPointer(e.clientY); // 再把虚影贴回指针(换位后基准位置变了,这里顺带修正)
    autoScroll(e.clientY);
  };

  // 换位是 React 渲染出来的:渲染后被拖分组的流内基准位置变了,
  // 下一帧把虚影重新贴回指针位置,避免换位瞬间虚影离指针差一个分组高度
  useEffect(() => {
    if (!drag) return;
    const id = requestAnimationFrame(() => followPointer(lastY.current));
    return () => cancelAnimationFrame(id);
  }, [drag, followPointer]);

  useEffect(() => {
    const move = (e: PointerEvent) => latest.current(e);
    const up = () => finish(true);
    const cancel = () => finish(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [finish]);

  // 卸载兜底:正在拖拽时被卸载(切布局/关抽屉),清掉定时器与滚动帧
  useEffect(() => () => {
    if (pending.current?.timer != null) clearTimeout(pending.current.timer);
    if (swallowTimer.current !== null) clearTimeout(swallowTimer.current);
    if (raf.current) cancelAnimationFrame(raf.current);
    document.removeEventListener('touchmove', blockTouchScroll);
  }, [blockTouchScroll]);

  return {
    /** 当前拖拽态(null = 没在拖);调用方据此渲染拖起态并按 keys 换位 */
    drag,
    bindHeader,
    /** 分组菜单「拖动排序」调用:从该分组起拖(y = 分组头中心的视口纵坐标) */
    reorder: (key: string, sectionId: string, y: number) => begin(key, sectionId, y),
    /** 触屏长按窗口内 / 拖拽中为 true:调用方据此不在分组头上重复弹菜单(也照旧掐掉原生菜单) */
    isBusy: () => !!dragRef.current || !!pending.current,
    /** 分组头 onClick 开头调用:拖拽刚结束时的那次 click 要吞掉 */
    wasDragging: () => swallow.current
  };
}
