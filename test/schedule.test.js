// 自动化任务(逐字移植 dsh `packages/schedule/*`)的集成测试:存储 / 服务 / 运行时投递 / 模型工具 / RPC。
//
// 时间的正确性由 **dsh 自己的 spec** 保证(见 test/dsh-schedule-specs.test.js:414 项断言原样跑)。
// 这里测的是"搬过来之后接得对不对":
//   - 落盘形状与 dsh 的 storage-domain JSON 一致,坏行/键不符直接拒绝;
//   - 服务层:创建/列表/目录/乐观并发更新/删除/投递历史,以及错误码;
//   - 运行时:**同会话的重复任务合成一条 [SCHEDULE REMINDER BATCH]、共享 messageId、投递成功后
//     一次性转 inactive / 重复推进 scheduledAt,失败则原样留着下次重试**;
//   - 模型工具与 RPC 的对外形状。
// 运行:node test/schedule.test.js
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'sshai-schedule-'))
process.env.SCHEDULES_FILE = path.join(process.env.DATA_DIR, 'schedules.json')

const { ScheduleService } = await import('../server/schedule/service.ts')
const { openScheduleStore } = await import('../server/schedule/store.ts')
const { ScheduleRuntime } = await import('../server/schedule/dsh/runtime.ts')
const { setScheduleService, getScheduleService } = await import('../server/schedule/holder.ts')
const { registerScheduleTools } = await import('../server/agent/schedule-tools.ts')
const { ToolRegistry } = await import('../server/agent/registry.ts')
const { ScheduleInputError, ScheduleLogError } = await import('../server/schedule/dsh/domain.ts')
const { registerSchedule } = await import('../server/api/rpc/schedule.ts')
const sessions = await import('../server/store/session-store.ts')

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 服务方法是 async:校验失败是"拒绝的 Promise"而不是同步抛出,所以这里必须 await
const throwsCode = async (name, fn, code) => {
  try { await fn(); check(name, false, '(没有抛错)') }
  catch (e) { check(name, e?.code === code, `错误码 ${e?.code}(${e?.message})`) }
}

/** 假投递:记录每次投递的文本与 messageId */
function fakeDelivery() {
  const sent = []
  return {
    sent,
    deps: {
      createMessage: (text) => ({ id: `m_${sent.length + 1}`, text, source: { kind: 'schedule' } }),
      deliver: async (sessionId, message) => { sent.push({ sessionId, message }) },
    },
  }
}

const SID = sessions.create('定时任务测试会话', 'local', {}).id

/* ================= [一] 存储形状 ================= */
console.log('\n[一] 存储(dsh storage-domain 的 JSON 形状)')
{
  try { fs.unlinkSync(process.env.SCHEDULES_FILE) } catch { /* 首次没有文件 */ }
  const store = openScheduleStore(process.env.SCHEDULES_FILE)
  const task = {
    sessionId: SID,
    record: { id: 'schedule-1', kind: 'at', title: 't', prompt: 'p', scheduledAt: '2026-09-16T15:00:00.000Z' },
    status: 'active',
  }
  await store.table.put('schedule-1', task)
  const doc = JSON.parse(fs.readFileSync(process.env.SCHEDULES_FILE, 'utf8'))
  check('落盘形状 = unit/global/tables.tasks(dsh storage-json 同款)',
    doc.unit?.name === 'schedule' && doc.unit.version === 1 && doc.global === null && !!doc.tables?.tasks['schedule-1'],
    JSON.stringify(doc).slice(0, 160))
  check('任务按 dsh 的表结构存(sessionId/record/status)',
    doc.tables.tasks['schedule-1'].sessionId === SID && doc.tables.tasks['schedule-1'].status === 'active')
  check('文件是 2 空格缩进 + 末尾换行(dsh serialize 同款)',
    fs.readFileSync(process.env.SCHEDULES_FILE, 'utf8').endsWith('\n}') || fs.readFileSync(process.env.SCHEDULES_FILE, 'utf8').endsWith('}\n'), '结尾不符')

  // 坏数据必须拒绝打开(与 dsh "坏记录拒绝打开 domain" 同取向)
  const bad = path.join(process.env.DATA_DIR, 'bad.json')
  fs.writeFileSync(bad, JSON.stringify({ unit: { name: 'schedule', version: 1 }, global: null, tables: { tasks: { 'schedule-other': task } } }))
  let keyErr = null
  try { openScheduleStore(bad) } catch (e) { keyErr = e }
  check('表键与 record.id 不一致 → 拒绝打开', keyErr instanceof ScheduleLogError, String(keyErr))
  const extra = path.join(process.env.DATA_DIR, 'extra.json')
  fs.writeFileSync(extra, JSON.stringify({ unit: { name: 'schedule', version: 1 }, global: null, tables: { tasks: { 'schedule-1': { ...task, extra: 1 } } } }))
  let extraErr = null
  try { openScheduleStore(extra) } catch (e) { extraErr = e }
  check('多余键 → 拒绝打开(zod strict)', extraErr !== null, String(extraErr))
}

