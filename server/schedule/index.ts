/**
 * Schedule 服务的装配入口:构造单例并放进 holder。
 * RPC(server/api/rpc/schedule.ts)与模型工具(server/agent/schedule-tools.ts)都通过
 * holder 取它,不直接 import 本模块 —— 本模块 import 了 delivery(进而 import agent),
 * 直接引用会形成循环依赖(见 holder.ts 的说明)。
 */
import { ScheduleService } from './service.ts'
import { createDeliveryDeps } from './delivery.ts'
import { setScheduleService } from './holder.ts'

const service = new ScheduleService(createDeliveryDeps())
setScheduleService(service)

export const scheduleService = service
export { ScheduleService } from './service.ts'
