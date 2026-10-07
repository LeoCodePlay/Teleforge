/** Durable Host-wide Schedule tasks, independently of Session activation. */
import { z } from 'zod'
// 迁移说明:dsh 这里从 session / llm / storage-domain 包取符号;本项目改用本地 shim
// (brands.ts),持久化由 server/schedule/store.ts 直接读写整个 JSON 文档。
import { SessionId, MessageId } from './brands.ts'
import { decodeScheduleRecord } from './domain.ts'
import type { ScheduleRecord } from './types.ts'

const recordSchema = z.unknown().transform((value, context): ScheduleRecord => {
  try {
    return decodeScheduleRecord(value)
  } catch (error: unknown) {
    context.addIssue({ code: 'custom', message: String(error) })
  }
  return z.NEVER
})

const instantSchema = z.iso.datetime({ precision: 3 }).refine(value => !value.startsWith('0000-'), {
  message: 'Expected a canonical four-digit-year UTC calendar instant',
})

const deliveryReceiptSchema = z.object({
  scheduledAt: instantSchema,
  deliveredAt: instantSchema,
  messageId: z.string().min(1).refine(value => value.trim() === value).transform(MessageId),
}).strict()

const deliveryHistorySchema = z.object({
  records: z.array(deliveryReceiptSchema.extend({ prompt: z.string().optional() }).strict()),
  earlierRecordsUnavailable: z.boolean(),
  earlierRecordsPruned: z.boolean().optional(),
}).strict().refine(history => new Set(history.records.map(record => record.messageId)).size === history.records.length, {
  message: 'Delivery history message identities must be unique within a task',
})

/** Stored task binds one schedule to its original Session; absent status decodes as active. */
export const scheduleTaskSchema = z.object({
  sessionId: z.string().min(1).transform(SessionId),
  record: recordSchema,
  status: z.enum(['active', 'inactive']).default('active'),
  lastDelivery: deliveryReceiptSchema.optional(),
  deliveryHistory: deliveryHistorySchema.optional(),
}).strict().refine((task) => {
  if (task.deliveryHistory === undefined) return true
  const latest = task.deliveryHistory.records.at(-1)
  if (latest === undefined) return task.lastDelivery === undefined
  return task.lastDelivery !== undefined
    && latest.scheduledAt === task.lastDelivery.scheduledAt
    && latest.deliveredAt === task.lastDelivery.deliveredAt
    && latest.messageId === task.lastDelivery.messageId
}, { message: 'Last delivery must match the latest saved delivery receipt' })

/** Persistent task value; absent history retains only its legacy last receipt without a read-time rewrite. */
export type ScheduleTask = z.infer<typeof scheduleTaskSchema>

/**
 * 读盘校验一行任务:坏记录**不允许静默通过**(与 dsh "坏记录拒绝打开 domain" 同一取向,
 * 见 storage-domain 的 invalid-record 语义)。整份文档由 server/schedule/store.ts 读写。
 */
export function parseScheduleTask(value: unknown): ScheduleTask {
  return scheduleTaskSchema.parse(value)
}

// 迁移说明:原文件末尾是 `defineDomain({ name: 'schedule', version: 1, tables: { tasks: domainTable(...) } })`。
// dsh 用 storage-domain 把任务存进一个 KV domain(JSON 后端落成单文档 schedule.json);
// 本项目没有那套 storage 装配,改由 server/schedule/store.ts 用**同样的 JSON 形状**
// (unit/global/tables.tasks) 直接读写该文件。上面三个 schema 原样保留 —— 它们承载了
// dsh 的持久层不变量(messageId 唯一、lastDelivery 必须等于历史最后一条、多余键拒绝)。
