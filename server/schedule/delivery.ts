/**
 * 把 dsh 的投递语义接到 Teleforge 的 agent 上(迁移里唯一"宿主适配"层)。
 *
 * dsh 的投递是三步:`resolveAgent`(把冷会话恢复成可投递的 Agent)→ `followup(message)`(消息进 inbox)
 * → `sessions.flush(session)`(**等消息落盘确认**)。确认之后 runtime 才会推进任务的 scheduledAt。
 *
 * Teleforge 的对应物:`agent.ensureRuntime`(不切换用户正在看的会话)+ `agent.submit`(会话空闲就开一轮、
 * 忙就进待执行队列)+ 我们自己的 messageId 盖章。
 *
 * **已知差异(写在这里免得以后当成 bug 查)**:Teleforge 的待执行队列只在内存里(`rt.pending`),
 * 没有 dsh 那种"inbox 一起落盘"的 flush 确认点,所以这里的确认 = "消息已被 agent 接受"。
 * 消息真正进事件日志发生在该会话轮到它时(空闲会话几乎立刻);进程在排队期间被杀会丢这条提醒 ——
 * 这与用户手打一句话在忙碌会话里的遭遇完全一致,是同一处已知短板,不是定时任务特有的。
 */
import { randomUUID } from 'node:crypto'
import { agent } from '../agent/agent.ts'
import * as sessions from '../store/session-store.ts'
import { MessageId } from './dsh/brands.ts'
import type { ScheduleMessage } from './dsh/runtime.ts'
import type { DeliveryDeps } from './service.ts'

/**
 * 人看的显示文本 → 从 dsh 的提醒框架里取出正文(dsh 的 UI 有 ScheduleTurnCard 专门解析框架,
 * Teleforge 的聊天气泡只需要一行标签,所以在这里抽一次)。
 */
export function displayForFraming(text: string): string {
  const prompts: string[] = []
  try {
    const batch = /reminders_json: (\[[\s\S]*\])\s*$/.exec(text)
    if (batch) {
      const list = JSON.parse(batch[1]) as { reminder_prompt?: unknown }[]
      for (const item of list) if (typeof item?.reminder_prompt === 'string') prompts.push(item.reminder_prompt)
    } else {
      const one = /reminder_prompt_json: (".*")\s*$/m.exec(text)
      if (one) {
        const value: unknown = JSON.parse(one[1])
        if (typeof value === 'string') prompts.push(value)
      }
    }
  } catch { /* 框架解析失败就退回通用标签 */ }
  if (prompts.length === 0) return '⏰ 定时提醒'
  return prompts.length === 1 ? `⏰ ${prompts[0]}` : `⏰ 定时提醒(${prompts.length} 条)`
}

/** 造投递依赖(createMessage + deliver) */
export function createDeliveryDeps(): DeliveryDeps {
  return {
    createMessage: (text: string): ScheduleMessage => ({
      id: MessageId(`schedule_msg_${randomUUID()}`),
      text,
      source: { kind: 'schedule' },
    }),
    deliver: async (sessionId: string, message: ScheduleMessage): Promise<void> => {
      if (!sessions.list().some((s) => s.id === sessionId)) {
        throw new Error(`schedule: Session "${sessionId}" no longer exists`)
      }
      if (!agent.ensureRuntime(sessionId)) {
        throw new Error(`schedule: Session "${sessionId}" could not be restored`)
      }
      // 等价 dsh 的 followup + flush:交给 agent 并等它**被接受**(见文件头注释的已知差异)
      // 一次性提醒的框架里带 schedule_id_json:抽出来盖在事件上,前端/回执能直接对上任务
      const idMatch = /^schedule_id_json: (".*")$/m.exec(message.text)
      await agent.submitAccepted(sessionId, message.text, {
        display: displayForFraming(message.text),
        source: 'schedule',
        messageId: String(message.id),
        scheduleId: idMatch ? String(JSON.parse(idMatch[1])) : null,
      })
    },
  }
}
