// 斜杠命令卡(role='command',前端本地插入、不持久化)在「整表重拉历史」后的去留规则。
//
// 成因:/compact 压缩成功时服务端广播 history_compacted,前端据此重拉历史并整表替换
// 消息数组(压缩后的 turns 里没有命令卡这一条)。命令卡随之被抹掉,用户只看到
// 「正在压缩当前会话上下文…」凭空消失——紧随其后的 patchCmd(cmdId, ok) 要么打在
// 一个即将被替换的数组上,要么因 cmdId 已不存在而变成空操作,底部看不到任何成功反馈。
// 而压缩成功的持久披露行(CompactionRow)按设计插在「压缩边界」那条消息之前,长会话里
// 往往在视口上方几百条消息处,底部的用户同样看不到。
//
// 规则:重拉历史时,把当前列表**末尾连续的命令卡**按原样接回新历史之后。只取末尾连续段
// (而不是全表扫描)有两个原因:命令卡正常总在尾部;多点几次 /compact 也不会把上一轮
// 的旧卡片累积堆叠进来。接回时保留 cmdId 与状态,因此 patchCmd 仍能命中并落完成态;
// 用函数式 setMessages 读取最新 messages,则「先 patch 后重拉」与「先重拉后 patch」两种
// 时序都不会丢结果。
//
// 无 DOM/React 依赖,可单测。

/** 只要求带 command 字段,避免 util 依赖前端 ChatMessage 具体形状 */
export interface CommandCardCarrier {
  command?: unknown;
}

/**
 * 重拉历史时保留尾部命令卡。
 * @param history 服务端重拉出来的新历史(不含命令卡)
 * @param current 当前渲染列表(可能已带命令卡与最新状态)
 * @returns 新历史 + 末尾连续命令卡(没有命令卡时原样返回新历史)
 */
export function mergeTrailingCommandCards<T extends CommandCardCarrier>(history: T[], current: T[]): T[] {
  const hist = Array.isArray(history) ? history : [];
  const cur = Array.isArray(current) ? current : [];
  let start = cur.length;
  while (start > 0 && cur[start - 1] && cur[start - 1].command) start -= 1;
  const cards = cur.slice(start);
  return cards.length ? [...hist, ...cards] : hist;
}
