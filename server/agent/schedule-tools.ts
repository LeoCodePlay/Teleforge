/**
 * 模型工具:`schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`。
 *
 * **逐字对应 dsh `packages/schedule/tool-schedule/src/index.ts`**:工具名、描述文案、入参校验、
 * 返回值(规范 JSON)、错误码与拒绝理由都照抄。三处因宿主不同而必需的适配:
 *   1. dsh 用 `defineTool` + 属性表参数 + 输出 schema(zod 式校验);本项目用 ToolRegistry 的
 *      JSON-Schema 形式,输出不做二次校验(模型看的内容仍是同一个 `JSON.stringify(value)`);
 *   2. dsh 判"调用者是子代理"用 `delegationDepthOf(agent) > 0`;本项目判"这个会话 id 不是真实会话"
 *      (子代理运行的会话不在会话表里)—— 结论相同:子代理不能用定时任务;
 *   3. dsh 的 `presentCall`(工具卡标题)本项目没有对应物,交给前端 GenericToolCard 渲染。
 */
import * as sessions from '../store/session-store.ts'
import { getScheduleService } from '../schedule/holder.ts'
import {
  MAX_TITLE_LENGTH, MIN_EVERY_INTERVAL_SECONDS, REQUIRED_TITLE_MESSAGE, ScheduleId, ScheduleInputError, scheduleView,
} from '../schedule/dsh/domain.ts'
import type {
  AtInput, CronInput, DailyInput, WeeklyInput, ScheduleCreateValue, ScheduleDeleteValue,
  ScheduleListValue, ScheduleTimingChange, ScheduleToolError, ScheduleUpdateValue,
} from '../schedule/dsh/types.ts'
import type { ToolAccess, ToolDef, ToolRegistry } from './registry.ts'

/** 建/改/删都在改持久状态:按写类处理(plan 模式拒绝,confirm 模式要审批) */
const ACCESS: ToolAccess = 'write'

// ---- dsh 原文的四个描述(模型看到的契约,逐字保留) ----
const CREATE_DESCRIPTION =
  'Create a reminder in the current session that delivers prompt when it becomes due. '
  + 'Supply exactly one timing parameter: after_seconds, at, every_seconds, daily, weekly, or cron. '
  + 'Local times that do not exist in the zone are skipped; repeated local times fire once, at the earlier instant. '
  + 'After downtime, a recurring reminder delivers only its latest missed occurrence. Delivery can repeat after a crash.'

const LIST_DESCRIPTION = 'List the active reminders in the current session.'

const DELETE_DESCRIPTION =
  'Delete a reminder in the current session, active or inactive. Deletion does not retract a reminder message that is already queued.'

const UPDATE_DESCRIPTION =
  'Change a reminder in place, keeping its id. Supply a new title, prompt, or at most one timing parameter; '
  + 'omitted fields keep their stored values. To change a relative delay, create a new reminder.'

/** dsh:有内容就原样 JSON 输出(渲染由 ToolRuntime 负责) */
function renderValue(value: unknown): { content: string } {
  return { content: JSON.stringify(value) }
}

/** dsh `internalError()` */
function internalError(): ScheduleToolError {
  return { code: 'internal_error', message: 'The schedule operation failed.' }
}

/** dsh `operationError()`:输入错误照实回,内部存储故障一律 internal_error */
function operationError(error: unknown): ScheduleToolError {
  return error instanceof ScheduleInputError ? { code: error.code, message: error.message } : internalError()
}

/** dsh `subagentCallerRefusal()`:子代理不能用定时任务(理由见文件头第 2 条) */
function subagentCallerRefusal(sid: string | null | undefined): ScheduleToolError | undefined {
  if (sid && sessions.list().some((s) => s.id === sid)) return undefined
  return { code: 'subagent_session', message: 'A delegated subagent cannot use reminders.' }
}

