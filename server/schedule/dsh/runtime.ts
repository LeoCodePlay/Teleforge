/** Host timer over stored tasks; Session activation is a delivery operation. */
// 迁移说明:dsh 这里直接调 @deepseek-ai/dsh-llm 的 createUserMessage 与 cordis 的
// sessionController / sessions.flush。本项目把这些宿主能力收敛成注入的 deps(见 RuntimeDeps),
// **投递顺序与语义完全不变**:造消息 → 投进会话 → 确认落盘 → commit。
import { isRecurringScheduleRecord, renderReminderFraming, renderRecurringReminderBatchFraming, resolveRecurringOccurrence } from './domain.ts'
import type { DeliveryRetentionBounds, RecurringScheduleRecord } from './types.ts'
import type { MessageId } from './brands.ts'
import type { ScheduleTask } from './storage.ts'
import { appendDelivery } from './delivery-history.ts'

/** 投递到会话时用的消息形状(source.kind='schedule' 与 dsh 一致) */
export interface ScheduleMessage {
  readonly id: MessageId
  readonly text: string
  readonly source: { readonly kind: 'schedule' }
}

/** 宿主能力:造消息身份、把消息投进会话并确认已落盘、告警日志 */
export interface RuntimeDeps {
  /** 造一条 source='schedule' 的用户消息(dsh 的 createUserMessage) */
  createMessage: (text: string) => ScheduleMessage
  /**
   * 把消息投进目标会话并**等它确认落盘**(dsh 的 followup + sessions.flush);
   * 未确认必须抛错 —— runtime 靠这个把该任务留在"仍未处理"的状态里重试。
   */
  deliver: (sessionId: string, message: ScheduleMessage) => Promise<void>
  logger: { warn: (message: string) => void }
}

/** Largest delay Node timers represent without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Owns at most one timer across recomputations; delivery and management share the serialized operation. */
export class ScheduleRuntime {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private stopping = false
  private requested = false
  // 迁移说明:dsh 用构造函数参数属性(`private readonly ctx: Context`);
  // 本项目的服务端编译开了 erasableSyntaxOnly(参数属性不是可擦除语法),故改为显式字段 + 赋值。
  private readonly deps: RuntimeDeps
  private readonly tasks: () => readonly ScheduleTask[]
  private readonly transact: (work: () => Promise<void>) => Promise<void>
  private readonly commit: (task: ScheduleTask) => Promise<void>
  private readonly retention: DeliveryRetentionBounds

  /**
   * @param deps - 宿主能力:造消息、投递并确认落盘、告警。
   * @param tasks - Current durable tasks.
   * @param transact - Serialize delivery against management writes.
   * @param commit - Persist task status, target, receipt, and history together after durable inbox delivery.
   */
  constructor(
    deps: RuntimeDeps,
    tasks: () => readonly ScheduleTask[],
    transact: (work: () => Promise<void>) => Promise<void>,
    commit: (task: ScheduleTask) => Promise<void>,
    retention: DeliveryRetentionBounds,
  ) {
    this.deps = deps
    this.tasks = tasks
    this.transact = transact
    this.commit = commit
    this.retention = retention
  }

  /**
   * Recompute the nearest obligation after startup or a durable change.
   * Dispatch failures are logged; refused admission does not retry automatically.
   */
  requestDrive(): void {
    if (this.stopping) return
    this.requested = true
    this.clearTimer()
    if (this.running !== undefined) return
    let run: Promise<void>
    // 迁移说明:dsh 用 ctx.agents.withoutInitiator 包住整段(delivery 不该被记成"发起者"),
    // 本项目没有 initiator 概念,这层包装去掉;下面的合并/重入循环逐字保留。
    run = (async () => {
      while (this.requested && !this.stopping) {
        this.requested = false
        await this.transact(async () => { await this.drive() })
      }
    })()
    this.running = run
    void run.catch((error: unknown) => {
      this.deps.logger.warn(`schedule: dispatch stopped: ${String(error)}`)
    }).finally(() => {
      this.running = undefined
      if (this.requested && !this.stopping) this.requestDrive()
    })
  }