/* ================= [二] 服务层 ================= */
console.log('\n[二] 服务层(创建 / 列表 / 目录 / 乐观并发 / 删除 / 投递历史)')
{
  // [一] 直接往同一个文件里塞过 schedule-1;服务层要自己开一次库,先清空以免把它算进来
  fs.unlinkSync(process.env.SCHEDULES_FILE)
  const fake = fakeDelivery()
  const service = new ScheduleService(fake.deps)

  const daily = await service.create(SID, { prompt: '每天问候', title: '每日', daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } })
  check('daily:时间规范化成 HH:mm:ss.SSS', daily.time === '09:00:00.000', daily.time)
  check('daily:时区存显式 IANA', daily.timeZone === 'Asia/Shanghai', daily.timeZone)
  const every = await service.create(SID, { prompt: '每 5 分钟', title: '间隔', every_seconds: 300 })
  check('every:对齐创建时刻', Date.parse(every.scheduledAt) - Date.now() <= 305_000, every.scheduledAt)
  const cron = await service.create(SID, { prompt: '工作日', title: 'cron', cron: { expression: '*/15 9-17 * * 1-5', time_zone: 'UTC' } })
  check('cron:规范化后存库', cron.expression === '*/15 9-17 * * 1-5', cron.expression)
  const after = await service.create(SID, { prompt: '一分钟后', title: '一次性', after_seconds: 60 })
  check('after:一次性延时', Math.abs(Date.parse(after.scheduledAt) - Date.now() - 60_000) < 2000, after.scheduledAt)

  await throwsCode('选择器互斥 → invalid_selector',
    () => service.create(SID, { prompt: 'x', title: 'x', after_seconds: 60, every_seconds: 300 }), 'invalid_selector')
  await throwsCode('空标题 → invalid_prompt',
    () => service.create(SID, { prompt: 'x', title: '  ', after_seconds: 60 }), 'invalid_prompt')
  await throwsCode('every 低于下限 → frequency_too_high',
    () => service.create(SID, { prompt: 'x', title: 'x', every_seconds: 30 }), 'frequency_too_high')
  await throwsCode('非法时区 → invalid_time_zone',
    () => service.create(SID, { prompt: 'x', title: 'x', daily: { time: '09:00:00', time_zone: 'Unknown/Zone' } }), 'invalid_time_zone')
  await throwsCode('不存在的会话 → subagent_session(投递永远到不了)',
    () => service.create('sa_not-a-real-session', { prompt: 'x', title: 'x', after_seconds: 60 }), 'subagent_session')

  const active = await service.list({ sessionId: SID })
  check('list 只返回该会话启用中的任务', active.length === 4, String(active.length))
  const catalog = await service.catalog()
  check('catalog 返回目录(含 sessionId/status)', catalog.length === 4 && catalog.every((e) => e.sessionId === SID && e.status === 'active'))
  check('catalog 按 scheduledAt 升序', catalog.every((e, i) => i === 0 || catalog[i - 1].scheduledAt <= e.scheduledAt))

  // 乐观并发:expected 必须是"开始编辑时看到的那条"
  const conflict = await service.update({
    sessionId: SID, id: daily.id,
    expected: { ...daily, prompt: '改坏了' },
    title: '新名字',
  })
  check('expected 不符 → schedule_conflict(不改库)', conflict.code === 'schedule_conflict', JSON.stringify(conflict))
  const updated = await service.update({ sessionId: SID, id: daily.id, expected: daily, title: '改个名' })
  check('expected 相符 → 更新成功且 id 不变', updated.updated === true && updated.record.id === daily.id && updated.record.title === '改个名', JSON.stringify(updated))
  check('改名不动已提交的触发时刻', updated.record.scheduledAt === daily.scheduledAt)
  const notFound = await service.update({ sessionId: SID, id: 'schedule-nope', expected: daily, title: 'x' })
  check('未知 id → schedule_not_found', notFound.code === 'schedule_not_found', JSON.stringify(notFound))

  await throwsCode('history limit 越界 → invalid_rule',
    () => service.history({ sessionId: SID, id: daily.id, limit: 0 }), 'invalid_rule')
  const history = await service.history({ sessionId: SID, id: daily.id, limit: 10 })
  check('history 初始为空 + 带保留策略', history.records.length === 0 && history.retention.days === 30 && history.retention.records === 200, JSON.stringify(history))
  const historyOther = await service.history({ sessionId: 's_other', id: daily.id, limit: 10 })
  check('history 会话不符 → schedule_not_found', historyOther.code === 'schedule_not_found', JSON.stringify(historyOther))

  const gone = await service.delete({ sessionId: 's_other', id: every.id })
  check('删除会话不符 → schedule_not_found', gone.deleted === false && gone.code === 'schedule_not_found', JSON.stringify(gone))
  const deleted = await service.delete({ sessionId: SID, id: every.id })
  check('删除成功', deleted.deleted === true, JSON.stringify(deleted))
  check('删除后 list 少一条', (await service.list({ sessionId: SID })).length === 3)

  // 停用一个会话的全部任务(等价 dsh 的归档停表)
  await service.stopSessionTasks(SID)
  check('stopSessionTasks 清空该会话的启用任务', (await service.list({ sessionId: SID })).length === 0)
  check('但行仍在 catalog 里(status=inactive)',
    (await service.catalog()).filter((e) => e.sessionId === SID).every((e) => e.status === 'inactive'))
  setScheduleService(service)
  check('服务已放进 holder(工具/RPC 从这里取)', getScheduleService() === service)
}

