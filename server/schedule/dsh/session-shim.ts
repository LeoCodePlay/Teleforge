/**
 * dsh `@deepseek-ai/dsh-session` 在本项目里的等价物 —— 只提供 dsh schedule 源码
 * (domain.ts 的事件折叠)用到的那两个符号,避免为了两个符号把整套 session 包搬进来。
 *
 * 迁移说明:与 `brands.ts` 一样,这是"照搬 dsh 源码"的胶水之一。
 */

/** 会话日志序号(与 SessionLogOffset 同源,只是语义更窄) */
export const SessionSeq = (value: number): number => value

/** 会话日志偏移量(本项目的事件 seq 就是日志下标,直接以数字表示) */
export type SessionLogOffset = number & { readonly __brand: 'SessionLogOffset' }

/** 构造日志偏移量 */
export const SessionLogOffset = (value: number): SessionLogOffset => value as SessionLogOffset

/**
 * 会话事件的最小形状:
 * `foldScheduleEvents` 只读 `type` 与 `data`(以及用来算偏移的下标),因此这里保持宽松。
 * 本项目的真实事件类型见 server/agent/session.ts(带 seq/time/type/data)。
 */
export interface SessionEvent {
  readonly seq?: number
  readonly type: string
  readonly data?: unknown
}