  /** Stop the timer and drain an accepted delivery before storage closes. */
  async dispose(): Promise<void> {
    this.stopping = true
    this.clearTimer()
    // requestDrive reports execution failures; teardown only waits for quiescence.
    await this.running?.catch(() => undefined)
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private async drive(): Promise<void> {
    this.clearTimer()
    const failed = new Set<string>()
    const handled = new Set<string>()
    const scanNow = Date.now()
    const due = this.tasks().filter(task => task.status === 'active' && Date.parse(task.record.scheduledAt) <= scanNow)
    for (const task of due) {
      if (this.stopping) return
      if (handled.has(task.record.id)) continue
      const group = isRecurringScheduleRecord(task.record)
        ? due.filter(candidate => candidate.sessionId === task.sessionId && isRecurringScheduleRecord(candidate.record))
        : [task]
      for (const member of group) handled.add(member.record.id)
      let admitted = group
      const committed = new Set<ScheduleTask['record']['id']>()
      try {
        // dsh: `ctx.sessionController.resolveAgent(task.sessionId)` 把冷会话恢复成可投递的 Agent,
        // 返回 error 时抛出。本项目把这步收进 deliver(内部 ensureRuntime + submit),语义等价。
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- Disposal can run while Session restoration is awaited.
        if (this.stopping) return
        const now = Date.now()
        // Session restoration can span a wall-clock rollback; future members keep their timer obligation.
        admitted = group.filter(member => Date.parse(member.record.scheduledAt) <= now)
        if (admitted.length === 0) continue
        const recurring = admitted.filter((member): member is ScheduleTask & { record: RecurringScheduleRecord } =>
          isRecurringScheduleRecord(member.record))
        const occurrences = recurring.map(member => ({
          task: member, occurrence: resolveRecurringOccurrence(member.record, now),
        }))
        const text = isRecurringScheduleRecord(task.record)
          ? renderRecurringReminderBatchFraming(occurrences.map(({ task: member, occurrence }) => ({
            record: member.record, occurrenceAt: occurrence.occurrenceAt,
          })))
          : renderReminderFraming(task.record)
        const message = this.deps.createMessage(text)
        // dsh: followup 同步把消息拼进 inbox,再由 sessions.flush 等会话落盘确认;
        // 本项目把这两步合成一次 deliver(messageId 由 createMessage 铸出)。
        await this.deps.deliver(task.sessionId, message)
        const deliveredAt = new Date(Date.now()).toISOString()
        if (!isRecurringScheduleRecord(task.record)) {
          await this.commit({
            ...task, status: 'inactive',
            ...appendDelivery(task, { scheduledAt: task.record.scheduledAt, deliveredAt, messageId: message.id }, this.retention),
          })
          committed.add(task.record.id)
        }
        for (const { task: member, occurrence } of occurrences) {
          await this.commit({
            ...member,
            record: { ...member.record, scheduledAt: occurrence.nextScheduledAt ?? occurrence.occurrenceAt },
            status: occurrence.nextScheduledAt === undefined ? 'inactive' : 'active',
            ...appendDelivery(member, { scheduledAt: occurrence.occurrenceAt, deliveredAt, messageId: message.id }, this.retention),
          })
          committed.add(member.record.id)
        }
      } catch (error: unknown) {
        // Successful commits and targets made future by clock rollback keep their timer obligation.
        const pending = admitted.filter(member => !committed.has(member.record.id))
        const failedAt = Date.now()
        for (const member of pending) {
          if (Date.parse(member.record.scheduledAt) <= failedAt) failed.add(member.record.id)
        }
        const ids = pending.map(member => member.record.id)
        this.deps.logger.warn(`schedule: reminders ${JSON.stringify(ids)} were not acknowledged: ${String(error)}`)
      }
    }
    if (this.stopping) return
    const next = this.tasks().filter(task => task.status === 'active' && !failed.has(task.record.id))
      .reduce<number | undefined>((at, task) => {
        const target = Date.parse(task.record.scheduledAt)
        return at === undefined ? target : Math.min(at, target)
      }, undefined)
    if (next !== undefined) {
      this.timer = setTimeout(() => { this.timer = undefined; this.requestDrive() },
        Math.max(0, Math.min(next - Date.now(), MAX_TIMER_DELAY_MS)))
      this.timer.unref()
    }
  }
}
