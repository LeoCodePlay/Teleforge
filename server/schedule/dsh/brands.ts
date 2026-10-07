/**
 * dsh 的 brand 类型在本项目里的等价物(`web/src/dsh-adapters/brand` 是前端那份,
 * 这里给服务端用)。dsh 用 `Branded<'X'>` 把裸字符串标成"有语义的 id",构造器只在
 * 通过校验的地方调用。
 *
 * 迁移说明:本文件是实现 **逐字照搬 deepseek-harness 的
 * `packages/schedule/schedule/src/*`** 时唯一新增的胶水之一,其余文件保持字节一致。
 */

/** 带标记的字符串:dsh `@deepseek-ai/dsh-brand` 的 `Branded<T>` 等价物 */
export type Branded<K extends string> = string & { readonly __brand: K }

/** 全局唯一的提醒 id(存储键与协议字段都用它) */
export type ScheduleId = Branded<'ScheduleId'>

/** 会话 id:本项目由 server/store/session-store.ts 生成 */
export type SessionId = Branded<'SessionId'>

/** 消息 id:投递回执里的 messageId,本项目用会话事件里的消息身份 */
export type MessageId = Branded<'MessageId'>

/** 构造提醒 id(调用方负责保证非空;dsh 侧由 zod 校验) */
export const ScheduleId = (value: string): ScheduleId => value as ScheduleId

/** 构造会话 id */
export const SessionId = (value: string): SessionId => value as SessionId

/** 构造消息 id */
export const MessageId = (value: string): MessageId => value as MessageId