/* ================= [三] 运行时投递 ================= */
console.log('\n[三] 运行时投递(批量合并 / 状态推进 / 失败重试)')
{
  const now = Date.now()
  const mk = (id, kind, extra, scheduledAt) => ({
    sessionId: SID,
    record: { id, kind, title: id, prompt: `${id}-prompt`, ...extra, scheduledAt },
    status: 'active',
  })
  const past = new Date(now - 60_000).toISOString()
  const future = new Date(now + 3_600_000).toISOString()
  const tasks = [
    mk('schedule-a', 'every', { everySeconds: 300 }, past),
    mk('schedule-b', 'daily', { time: '09:00:00.000', timeZone: 'Asia/Shanghai' }, past),
    mk('schedule-c', 'at', {}, past),
    mk('schedule-d', 'at', {}, future),
  ]
  const fake = fakeDelivery()
  const commits = []
  const warnings = []
  const runtime = new ScheduleRuntime(
    {
      createMessage: fake.deps.createMessage,
      deliver: fake.deps.deliver,
      logger: { warn: (m) => warnings.push(m) },
    },
    () => [...tasks],
    async (work) => { await work() },
    async (task) => {
      commits.push(task.record.id)
      const i = tasks.findIndex((t) => t.record.id === task.record.id)
      if (i >= 0) tasks[i] = task
    },
    { days: 30, records: 200 },
  )

  runtime.requestDrive()
  await sleep(120)

  check('同会话的两个重复任务合成一条消息', fake.sent.length === 2, `实际 ${fake.sent.length} 条`)
  const batch = fake.sent.find((s) => s.message.text.includes('[SCHEDULE REMINDER BATCH]'))
  check('重复任务用 BATCH 框架', !!batch, fake.sent.map((s) => s.message.text.slice(0, 40)).join(' | '))
  check('BATCH 里两条提醒都带上(含各自 occurrence_at)', (batch?.message.text.match(/schedule_id/g) ?? []).length === 2, batch?.message.text)
  check('未到期的任务不投递', !fake.sent.some((s) => s.message.text.includes('schedule-d')), JSON.stringify(fake.sent.map((s) => s.message.text)))
  const oneShot = fake.sent.find((s) => s.message.text.startsWith('[SCHEDULE REMINDER]'))
  check('一次性任务用单条框架', !!oneShot && oneShot.message.text.includes('schedule_id_json: "schedule-c"'), oneShot?.message.text)
  check('同批共享同一个 messageId', new Set(fake.sent.map((s) => s.message.id)).size === fake.sent.length)

  const a = tasks.find((t) => t.record.id === 'schedule-a')
  const b = tasks.find((t) => t.record.id === 'schedule-b')
  const c = tasks.find((t) => t.record.id === 'schedule-c')
  check('一次性任务投递后转 inactive', c.status === 'inactive', c.status)
  check('重复任务仍是 active', a.status === 'active' && b.status === 'active')
  check('重复任务推进到未来', Date.parse(a.record.scheduledAt) > now && Date.parse(b.record.scheduledAt) > now, `${a.record.scheduledAt} / ${b.record.scheduledAt}`)
  // 回执写在每个成员自己的行上(dsh:一批共享 messageId,但每个成员各提交一次)= 2 个重复 + 1 个一次性
  check('每次投递都写了回执(appendDelivery)', commits.length === 3, JSON.stringify(commits))

  // 投递失败的处置:dsh 只记 warn、任务原样留着(不进闹钟,等下次唤醒重试)
  const failTasks = [mk('schedule-e', 'at', {}, past)]
  const failing = new ScheduleRuntime(
    {
      createMessage: (text) => ({ id: 'm_fail', text, source: { kind: 'schedule' } }),
      deliver: async () => { throw new Error('Session persistence did not acknowledge the reminder') },
      logger: { warn: (m) => warnings.push(m) },
    },
    () => [...failTasks],
    async (work) => { await work() },
    async () => { check('投递失败不应提交任务状态', false) },
    { days: 30, records: 200 },
  )
  failing.requestDrive()
  await sleep(80)
  check('投递失败 → 任务保持原样(下次唤醒重试)', failTasks[0].status === 'active' && failTasks[0].record.scheduledAt === past)
  check('投递失败 → 记了 warn', warnings.some((w) => w.includes('were not acknowledged')), JSON.stringify(warnings))
}