/** dsh `invalidInterval()` */
function invalidInterval(everySeconds: number | undefined): ScheduleToolError | undefined {
  if (everySeconds === undefined) return undefined
  if (!Number.isSafeInteger(everySeconds)) {
    return { code: 'invalid_rule', message: 'every_seconds must be a safe integer.' }
  }
  if (everySeconds < MIN_EVERY_INTERVAL_SECONDS) {
    return { code: 'frequency_too_high', message: `every_seconds must be at least ${MIN_EVERY_INTERVAL_SECONDS}.` }
  }
  return undefined
}

/** dsh `validateCreateArgs()` */
function validateCreateArgs(args: { prompt: string; title: string; after_seconds?: number; at?: AtInput; every_seconds?: number; daily?: DailyInput; weekly?: WeeklyInput; cron?: CronInput }): ScheduleToolError | undefined {
  const keys = Object.keys(args)
  if (keys.some((key) => key !== 'prompt' && key !== 'title' && key !== 'after_seconds' && key !== 'at'
    && key !== 'every_seconds' && key !== 'daily' && key !== 'weekly' && key !== 'cron')
    || Number(args.after_seconds !== undefined)
    + Number(args.at !== undefined)
    + Number(args.every_seconds !== undefined)
    + Number(args.daily !== undefined)
    + Number(args.weekly !== undefined)
    + Number(args.cron !== undefined) !== 1) {
    return { code: 'invalid_selector', message: 'schedule_create accepts exactly one of after_seconds, at, every_seconds, daily, weekly, or cron.' }
  }
  if (args.prompt.trim().length === 0) return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' }
  if (args.title.trim().length === 0) return { code: 'invalid_prompt', message: REQUIRED_TITLE_MESSAGE }
  if (args.title.trim().length > MAX_TITLE_LENGTH) {
    return { code: 'invalid_prompt', message: `title must be at most ${MAX_TITLE_LENGTH} characters.` }
  }
  if (args.after_seconds !== undefined && (!Number.isSafeInteger(args.after_seconds) || args.after_seconds <= 0)) {
    return { code: 'invalid_rule', message: 'after_seconds must be a positive safe integer.' }
  }
  return invalidInterval(args.every_seconds)
}

/** dsh `validateUpdateArgs()` */
function validateUpdateArgs(args: { id: string; title?: string; prompt?: string; at?: AtInput; every_seconds?: number; daily?: DailyInput; weekly?: WeeklyInput; cron?: CronInput }): ScheduleToolError | undefined {
  const selectors = [args.at, args.every_seconds, args.daily, args.weekly, args.cron].filter((v) => v !== undefined).length
  if (Object.keys(args).some((key) => key !== 'id' && key !== 'title' && key !== 'prompt' && key !== 'at'
    && key !== 'every_seconds' && key !== 'daily' && key !== 'weekly' && key !== 'cron') || selectors > 1) {
    return { code: 'invalid_selector', message: 'schedule_update accepts at most one of at, every_seconds, daily, weekly, or cron.' }
  }
  if (args.id.length === 0 || args.id.trim() !== args.id) {
    return { code: 'invalid_rule', message: 'schedule_update id must be non-empty without surrounding whitespace.' }
  }
  if (selectors === 0 && args.title === undefined && args.prompt === undefined) {
    return { code: 'invalid_selector', message: 'schedule_update needs a new title, prompt, or one of at, every_seconds, daily, weekly, or cron.' }
  }
  if (args.title !== undefined && args.title.trim().length === 0) return { code: 'invalid_prompt', message: REQUIRED_TITLE_MESSAGE }
  if (args.title !== undefined && args.title.trim().length > MAX_TITLE_LENGTH) {
    return { code: 'invalid_prompt', message: `title must be at most ${MAX_TITLE_LENGTH} characters.` }
  }
  if (args.prompt !== undefined && args.prompt.trim().length === 0) {
    return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' }
  }
  return invalidInterval(args.every_seconds)
}

