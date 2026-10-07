// 规则预览:只算时间、不落库。**用与调度完全同一份 domain.ts**(逐字移植自 dsh),
// 所以"编辑器里显示的下一次运行"必然等于调度器真正会跑的时刻 —— 前端自己重写一份时间逻辑
// 才是两套行为、迟早对不上的根源。
//
// 入参就是 dsh 的创建选择器形状(`after_seconds` / `at` / `every_seconds` / `daily` / `weekly` / `cron`),
// 因此校验口径(时区合法性、`HH:mm:ss` 规范化、cron 子集、every 下限)与真实创建逐字一致。
import {
  createAfterScheduleRecord, createAtScheduleRecord, createCronScheduleRecord, createDailyScheduleRecord,
  createEveryScheduleRecord, createWeeklyScheduleRecord, isRecurringScheduleRecord, resolveRecurringOccurrence,
  ScheduleId, ScheduleInputError,
} from '../../schedule/dsh/domain.ts'
import type { AtInput, CronInput, DailyInput, ScheduleRecord, WeeklyInput } from '../../schedule/dsh/types.ts'

/** 预览入参 = dsh 的创建选择器(一次只能给一个) */
export interface ScheduleRule {
  after_seconds?: number
  at?: AtInput
  every_seconds?: number
  daily?: DailyInput
  weekly?: WeeklyInput
  cron?: CronInput
}

export interface SchedulePreview {
  kind: ScheduleRecord['kind']
  /** 首次触发(RFC3339 UTC) */
  scheduledAt: string
  /** 首次 + 接下来若干次(一次性规则只有一条) */
  next: string[]
}

const PREVIEW_ID = ScheduleId('schedule-preview')

/**
 * 算首次触发与后续若干次。
 * @param rule dsh 形状的规则
 * @param now 决策时刻
 * @param count 最多返回几次(含首次)
 */
export function previewRule(rule: ScheduleRule, now: number, count = 5): SchedulePreview {
  const want = Math.min(20, Math.max(1, Math.floor(count) || 1))
  const title = 'preview'
  const prompt = 'preview'
  let record: ScheduleRecord
  if (rule?.at !== undefined) record = createAtScheduleRecord(PREVIEW_ID, prompt, rule.at, now, title)
  else if (rule?.after_seconds !== undefined) record = createAfterScheduleRecord(PREVIEW_ID, prompt, rule.after_seconds, now, title)
  else if (rule?.every_seconds !== undefined) record = createEveryScheduleRecord(PREVIEW_ID, prompt, rule.every_seconds, now, title)
  else if (rule?.daily !== undefined) record = createDailyScheduleRecord(PREVIEW_ID, prompt, rule.daily, now, title)
  else if (rule?.weekly !== undefined) record = createWeeklyScheduleRecord(PREVIEW_ID, prompt, rule.weekly, now, title)
  else if (rule?.cron !== undefined) record = createCronScheduleRecord(PREVIEW_ID, prompt, rule.cron, now, title)
  else throw new ScheduleInputError('invalid_selector', 'Exactly one reminder selector is required.')

  const next = [record.scheduledAt]
  if (isRecurringScheduleRecord(record)) {
    let cursor: ScheduleRecord = record
    for (let i = 1; i < want; i++) {
      // 传入时刻 = 当前这一跳本身:返回的就是"该时刻这一次 + 之后第一次",据此往前推
      const occurrence = resolveRecurringOccurrence(cursor as never, Date.parse(cursor.scheduledAt))
      if (occurrence.nextScheduledAt === undefined) break
      next.push(occurrence.nextScheduledAt)
      cursor = { ...cursor, scheduledAt: occurrence.nextScheduledAt }
    }
  }
  return { kind: record.kind, scheduledAt: record.scheduledAt, next }
}
