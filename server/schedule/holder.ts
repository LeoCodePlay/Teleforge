/**
 * Schedule 服务实例的"持有槽":装配(需要 agent 的投递)与使用(模型工具、RPC)分开放,
 * 避免模块循环依赖 —— 工具模块只拿这个槽,**运行到那一刻**才取实例。
 *
 * 为什么需要它:delivery.ts 要 import agent(投递),而 agent.ts 在模块体里注册工具;
 * 如果工具模块直接 import 装配好的单例,就会形成 agent → 工具 → 单例 → delivery → agent
 * 的环,ESM 在环里可能让工具模块的常量还没初始化就被使用(实测报
 * `Cannot access 'CREATE_DESCRIPTION' before initialization`)。
 */
import type { ScheduleService } from './service.ts'

let instance: ScheduleService | undefined

export function setScheduleService(service: ScheduleService): void { instance = service }

/** 取装配好的服务;还没装配(例如只 import 了 agent 的单元测试)返回 undefined */
export function getScheduleService(): ScheduleService | undefined { return instance }