/** dsh `timingChangeFrom()` */
function timingChangeFrom(args: { at?: AtInput; every_seconds?: number; daily?: DailyInput; weekly?: WeeklyInput; cron?: CronInput }): ScheduleTimingChange | undefined {
  if (args.at !== undefined) return { kind: 'at', at: args.at }
  if (args.every_seconds !== undefined) return { kind: 'every', every_seconds: args.every_seconds }
  if (args.daily !== undefined) return { kind: 'daily', daily: args.daily }
  if (args.weekly !== undefined) return { kind: 'weekly', weekly: args.weekly }
  if (args.cron !== undefined) return { kind: 'cron', cron: args.cron }
  return undefined
}

// ---- dsh SELECTOR_PARAMETERS 的 JSON-Schema 等价形式(描述逐字) ----
const TIME_PARAMETER_DESCRIPTION = 'HH:mm:ss with optional 1-3 fractional digits, for example 23:00:00.'
const ZONE_PARAMETER_DESCRIPTION = 'UTC or IANA Area/Location, for example Asia/Shanghai.'

const SELECTOR_PROPERTIES = {
  every_seconds: {
    type: 'number',
    description: `Fixed-rate interval in whole seconds, at least ${MIN_EVERY_INTERVAL_SECONDS}, aligned to the creation time; changing it with schedule_update re-aligns it to the save time.`,
  },
  daily: {
    type: 'object',
    additionalProperties: false,
    description: 'Every day at a local time.',
    properties: {
      time: { type: 'string', description: TIME_PARAMETER_DESCRIPTION },
      time_zone: { type: 'string', description: ZONE_PARAMETER_DESCRIPTION },
    },
    required: ['time', 'time_zone'],
  },
  weekly: {
    type: 'object',
    additionalProperties: false,
    description: 'On the given weekdays at a local time.',
    properties: {
      time: { type: 'string', description: 'HH:mm:ss with optional 1-3 fractional digits, for example 09:00:00.' },
      time_zone: { type: 'string', description: ZONE_PARAMETER_DESCRIPTION },
      weekdays: {
        type: 'array',
        description: 'ISO weekdays, Monday 1 through Sunday 7, without repetitions.',
        items: { type: 'integer' },
      },
    },
    required: ['time', 'time_zone', 'weekdays'],
  },
  cron: {
    type: 'object',
    additionalProperties: false,
    description: 'Five-field Vixie cron expression in a time zone.',
    properties: {
      expression: {
        type: 'string',
        description: 'minute hour day-of-month month day-of-week, for example "*/15 9-17 * * 1-5". '
          + 'When both day fields are restricted, a date matches if either one matches.',
      },
      time_zone: { type: 'string', description: ZONE_PARAMETER_DESCRIPTION },
    },
    required: ['expression', 'time_zone'],
  },
  at: {
    description: 'Absolute target: an RFC 3339 date-time with offset, or a local date, time, and IANA time_zone.',
    oneOf: [
      { type: 'string' },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string' },
          time: { type: 'string' },
          time_zone: { type: 'string' },
        },
        required: ['date', 'time', 'time_zone'],
      },
    ],
  },
} as const

