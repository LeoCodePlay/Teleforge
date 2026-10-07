/**
 * Schedule 服务层:逐字对应 dsh `packages/schedule/schedule/src/index.ts` 的 `ScheduleService`,
 * 去掉 Cordis 装配(注入的服务 → 本模块自己的依赖),**操作语义、FIFO 串行、保留策略与拒绝理由都照搬**:
 *
 *   - `serialize()`:投递与管理写入共用同一条 FIFO(index.ts:463-468),create 的 `now` 在入队**之前**采样
 *     (index.ts:228-250),因此排队久了可能一建就已到期 —— 这是刻意行为,不是 bug;
 *   - 修改走 **compare-and-set**:请求必须带上开始编辑时看到的完整 `expected` 记录,
 *     不一致返回 `schedule_conflict`(update.ts:166-167),而不是版本号;
 *   - 删除只删这一行(其投递记录随之消失),已排队的消息不受影响(index.ts:326-339);
 *   - 拒绝把任务绑到"投递永远到不了"的会话(index.ts:410-417):dsh 判的是子代理深度 > 0,
 *     本项目判的是"这个 id 根本不是本项目的会话"(子代理运行会话不在会话表里);
 *   - 保留窗口:每任务 30 天 / 200 条(dsh index.ts:86-89 的默认值),由 delivery-history 落实。
 */
import { randomUUID } from 'node:crypto'
import * as sessions from '../store/session-store.ts'
import { ScheduleRuntime } from './dsh/runtime.ts'
import { deliveryHistoryPage } from './dsh/delivery-history.ts'
import { resolveScheduleUpdate } from './dsh/update.ts'
import {
  ScheduleId, ScheduleInputError, createAfterScheduleRecord, createAtScheduleRecord, createCronScheduleRecord,
  createDailyScheduleRecord, createEveryScheduleRecord, createWeeklyScheduleRecord, scheduleTitle,
} from './dsh/domain.ts'
import { SessionId } from './dsh/brands.ts'
import type { ScheduleRecord, ScheduleCreateRequest, ScheduleDeleteRequest, ScheduleDeleteResult, ScheduleDeliveryHistoryRequest, ScheduleDeliveryHistoryResult, ScheduleListRequest, ScheduleUpdateRequest, ScheduleUpdateResult, SubagentSessionError } from './dsh/types.ts'
import type { ScheduleTask } from './dsh/storage.ts'
import { openScheduleStore, type ScheduleStore } from './store.ts'
import type { RuntimeDeps, ScheduleMessage } from './dsh/runtime.ts'

/** dsh index.ts:86-89 的默认保留策略(部署可在 Config 里改;本项目先用默认值) */
const DEFAULT_DELIVERY_HISTORY_DAYS = 30
const DEFAULT_DELIVERY_HISTORY_RECORDS = 200

/** 宿主提供的投递能力(本项目由 delivery.ts 用 agent + 会话存储实现) */
export interface DeliveryDeps extends Omit<RuntimeDeps, 'logger'> {}

/** 状态变化广播(dsh 的 `schedule/changed` 事件) */
export interface ScheduleHub {
  emit: (payload: unknown) => void
}

export class ScheduleService {
  /** dsh index.ts:108 的 retention(投递历史窗口与条数上限) */
  private readonly retention = { days: DEFAULT_DELIVERY_HISTORY_DAYS, records: DEFAULT_DELIVERY_HISTORY_RECORDS }
  private readonly deps: DeliveryDeps
  /** dsh 的 `chain`:投递与管理写入共用一条 FIFO */
  private chain: Promise<unknown> = Promise.resolve()
  private store: ScheduleStore | undefined
  private readonly opening: Promise<ScheduleStore>
  private readonly runtime: ScheduleRuntime
  private hub: ScheduleHub | undefined
  private stopping = false
  /**
   * 唤醒兜底(Teleforge 特有):dsh 只在"持久变更"后 requestDrive,而本项目多两道离线闸门
   * —— 服务器连接与模型配置。它们就绪时不一定有持久变更,所以每 60s 兜底唤醒一次:
   * 调度本身仍是"闹钟定到下一个到期时刻"(见 dsh runtime.ts 的 drive 收尾),这个定时器只负责
   * 把"当时跑不了、现在能跑了"的任务捞回来,不参与下一次触发的计算。
   */
  private wakeTimer: ReturnType<typeof setInterval> | undefined

