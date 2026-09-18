// 同一条回复内「多批附件」的合并规则(生图工具成图 / 用户上传 / 断线补发共用)。
//
// 成因:一次 run 里文本模型可以连续多次调用生成图片工具(例如一次画三张占位图),服务端会为
// 每次调用各落一条 image/generated 事件、各广播一条 image_done,历史回放时这些事件被投影成
// 同一气泡内相邻的多条 assistant 消息。早期实现用赋值把气泡 attachments 覆盖成「最新一批」,
// 于是后到的成图挤掉先到的——用户看到的症状就是「连续生成了三次,只显示一张图片」。
//
// 规则:按到达顺序累加(先到的在前),并按 id 去重——断线补偿会重放同一批附件,不能出现重复图。
// 无 DOM/React 依赖,可单测。
import type { AttachmentInfo } from '../types';

/**
 * 合并两批消息附件。
 * @param prev 气泡上已有的附件(可为空)
 * @param next 新到达的一批附件
 * @returns 累加去重后的附件;两批都为空时返回 undefined(调用方据此不写 attachments 字段)
 */
export function mergeAttachments<T extends AttachmentInfo>(prev?: T[] | null, next?: T[] | null): T[] | undefined {
  if (!next?.length) return prev?.length ? prev : undefined;
  if (!prev?.length) return next;
  const seen = new Set(prev.map((a) => a.id));
  return [...prev, ...next.filter((a) => !seen.has(a.id))];
}
