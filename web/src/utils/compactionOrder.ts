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
// 同一约束也适用于「模型请求失败进入重试」的提示行:它必须排在当前回复气泡**之后**
// (用户要求:重试消息跟在已输出的最新内容下面,而不是顶到回复最上面),于是它也成了
// assistant 之后的尾部行。若不在这里一并跳过,重试后接上来的增量就全部找不到落点。
//
// 无 DOM/React 依赖,可单测。

/** 只要求带可选 compaction/retry 字段与 role,避免 util 依赖前端 ChatMessage 具体形状 */
export interface CompactionRowCarrier {
  compaction?: unknown;
  role?: string;
  retry?: unknown;
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