/* ================= [四] 模型工具(dsh tool-schedule 的对外形状) ================= */
console.log('\n[四] 模型工具 schedule_create/list/update/delete')
{
  const registry = new ToolRegistry()
  registerScheduleTools(registry)
  const run = (name, args, ctx = { sid: SID }) => registry.get(name).run(args, ctx)
  const json = (result) => JSON.parse(result.content)

  const created = json(await run('schedule_create', { prompt: '巡检', title: '巡检任务', every_seconds: 600 }))
  check('create 返回 ScheduleView(state/deliveryMode)', created.kind === 'every' && created.deliveryMode === 'host' && ['scheduled', 'overdue'].includes(created.state), JSON.stringify(created))
  check('所有工具都声明了 access(写类)', ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'].every((n) => registry.get(n).access === 'write'))

  check('create 选择器个数不对 → invalid_selector', json(await run('schedule_create', { prompt: 'x', title: 'x' })).code === 'invalid_selector')
  check('create 空标题 → invalid_prompt', json(await run('schedule_create', { prompt: 'x', title: '  ', after_seconds: 60 })).code === 'invalid_prompt')
  check('create every 太小 → frequency_too_high', json(await run('schedule_create', { prompt: 'x', title: 'x', every_seconds: 30 })).code === 'frequency_too_high')
  check('子代理调用 → subagent_session', json(await run('schedule_list', {}, { sid: 'sa_sub' })).code === 'subagent_session')

  const listed = json(await run('schedule_list', {}))
  check('list 返回数组且含刚建的任务', Array.isArray(listed) && listed.some((r) => r.id === created.id), JSON.stringify(listed))

  const renamed = json(await run('schedule_update', { id: created.id, title: '改名了' }))
  check('update 成功返回新视图', renamed.id === created.id && renamed.title === '改名了', JSON.stringify(renamed))
  check('update 未知 id → schedule_not_found', json(await run('schedule_update', { id: 'schedule-nope', title: 'x' })).code === 'schedule_not_found')
  check('update id 带空白 → invalid_rule', json(await run('schedule_update', { id: ' x ', title: 'x' })).code === 'invalid_rule')
  check('update 什么也不改 → invalid_selector', json(await run('schedule_update', { id: created.id })).code === 'invalid_selector')

  const deleted = json(await run('schedule_delete', { id: created.id }))
  check('delete 成功 → {id, deleted:true}', deleted.deleted === true, JSON.stringify(deleted))
  check('delete 再来一次 → schedule_not_found', json(await run('schedule_delete', { id: created.id })).code === 'schedule_not_found')
}

/* ================= [五] RPC 面 ================= */
console.log('\n[五] RPC(dsh ScheduleService 的远程方法)')
{
  const handlers = new Map()
  registerSchedule({ register: (t, h) => handlers.set(t, h) })
  const call = async (type, msg = {}) => {
    const out = []
    await handlers.get(type)({ type, ...msg }, {
      reply: (p) => out.push(p), send: () => {}, emitStatus: () => {}, syncAgentScope: () => {},
    })
    return out[0]
  }
  const catalog = await call('schedule_catalog')
  check('schedule_catalog 返回 entries', Array.isArray(catalog?.entries), JSON.stringify(catalog).slice(0, 120))
  const list = await call('schedule_list', { sessionId: SID })
  check('schedule_list 返回 records', Array.isArray(list?.records))
  const history = await call('schedule_history', { sessionId: SID, id: 'schedule-nope', limit: 5 })
  check('schedule_history 未知任务 → schedule_not_found', history?.result?.code === 'schedule_not_found', JSON.stringify(history))
  const del = await call('schedule_delete', { sessionId: SID, id: 'schedule-nope' })
  check('schedule_delete 未知任务 → 不报错、回 {deleted:false}', del?.result?.deleted === false, JSON.stringify(del))
  const preview = await call('schedule_preview', { rule: { cron: { expression: '*/15 9-18 * * 1-5', time_zone: 'Asia/Shanghai' } }, count: 5 })
  check('schedule_preview 用同一份 domain 算出 5 次', preview?.next?.length === 5 && preview.kind === 'cron', JSON.stringify(preview))
  let bad = ''
  try { await call('schedule_preview', { rule: { cron: { expression: '@daily', time_zone: 'UTC' } } }) } catch (e) { bad = e.message }
  check('schedule_preview 非法 cron 报错(与创建同一口径)', /@daily|cron|five/.test(bad), bad)
}

/* ================= [六] 真实投递链路(delivery.ts → agent.submitAccepted) ================= */
// [三] 用的是假投递(deliver 立刻返回)。这里换成**真实的 DeliveryDeps**(server/schedule/delivery.ts),
// 证明搬过来的东西和宿主真接上了:
//   - 提醒以 [SCHEDULE REMINDER] 框架进目标会话,带上 source='schedule' / messageId / scheduleId;
//   - 会话确实收到了(消息进了事件日志,用 mock 模型把这一轮跑完);
//   - 投递成功后才提交:一次性任务转 inactive、回执写进 deliveryHistory。
console.log('\n[六] 真实投递链路(delivery.ts + agent.submitAccepted,mock 模型)')
{
  const { agent } = await import('../server/agent/agent.ts')
  const { LlmClient } = await import('../server/agent/llm.ts')
  const { localFs } = await import('../server/core/local-fs.ts')
  const { createDeliveryDeps } = await import('../server/schedule/delivery.ts')

  agent.llm = new LlmClient({ baseUrl: 'http://mock', apiKey: '', model: 'mock' })
  // mock 脚本最后一步会写 ai-notes.md,给它一个临时工作区,别落到项目目录里
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshai-sched-deliver-'))
  localFs.workspace = wsDir
  const sid = sessions.create('调度真实投递自测', 'local', { localWorkspace: wsDir }).id

  const tasks = [{
    sessionId: sid,
    record: {
      id: 'schedule-real-1', kind: 'at', title: '真实投递',
      prompt: '回复 OK', scheduledAt: new Date(Date.now() - 1_000).toISOString(),
    },
    status: 'active',
  }]
  const committed = []
  const warnings = []
  const runtime = new ScheduleRuntime(
    { ...createDeliveryDeps(), logger: { warn: (m) => warnings.push(m) } },
    () => [...tasks],
    async (work) => { await work() },
    async (task) => { committed.push(task); const i = tasks.findIndex((t) => t.record.id === task.record.id); if (i >= 0) tasks[i] = task },
    { days: 30, records: 200 },
  )
  runtime.requestDrive()
  await sleep(400)

  check('真实投递被接受并写回执', committed.length === 1, JSON.stringify(committed.map((t) => t.record.id)))
  const saved = tasks[0]
  check('一次性任务投递后转 inactive', saved.status === 'inactive', saved.status)
  check('回执里带 messageId 且与投递消息一致',
    typeof saved.lastDelivery?.messageId === 'string' && saved.lastDelivery.messageId.length > 0, JSON.stringify(saved.lastDelivery))
  check('投递历史记下这条(含当时 prompt)',
    saved.deliveryHistory?.records.length === 1 && saved.deliveryHistory.records[0].prompt === '回复 OK',
    JSON.stringify(saved.deliveryHistory))

  // mock 那一轮要跑几步工具调用,给它一点时间把 user/message 落进事件日志
  const deadline = Date.now() + 8_000
  let ev = null
  while (Date.now() < deadline) {
    ev = sessions.loadEvents(sid).find((e) => e.type === 'user/message' && e.data?.source === 'schedule') ?? null
    if (ev) break
    await sleep(100)
  }
  check('会话里真的收到了这条提醒', !!ev, JSON.stringify(sessions.loadEvents(sid).map((e) => e.type).slice(-4)))
  check('正文是 dsh 的提醒框架', !!ev && ev.data.content.includes('[SCHEDULE REMINDER]') && /reminder_prompt_json: "回复 OK"/.test(ev.data.content), String(ev?.data?.content).slice(0, 160))
  check('事件带 messageId / scheduleId(前端与回执能对上)',
    ev?.data?.messageId === saved.lastDelivery.messageId && ev?.data?.scheduleId === 'schedule-real-1',
    JSON.stringify({ mid: ev?.data?.messageId, sid: ev?.data?.scheduleId }))

  try { fs.rmSync(wsDir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}

/* ================= [七] 旧形状(上一版自写实现)任务库的一次性迁移 ================= */
// 用户手上可能还有上一版建的任务(`{version, tasks:[...], records:[...]}`)。服务端必须能读进来并
// 立刻按 dsh 形状写回,否则新 store 会因为"unit 缺失"直接拒绝打开 —— 等于把用户已有的任务挡在门外。
console.log('\n[七] 旧形状任务库的一次性迁移')
{
  const legacyFile = path.join(process.env.DATA_DIR, 'legacy-schedules.json')
  const legacyDoc = {
    version: 1,
    tasks: [{
      id: 'schedule-legacy-1',
      title: '每天查看一下最新新闻',
      prompt: '检查新闻最新内容是什么',
      enabled: false,
      scheduledAt: '2026-10-08T13:47:00.000Z',
      createdAt: '2026-10-07T13:45:42.929Z',
      sessionId: SID,
      scopeKey: 'local',
      kind: 'daily',
      time: '13:47',
      timeZone: 'UTC',
    }],
    records: [
      { id: 'run-1', taskId: 'schedule-legacy-1', sessionId: SID, startedAt: '2026-10-07T13:45:57.091Z', endedAt: '2026-10-07T13:47:07.151Z', result: 'success' },
      { id: 'run-2', taskId: 'schedule-legacy-1', sessionId: SID, startedAt: '2026-10-07T13:47:07.848Z', endedAt: '2026-10-07T13:47:47.868Z', result: 'missed' },
    ],
  }
  fs.writeFileSync(legacyFile, JSON.stringify(legacyDoc))
  const store = openScheduleStore(legacyFile)
  const rows = store.table.entries()
  check('旧任务被搬进 dsh 形状', rows.length === 1 && rows[0][0] === 'schedule-legacy-1', JSON.stringify(rows.map(([k]) => k)))
  const migrated = rows[0]?.[1]
  check('time 规范化为 HH:mm:ss.SSS', migrated?.record?.time === '13:47:00.000', String(migrated?.record?.time))
  check('enabled=false → status=inactive', migrated?.status === 'inactive', String(migrated?.status))
  check('只搬成功的投递记录,并映射成回执',
    migrated?.deliveryHistory?.records.length === 1 && migrated.deliveryHistory.records[0].messageId === 'legacy_run-1',
    JSON.stringify(migrated?.deliveryHistory))
  check('lastDelivery 与历史最后一条一致(才过得了 zod refine)',
    migrated?.lastDelivery?.messageId === migrated?.deliveryHistory?.records?.[0]?.messageId,
    JSON.stringify(migrated?.lastDelivery))
  const rewritten = JSON.parse(fs.readFileSync(legacyFile, 'utf8'))
  check('文件已按 dsh 形状写回(unit/global/tables.tasks)',
    rewritten.unit?.name === 'schedule' && rewritten.global === null && !!rewritten.tables?.tasks?.['schedule-legacy-1'],
    JSON.stringify(rewritten).slice(0, 140))
  check('写回后再打开不再迁移(形状已就绪)', openScheduleStore(legacyFile).table.entries().length === 1)
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`)
if (fail) process.exit(1)