export function registerScheduleTools(registry: ToolRegistry): void {
  const sidOf = (ctx: any): string | null => {
    const sid = ctx?.sid ?? ctx?.session?.id ?? null
    return sid ? String(sid) : null
  }

  const defs: ToolDef[] = [
    {
      name: 'schedule_create',
      description: CREATE_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', description: 'Reminder content to present when the target becomes due.' },
          title: { type: 'string', description: `Task name of at most ${MAX_TITLE_LENGTH} characters, shown on the task card and in task lists.` },
          after_seconds: { type: 'number', description: 'Delay in whole seconds.' },
          ...SELECTOR_PROPERTIES,
        },
        required: ['prompt', 'title'],
      },
      concurrencySafe: false,
      access: ACCESS,
      run: async (args: any, ctx: any) => {
        const sid = sidOf(ctx)
        const refusal = subagentCallerRefusal(sid)
        if (refusal !== undefined) return renderValue(refusal)
        const invalid = validateCreateArgs(args)
        if (invalid !== undefined) return renderValue(invalid)
        const service = getScheduleService()
        if (service === undefined) return renderValue(internalError())
        try {
          const value: ScheduleCreateValue = scheduleView(await service.create(String(sid), args), Date.now())
          return renderValue(value)
        } catch (error: unknown) {
          return renderValue(operationError(error))
        }
      },
    },
    {
      name: 'schedule_list',
      description: LIST_DESCRIPTION,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      concurrencySafe: true,
      access: ACCESS,
      run: async (_args: any, ctx: any) => {
        const sid = sidOf(ctx)
        const refusal = subagentCallerRefusal(sid)
        if (refusal !== undefined) return renderValue(refusal)
        const service = getScheduleService()
        if (service === undefined) return renderValue(internalError())
        try {
          const records = await service.list({ sessionId: sid as any })
          const value: ScheduleListValue = records.map((record) => scheduleView(record, Date.now()))
          return renderValue(value)
        } catch (error: unknown) {
          return renderValue(operationError(error))
        }
      },
    },
    {
      name: 'schedule_delete',
      description: DELETE_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: 'Exact schedule id.' } },
        required: ['id'],
      },
      concurrencySafe: false,
      access: ACCESS,
      run: async (args: any, ctx: any) => {
        if (String(args?.id ?? '').length === 0 || String(args.id).trim() !== String(args.id)) {
          return renderValue({ code: 'invalid_rule', message: 'schedule_delete id must be non-empty without surrounding whitespace.' })
        }
        const sid = sidOf(ctx)
        const refusal = subagentCallerRefusal(sid)
        if (refusal !== undefined) return renderValue(refusal)
        const service = getScheduleService()
        if (service === undefined) return renderValue(internalError())
        try {
          const value: ScheduleDeleteValue = await service.delete({ sessionId: sid as any, id: ScheduleId(String(args.id)) })
          return renderValue(value)
        } catch (error: unknown) {
          return renderValue(operationError(error))
        }
      },
    },
    {
      name: 'schedule_update',
      description: UPDATE_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Schedule id returned by schedule_list.' },
          title: { type: 'string', description: `New task name of at most ${MAX_TITLE_LENGTH} characters.` },
          prompt: { type: 'string', description: 'New reminder content.' },
          ...SELECTOR_PROPERTIES,
        },
        required: ['id'],
      },
      concurrencySafe: false,
      access: ACCESS,
      run: async (args: any, ctx: any) => {
        const sid = sidOf(ctx)
        const refusal = subagentCallerRefusal(sid)
        if (refusal !== undefined) return renderValue(refusal)
        const invalid = validateUpdateArgs(args)
        if (invalid !== undefined) return renderValue(invalid)
        const id = ScheduleId(String(args.id))
        const service = getScheduleService()
        if (service === undefined) return renderValue(internalError())
        try {
          const sessionId = String(sid)
          // dsh:先从**启用中**列表里取 expected(乐观并发用的"开始编辑时那条记录"),
          // 取不到再看 catalog 判断是"已结束"还是"不存在"(tool-schedule:557-565)
          const expected = (await service.list({ sessionId: sessionId as any })).find((record) => record.id === id)
          if (expected === undefined) {
            const ended = (await service.catalog()).some((entry) => String(entry.sessionId) === sessionId && entry.id === id)
            return renderValue({ id, updated: false, code: ended ? 'schedule_ended' : 'schedule_not_found' })
          }
          const change = timingChangeFrom(args)
          const result = await service.update({
            sessionId: sessionId as any,
            id,
            expected,
            ...(change === undefined ? {} : { change }),
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
          })
          const value: ScheduleUpdateValue = 'record' in result ? scheduleView(result.record, Date.now()) : result
          return renderValue(value)
        } catch (error: unknown) {
          return renderValue(operationError(error))
        }
      },
    },
  ]

  for (const def of defs) registry.register(def)
}
