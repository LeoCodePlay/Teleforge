// 自动化任务的 RPC 面:**照 dsh `ScheduleService` 的远程方法一一对应**
//   list / catalog / history / update / delete
// 与之配套的还有一条广播 `schedule_changed`(dsh 的 `schedule/changed` 事件)。
//
// 两处**有意保留的差异**(都写在这里,免得以后被当成漏迁):
//   1. **没有 create**:dsh 也不给 UI 直连创建 —— 它把"新建任务"做成"开一个新会话,让模型用
//      `schedule_create` 建"(见 dsh ui-schedule/TaskManagerPage.tsx:23「Start a new Session, where
//      a reminder is created by asking the model to…」)。本项目的页面同样走这条路。
//   2. **多一个 preview**:dsh 的界面自己在前端算"下次运行"(ui-schedule/task-cron.ts),
//      本项目让服务端用**同一份 domain.ts** 算(server/schedule/dsh/domain.ts),避免两套时间逻辑。
import { getScheduleService } from '../../schedule/holder.ts'
import { ScheduleId } from '../../schedule/dsh/domain.ts'
import { previewRule } from './schedule-preview.ts'
import type { ScheduleRule } from './schedule-preview.ts'
import type { RpcModule } from './router.ts'

export function registerSchedule(rpc: RpcModule) {
  /** 装配在 server/schedule/index.ts(那里才 import agent);这里按需取,拿不到就明确报错 */
  const svc = () => {
    const service = getScheduleService()
    if (service === undefined) throw new Error('自动化任务服务尚未装配(server/schedule/index.ts)')
    return service
  }
  // dsh `@Remote('list')`:某个会话**启用中**的任务
  rpc.register('schedule_list', async (msg: any, { reply }: any) => {
    if (!msg?.sessionId) throw new Error('缺少 sessionId')
    reply({ type: 'schedule_list', records: await svc().list({ sessionId: String(msg.sessionId) as any }) })
  })

  // dsh `@Remote('catalog')`:全部任务(含已停用),按 scheduledAt 升序 + id 字典序
  rpc.register('schedule_catalog', async (msg: any, { reply }: any) => {
    reply({ type: 'schedule_catalog', entries: await svc().catalog() })
  })

  // dsh `@Remote('history')`:某任务的投递历史(1-100 条一页,游标 maessageId)
  rpc.register('schedule_history', async (msg: any, { reply }: any) => {
    if (!msg?.sessionId || !msg?.id) throw new Error('缺少 sessionId 或 id')
    reply({
      type: 'schedule_history',
      result: await svc().history({
        sessionId: String(msg.sessionId) as any,
        id: ScheduleId(String(msg.id)),
        limit: Number(msg.limit),
        ...(msg.before === undefined ? {} : { before: String(msg.before) as any }),
      }),
    })
  })

  // dsh `@Remote('delete')`:删除一行(其投递记录随之消失);已排队的消息不撤回
  rpc.register('schedule_delete', async (msg: any, { reply }: any) => {
    if (!msg?.sessionId || !msg?.id) throw new Error('缺少 sessionId 或 id')
    reply({
      type: 'ok',
      result: await svc().delete({ sessionId: String(msg.sessionId) as any, id: ScheduleId(String(msg.id)) }),
    })
  })

  // dsh `@Remote('update')`:compare-and-set 改名/改内容/改时间(可换规则种类)
  rpc.register('schedule_update', async (msg: any, { reply }: any) => {
    if (!msg?.sessionId || !msg?.id) throw new Error('缺少 sessionId 或 id')
    reply({
      type: 'ok',
      result: await svc().update({
        sessionId: String(msg.sessionId) as any,
        id: ScheduleId(String(msg.id)),
        expected: msg.expected,
        ...(msg.change === undefined ? {} : { change: msg.change }),
        ...(msg.title === undefined ? {} : { title: String(msg.title) }),
        ...(msg.prompt === undefined ? {} : { prompt: String(msg.prompt) }),
      }),
    })
  })

  // 规则预览(本项目特有):只算时间不落库,规则编辑器改一个字段问一次
  rpc.register('schedule_preview', async (msg: any, { reply }: any) => {
    const result = previewRule(msg?.rule as ScheduleRule, Date.now(), msg?.count ?? 5)
    reply({ type: 'schedule_preview', ...result })
  })
}
