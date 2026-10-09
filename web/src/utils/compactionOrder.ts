// 压缩标记行的对话流位置(与 ChatPanel 的渲染/流式落点相关,纯函数可单测)。
//
// 需求:压缩记录(手动 /compact 与自动压缩)在**压缩发生那一刻**落在当时最后一条消息之后,
// 让用户一眼看到「已压缩 N 条早期消息」的成功/失败;之后的新消息继续排在它下面,
// 它作为普通历史记录固定在那里 —— 刷新 / 切回会话后位置不变,既不飘到保留区之前,
// 也不每次重载都被搬到最底部(那是被否决的旧实现)。
//
// 位置由服务端 projectEvents 按**事件日志原位投影**决定(compaction/done 追加在日志尾时
// 就等于"当时最后一条消息之后"),前端不再重排。这里只保留流式落点所需的纯函数。
//
// 约束:标记行可能排在流式 assistant 之后(断线补发等路径)—— 流式增量 / 工具结果 /
// 收尾必须跳过它,仍落到本轮那条 assistant 上,否则整段增量会被静默丢弃(见 tailAssistantIndex)。
//
// 「模型请求失败进入重试」的提示行同样由这里的纯函数决定落点(见 applyRetryNotice):
// 它必须落在**失败发生的那一刻** —— 当前回复气泡在失败点收尾,提示行紧随其后,重试成功后
// 的增量写回提示行下面的新气泡,而不是永远贴在整轮回复的最下面。断线补发等路径仍可能让
// 提示行成为尾部行(本轮已收尾时),所以 isTrailingRow 依旧把它一并跳过。
//
// 无 DOM/React 依赖,可单测。
import type { ChatMessage } from '../types';

/** 只要求带可选 compaction/retry 字段与 role,避免 util 依赖前端 ChatMessage 具体形状 */
export interface CompactionRowCarrier {
  compaction?: unknown;
  role?: string;
  retry?: unknown;
  /** 斜杠命令卡(role 同样是 'user') */
  command?: unknown;
}

/** 是不是「真正的用户消息」行。
 *  压缩标记行(compaction)与斜杠命令卡(command)的 role 同样是 'user',但它们**不是新一轮
 *  对话的起点**。若把它们当成轮次分界,夹在它们后面的重试行就永远找不到「同轮已有的那一行」,
 *  于是每次重试都新增一行、一路堆在末尾(长会话里出现自动压缩后必然踩到)。 */
export function isRealUserRow(m: CompactionRowCarrier | undefined): boolean {
  return !!m && m.role === 'user' && !m.compaction && !m.command;
}

/** 流式落点需要跳过的尾部行:压缩标记行、重试提示行 */
function isTrailingRow(m: CompactionRowCarrier | undefined): boolean {
  if (!m) return false;
  if (m.compaction) return true;
  return m.role === 'notice' && !!m.retry;
}

/**
 * 本轮回复气泡(最后一条 assistant)的下标:跳过尾部的压缩标记行与重试提示行。
 * 语义与原实现一致 —— 只跳过尾部标记行,其余情况仍要求最后一条非标记行是 assistant,
 * 否则返回 -1(不做任何落点)。
 */
export function tailAssistantIndex(msgs: CompactionRowCarrier[]): number {
  let i = msgs.length - 1;
  while (i >= 0 && isTrailingRow(msgs[i])) i -= 1;
  return i >= 0 && msgs[i]?.role === 'assistant' ? i : -1;
}

/** 一次「模型请求失败进入重试」事件在消息流里的落点信息 */
export interface RetryNoticeInput {
  /** 连续失败阶段的标识;恢复输出后再次失败会生成新标识 */
  retryGroup?: string;
  /** 当前第几次重试(从 1 起) */
  retry: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 本次重试前的等待时长(ms);换 Key 时为 0(立即重发,不等待) */
  delayMs: number;
  /** 上次失败的简要原因 */
  error: string;
  /** 失败前已流出过半成品(调用方已按 utils/rollbackPartial 回滚),用于在详情里披露 */
  discard?: boolean;
  /** 'switch' = 只是切换到下一个 API Key(不等待);缺省/'retry' = 退避后重发 */
  kind?: 'retry' | 'switch';
}