  constructor(deps: DeliveryDeps) {
    this.deps = deps
    // 打不开(文件损坏/版本不符)不在这里抛:留给第一个用到它的操作抛,进程不至于起不来
    this.opening = Promise.resolve().then(() => openScheduleStore())
    this.runtime = new ScheduleRuntime(
      {
        createMessage: deps.createMessage,
        deliver: deps.deliver,
        logger: { warn: (message: string) => console.warn(`[schedule] ${message}`) },
      },
      // runtime 要同步取任务表;store 未就绪时先给空表(启动时 requestDrive 在 await ready 之后)
      () => this.store?.tasks() ?? [],
      (work) => this.serialize(work),
      async (task: ScheduleTask) => {
        const store = await this.ready()
        await store.table.put(task.record.id, task)
        this.emitChanged()
      },
      this.retention,
    )
  }

  setHub(hub: ScheduleHub | undefined): void { this.hub = hub }

  /** 启动:载入任务表后立刻 requestDrive(等价 dsh index.ts:155-163 的构造后首次 drive) */
  async start(): Promise<void> {
    await this.ready()
    this.runtime.requestDrive()
    if (this.wakeTimer === undefined) {
      this.wakeTimer = setInterval(() => this.runtime.requestDrive(), 60_000)
      if (typeof (this.wakeTimer as any)?.unref === 'function') (this.wakeTimer as any).unref()
    }
  }

  /** 唤醒一次调度扫描(dsh:任何持久变更后 requestDrive) */
  requestDrive(): void { this.runtime.requestDrive() }

  /** 关停:停表 + 等在途投递收尾 + 关 store(等价 dsh index.ts:143-148) */
  async dispose(): Promise<void> {
    this.stopping = true
    if (this.wakeTimer !== undefined) { clearInterval(this.wakeTimer); this.wakeTimer = undefined }
    await this.runtime.dispose()
    await this.chain
    await this.store?.close()
  }

  // ---------------- 对外操作(dsh ScheduleService 的同名方法) ----------------

  /** index.ts:228-263 */
  async create(sessionId: string, request: ScheduleCreateRequest): Promise<ScheduleRecord> {
    const selectors = [request.at, request.after_seconds, request.every_seconds, request.daily, request.weekly, request.cron]
      .filter((value) => value !== undefined).length
    if (selectors > 1) throw new ScheduleInputError('invalid_selector', 'Exactly one reminder selector is required.')
    const title = scheduleTitle(request.title)
    const id = ScheduleId(`schedule-${randomUUID()}`)
    const now = Date.now()
    let record: ScheduleRecord
    if (request.at !== undefined) record = createAtScheduleRecord(id, request.prompt, request.at, now, title)
    else if (request.after_seconds !== undefined) record = createAfterScheduleRecord(id, request.prompt, request.after_seconds, now, title)
    else if (request.every_seconds !== undefined) record = createEveryScheduleRecord(id, request.prompt, request.every_seconds, now, title)
    else if (request.daily !== undefined) record = createDailyScheduleRecord(id, request.prompt, request.daily, now, title)
    else if (request.weekly !== undefined) record = createWeeklyScheduleRecord(id, request.prompt, request.weekly, now, title)
    else if (request.cron !== undefined) record = createCronScheduleRecord(id, request.prompt, request.cron, now, title)
    else throw new ScheduleInputError('invalid_selector', 'Exactly one reminder selector is required.')
    return this.serialize(async () => {
      const refusal = this.reminderTargetRefusal(sessionId)
      if (refusal !== undefined) throw new ScheduleInputError('subagent_session', refusal.message)
      const store = await this.ready()
      await store.table.put(id, {
        sessionId: SessionId(String(sessionId)), record, status: 'active',
        deliveryHistory: { records: [], earlierRecordsUnavailable: false },
      })
      this.emitChanged()
      this.runtime.requestDrive()
      return record
    })
  }

  /** index.ts:270-276:只列该会话**启用中**的任务(不激活会话) */
  async list(request: ScheduleListRequest): Promise<ScheduleRecord[]> {
    const store = await this.ready()
    return store.table.entries()
      .filter(([, task]) => task.sessionId === request.sessionId && task.status === 'active')
      .map(([, task]) => task.record)
  }

