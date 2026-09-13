import type { ChatMessage, MsgSegment } from '../types';

/**
 * 回滚「本步」已流出但尚未落盘的半成品段。
 *
 * 背景:模型请求中途失败(网关掐断连接 / 响应流被截断)时会自动重发这一步。重试前的
 * 那半句已经通过 text_delta / reasoning_delta 画到界面上了,如果不作废,重试成功后的
 * 正文就会接在它后面,出现重复内容。
 *
 * 做法:截断到本步起点(msg.stepSegBase,由 iteration 事件写入)。每一步只要有工具调用
 * 就必然以 tools 段落盘收尾,所以本步的增量一定追加在那个 tools 段之后,「截断到起点」
 * 能精确切掉半成品,不会碰到前面步骤已经落定的正文与工具卡片。
 *
 * 缺起点时(例如历史回放后的消息没有 stepSegBase)退化为丢掉尾部所有非 tools 段。
 */
export function rollbackPartialSegments(msg: Pick<ChatMessage, 'segments' | 'stepSegBase'>): MsgSegment[] {
  const segs = msg.segments || [];
  const base = msg.stepSegBase;
  if (typeof base === 'number' && base >= 0 && base <= segs.length) return segs.slice(0, base);
  let end = segs.length;
  while (end > 0 && segs[end - 1].kind !== 'tools') end--;
  return segs.slice(0, end);
}