export interface RetryNoticeOptions {
  /** 本轮是否已收尾:已收尾的陈旧重试事件不拆开历史气泡,只留一行记录 */
  turnClosed: boolean;
  /** 新起气泡的分支点下标(消息面下标,通常取重试行占用的那个) */
  forkFaceIdx: number;
}

/**
 * 把重试提示行落到**失败发生的那一刻**。规则:
 *  - 同一连续失败阶段已有重试行 → 原地更新计数与失败原因;
 *  - 恢复输出后再次失败 → 保留旧记录,当前流式气泡在失败点收尾,插入新重试行和新气泡;
 *  - 本轮首次重试 → 当前流式气泡在失败点收尾,插入重试行,再起一个新的流式气泡,
 *    重试成功后接上来的增量因此落在提示行**下面**,历史回放(turnsToMessages)同一口径;
 *  - 本轮已收尾 → 只追加一行记录,不拆历史气泡。
 *
 * 调用方需先处理 discard 半成品回滚(见 utils/rollbackPartial),再调用本函数。
 */
export function applyRetryNotice(
  msgs: ChatMessage[],
  input: RetryNoticeInput,
  opts: RetryNoticeOptions
): ChatMessage[] {
  const payload = { ...input, discard: input.discard === true, state: 'scheduled' as const };
  const c = [...msgs];
  // 分组标识支持半成品已回滚与断线补发;旧事件则按恢复输出的位置划分。
  const rowIdx = ((): number => {
    let resumed = false;
    for (let i = c.length - 1; i >= 0; i--) {
      if (isRealUserRow(c[i])) break;
      const msg = c[i];
      if (msg.role === 'assistant' && ((msg.segments || []).length || (msg.attachments || []).length)) resumed = true;
      if (msg.role === 'notice' && msg.retry) {
        if (input.retryGroup && msg.retry.retryGroup) {
          if (input.retryGroup === msg.retry.retryGroup) return i;
          continue;
        }
        return !resumed && msg.retry.state !== 'started' ? i : -1;
      }
    }
    return -1;
  })();
  if (rowIdx >= 0) {
    c[rowIdx] = { role: 'notice', content: '', retry: payload };
    // 本轮回复仍在进行中:重试只是这一步重发,不是对话结束,必须保持 streaming=true,
    // 否则渲染层会把收尾产物(已修改文件卡 / 复制 / 分支按钮)当成对话已结束显示出来。
    if (!opts.turnClosed) {
      for (let i = c.length - 1; i >= 0; i--) {
        if (c[i]?.role === 'assistant') { c[i] = { ...c[i], streaming: true }; break; }
      }
    }
    return c;
  }
  const row: ChatMessage = { role: 'notice', content: '', retry: payload };
  const li = tailAssistantIndex(c);
  const tail = li >= 0 ? c[li] : undefined;
  if (tail && tail.streaming) {
    // 失败点分界:旧气泡收尾 → 重试行 → 新流式气泡
    const fresh: ChatMessage = {
      role: 'assistant', segments: [], streaming: true,
      forkTail: Math.max(0, opts.forkFaceIdx), stepSegBase: 0
    };
    // 本轮还没产出任何内容(刚开场就失败):空气泡没有意义,直接用重试行占它的位置,
    // 与历史投影(user → 重试行 → assistant)保持一致,避免多出一个空白气泡。
    if (!(tail.segments && tail.segments.length) && !(tail.attachments && tail.attachments.length)) {
      c.splice(li, 1, row, fresh);
    } else {
      c[li] = { ...tail, streaming: false };
      c.splice(li + 1, 0, row, fresh);
    }
  } else if (!opts.turnClosed) {
    // 本轮还没产出气泡(极端时序):提示行在前,内容流进后面的新气泡
    c.push(row, {
      role: 'assistant', segments: [], streaming: true,
      forkTail: Math.max(0, opts.forkFaceIdx), stepSegBase: 0
    });
  } else {
    c.push(row);
  }
  return c;
}