  /** index.ts:284-293:全局目录(含已停用),按 scheduledAt 升序 + id 字典序 */
  async catalog(): Promise<(ScheduleRecord & { sessionId: string; status: 'active' | 'inactive'; lastDelivery?: unknown })[]> {
    const store = await this.ready()
    return store.table.entries()
      .map(([, task]) => ({
        ...task.record, sessionId: String(task.sessionId), status: task.status,
        ...(task.lastDelivery === undefined ? {} : { lastDelivery: task.lastDelivery }),
      }))
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id))
  }

  /** index.ts:302-312 */
  async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
      throw new ScheduleInputError('invalid_rule', 'Delivery history limit must be a safe integer from 1 through 100.')
    }
    const store = await this.ready()
    const task = store.table.get(String(request.id))
    if (task === undefined || String(task.sessionId) !== String(request.sessionId)) {
      return { id: request.id, code: 'schedule_not_found' }
    }
    return deliveryHistoryPage(task, request, this.retention)
  }

  /** index.ts:325-339 */
  async delete(request: ScheduleDeleteRequest): Promise<ScheduleDeleteResult> {
    return this.serialize<ScheduleDeleteResult>(async () => {
      const store = await this.ready()
      const current = store.table.get(String(request.id))
      if (current === undefined || String(current.sessionId) !== String(request.sessionId)) {
        return { id: request.id, deleted: false, code: 'schedule_not_found' }
      }
      await store.table.delete(String(request.id))
      this.emitChanged()
      this.runtime.requestDrive()
      return { id: request.id, deleted: true }
    })
  }

  /** index.ts:355-374 */
  async update(request: ScheduleUpdateRequest): Promise<ScheduleUpdateResult> {
    return this.serialize<ScheduleUpdateResult>(async () => {
      const refusal = this.reminderTargetRefusal(String(request.sessionId))
      if (refusal !== undefined) return refusal
      const store = await this.ready()
      const current = store.table.get(String(request.id))
      if (current === undefined || String(current.sessionId) !== String(request.sessionId)) {
        return { id: request.id, updated: false, code: 'schedule_not_found' }
      }
      if (current.status === 'inactive') return { id: request.id, updated: false, code: 'schedule_ended' }
      const result = resolveScheduleUpdate(current.record, request.expected, request.change, Date.now(), request)
      if (!('record' in result) || !result.updated) return result
      await store.table.put(String(request.id), { ...current, record: result.record })
      this.emitChanged()
      this.runtime.requestDrive()
      return result
    })
  }

  /** index.ts:430-461:归档一个会话时,把它名下仍激活的任务一并停掉 */
  async stopSessionTasks(sessionId: string): Promise<void> {
    await this.serialize(async () => {
      const store = await this.ready()
      const active = store.table.entries()
        .filter(([, task]) => String(task.sessionId) === String(sessionId) && task.status === 'active')
        .map(([, task]) => task.record.id)
      if (active.length === 0) return
      let removed = false
      let failure: Error | undefined
      for (const id of active) {
        try {
          await store.table.delete(String(id))
          removed = true
        } catch (error: unknown) {
          failure ??= error instanceof Error ? error : new Error(`schedule stop failed: ${String(error)}`)
        }
      }
      if (removed) {
        this.emitChanged()
        this.runtime.requestDrive()
      }
      if (failure !== undefined) throw failure
    })
  }

  // ---------------- 内部 ----------------

  /** index.ts:382-391:落库成功后才广播;监听者抛错不影响调用方 */
  private emitChanged(): void {
    try {
      this.hub?.emit({ event: 'changed' })
    } catch (error: unknown) {
      console.warn(`[schedule] schedule/changed listener failed: ${String(error)}`)
    }
  }

  /** index.ts:410-417 的等价判定:这个会话能不能收到投递 */
  private reminderTargetRefusal(sessionId: string): SubagentSessionError | undefined {
    if (!sessionId) return { code: 'subagent_session', message: 'This Session belongs to subagent routing, which never receives reminder delivery.' }
    if (sessions.list().some((s) => s.id === sessionId)) return undefined
    return {
      code: 'subagent_session',
      message: 'This Session belongs to subagent routing, which never receives reminder delivery.',
    }
  }

  /** index.ts:463-468 */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('Schedule service is stopping'))
    const pending = this.chain.then(work)
    this.chain = pending.catch(() => undefined)
    return pending
  }

  private async ready(): Promise<ScheduleStore> {
    const store = await this.opening
    this.store = store
    return store
  }
}
