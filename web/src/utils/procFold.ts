// 过程折叠的**收起时机**(对齐 dsh 0.2.1-rc 的 collapseTiming:上游 a0a9aef5ec + 61112eab8f)。
//
// dsh 的「工作详情」有两档收起时机:
//   completion —— 回合结束就收起(默认,也是本项目原有行为);
//   next-input —— 结束的这一轮先敞着,**等你发下一条消息**再收起。
// 偏好只决定**默认开合**:用户手动点过折叠行的轮次一律以手动选择为准
// (判定见 utils/turnTail 的 latestFoldOwner 与 ChatPanel 渲染处的 foldOpen)。
//
// 与对话字号(utils/chatFont)同一套形态:localStorage 持久化 + 订阅通知,
// 设置面板与渲染处共用一份状态,不存在两处各读一次存储的口径漂移。
const STORAGE_KEY = 'teleforge.proc.fold.v1';

/** 可选时机(与 dsh 的 COLLAPSE_TIMINGS 逐字一致) */
export const PROC_FOLD_TIMINGS = ['completion', 'next-input'] as const;
export type ProcFoldTiming = typeof PROC_FOLD_TIMINGS[number];
export const PROC_FOLD_DEFAULT: ProcFoldTiming = 'completion';

const listeners = new Set<(timing: ProcFoldTiming) => void>();
let current: ProcFoldTiming = PROC_FOLD_DEFAULT;

/** 读持久化的时机;非法值一律回落默认(手改 localStorage 也不该把界面搞坏) */
export function readProcFoldTiming(): ProcFoldTiming {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'completion' || raw === 'next-input') return raw;
  } catch { /* 隐私模式 / 存储禁用:用默认值 */ }
  return PROC_FOLD_DEFAULT;
}

/** 当前生效时机(不读存储,避免每次渲染都碰 localStorage) */
export function currentProcFoldTiming(): ProcFoldTiming {
  return current;
}

/** 切到指定时机并持久化;返回真正生效的值 */
export function applyProcFoldTiming(timing: ProcFoldTiming, persist = true): ProcFoldTiming {
  current = timing === 'next-input' ? 'next-input' : 'completion';
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, current); } catch { /* 存不下就只在本次会话生效 */ }
  }
  for (const fn of listeners) fn(current);
  return current;
}

/** 订阅时机变化(设置面板据此重绘) */
export function onProcFoldTimingChange(fn: (timing: ProcFoldTiming) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
