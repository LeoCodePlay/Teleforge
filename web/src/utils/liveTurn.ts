// 「压缩完成后重拉历史」时保住本轮正在流式的回复气泡。
//
// 线上现象(用户原话):在一个会话里点了手动压缩,摘要还在生成时又发了一条任务(界面显示
// 「等待执行」)。压缩成功后那条任务确实离开了待执行队列、消息也上屏了,但 agent 再也没回复
// —— 等多久都没有,只能靠切会话/刷新才看到那条回复。
//
// 时序(两端都在同一瞬间动):
//  1) 服务端 compactNow 的 finally 复位 rt.compacting 后,立刻把压缩期间排队的消息派发出去
//     (pending -> inbox -> _drive),于是 `start` 事件马上发出、本轮的用户消息立刻落盘;
//  2) 同一个 finally 之前,服务端已广播 history_compacted,前端据此重拉 get_history 并
//     **整表替换**消息数组;
//  3) 重拉回来的历史此刻**还没有本轮的 assistant 行**(模型连第一个字都还没吐出来),
//     而 `start` 已经往列表里推过一个流式 assistant 气泡 —— 整表替换把它一起抹掉了。
//  4) 之后 text / reasoning / tool 增量与收尾都只认「末尾 assistant」(见 compactionOrder 的
//     tailAssistantIndex),而末尾现在成了本轮那条用户消息 → 整轮增量被**静默丢弃**:
//     屏幕上消息在了、回复永远不来。
//
// 这与「切回一个仍在运行中的会话」的历史回载是同一个坑:那条路径早就补了流式占位气泡
// (见 ChatPanel 历史载入的 busyRef 分支),压缩重拉这条路径漏了。
//
// 处置:重拉历史后,若当前列表里有一条正在流式的回复气泡(本轮还没收尾),就把它接回新历史 ——
// 历史里已经有本轮回复行时接着那行往下流(与切会话回载同一口径),历史里连本轮的用户行都还
// 没有时把整段本轮一起接回(否则回复会脱离它的提问)。
//
// 无 DOM/React 依赖,可单测。

import { mergeTrailingCommandCards, type CommandCardCarrier } from './commandCard.ts';
import { isRealUserRow, type CompactionRowCarrier } from './compactionOrder.ts';

/** 流式落点所需的最小行形状(与 compactionOrder 同款:不依赖前端 ChatMessage 具体结构) */
export interface LiveTurnRow extends CommandCardCarrier, CompactionRowCarrier {
  content?: string;
  /** 本轮回复气泡仍在下游流式写入中(收尾时置 false) */
  streaming?: boolean;
}

/** 末尾往前找第一个满足条件(含 role 判定)的行;找不到返回 -1 */
function lastIndexWhere<T>(list: T[], pred: (m: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return i;
  return -1;
}

/** 两条「真实用户消息」行是不是同一条(压缩标记行/命令卡不算;时间戳不同故只比正文) */
function sameUserRow(a: LiveTurnRow | undefined, b: LiveTurnRow | undefined): boolean {
  return isRealUserRow(a) && isRealUserRow(b) && (a!.content ?? '') === (b!.content ?? '');
}

/**
 * 整表重拉历史(压缩成功后的 history_compacted 重拉)时,保住本轮正在流式的回复气泡。
 *
 * @param history 服务端重拉出来的新历史(不含纯前端行)
 * @param current 当前渲染列表(可能已带本轮刚推入的用户气泡与流式回复气泡)
 * @param opts.turnClosed 本轮是否已收尾(done/error/stopped):已收尾则不做任何保活,
 *   否则一次陈旧的重放会让已完成的气泡又被点亮成流式
 * @returns 合并后的渲染列表(新历史 + 尾部命令卡 + 仍在流式的本轮内容)
 */
export function mergeHistoryKeepingLiveTurn<T extends LiveTurnRow>(
  history: T[] | null | undefined,
  current: T[] | null | undefined,
  opts: { turnClosed?: boolean } = {}
): T[] {
  const next = mergeTrailingCommandCards(history as T[], current as T[]);
  const cur = Array.isArray(current) ? current : [];
  if (opts.turnClosed) return next;
  // 当前列表里那条正在流式的回复气泡 = 本轮已经渲染中、绝不能丢的落点
  const liveIdx = lastIndexWhere(cur, (m) => !!m && m.role === 'assistant' && m.streaming === true);
  if (liveIdx < 0) return next;
  // 本轮的用户消息行(回复气泡要跟它一起走:历史里可能还没投影出它)
  const userIdx = lastIndexWhere(cur.slice(0, liveIdx), (m) => isRealUserRow(m));
  const liveRows = cur.slice(userIdx >= 0 ? userIdx : liveIdx);
  // 历史里已经有本轮的用户消息 → 本轮已经投影进历史;否则整段本轮(提问 + 回复)都要接回
  const histHasTurn = userIdx >= 0 && next.some((m) => sameUserRow(m as T, cur[userIdx]));
  if (!histHasTurn) return [...next, ...liveRows];
  const tail = next[next.length - 1];
  if (tail && tail.role === 'assistant') {
    // 历史末尾已经是本轮的回复行(模型已吐出过内容):接着它往下流,不重复生成一行
    return next.map((m, i) => (i === next.length - 1 ? { ...m, streaming: true } : m));
  }
  // 历史末尾是本轮的用户消息(模型还没输出任何内容 —— 本次故障的典型时序):
  // 把流式气泡接回,后续增量才有落点;不接回就等于把整轮回复静默丢弃。
  return [...next, ...cur.slice(liveIdx)];
}
