// 权限模式判定冒烟测试(对应 server/agent/permission.ts + registry 异步 guard):
// - foldPermissionMode:默认/折叠/非法值回落
// - 四种模式对 read/write/command/meta 四类工具的 放行/审批/拒绝
// - confirm 审批流:emit 出 ask_user 事件,经 answerAskUser 作答放行/拒绝
// 运行:node test/permission-mode.test.js
// 说明:permission.ts 依赖 settings-store 的全局默认权限模式(读 data/settings.json),
// 需在临时目录里隔离运行,避免宿主机已持久化的默认档位干扰断言
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-perm-'));
const { ToolRegistry } = await import('../server/agent/registry.ts');
const { Session } = await import('../server/agent/session.ts');
const {
  foldPermissionMode, registerPermissionGuard, toolAccess, DEFAULT_PERMISSION_MODE
} = await import('../server/agent/permission.ts');
const { answerAskUser, listPendingAsks } = await import('../server/agent/ask-user.ts');

// ---- foldPermissionMode ----
assert.equal(foldPermissionMode([]), DEFAULT_PERMISSION_MODE);
const events = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'permission/mode', data: { mode: 'plan' } },
  { type: 'permission/mode', data: { mode: 'full-access' } }
];
assert.equal(foldPermissionMode(events), 'full-access');
assert.equal(foldPermissionMode([{ type: 'permission/mode', data: { mode: 'bogus' } }]), DEFAULT_PERMISSION_MODE);

// ---- toolAccess 分类 ----
assert.equal(toolAccess('read_file'), 'read');
assert.equal(toolAccess('ask_user_question'), 'meta');
assert.equal(toolAccess('write_file'), 'write');
assert.equal(toolAccess('run_command'), 'command');
assert.equal(toolAccess('edit_local_file'), 'write');
assert.equal(toolAccess('run_local_command'), 'command');

// ---- 注册表与异步守卫 ----
const registry = new ToolRegistry();
registry.register({ name: 'read_file', access: 'read', run: () => 'content' });
registry.register({ name: 'write_file', access: 'write', run: () => 'written' });
registry.register({ name: 'run_command', access: 'command', run: () => 'ran' });
registry.register({ name: 'todo_write', access: 'meta', run: () => 'todo' });
// 未声明 access 的新工具:必须 fail-closed 落到"需要审批"的一档
registry.register({ name: 'some_new_tool', run: () => 'ok' });
registry.register({ name: 'another_new_tool', run: () => 'ok' });
registerPermissionGuard(registry);

// ---- access 声明优先于名字名单 ----
assert.equal(toolAccess('write_file', registry.get('write_file')), 'write');
assert.equal(toolAccess('read_file', registry.get('read_file')), 'read');
assert.equal(toolAccess('run_command', registry.get('run_command')), 'command');
// 未声明 access:按 DEFAULT_TOOL_ACCESS(fail-closed),而不是当只读放行
assert.equal(toolAccess('some_new_tool', registry.get('some_new_tool')), 'write');
assert.equal(toolAccess('brand_new_name', registry.get('another_new_tool')), 'write');

function makeSession(modes = []) {
  const s = new Session();
  for (const m of modes) s.append('permission/mode', { mode: m });
  return s;
}
const run = (name, session) => registry.execute({
  name, args: JSON.stringify(name === 'run_command' ? { command: 'ls' } : { path: '/tmp/x' }),
  invokeCtx: { sid: 's1', session, emit: () => {} }
});

(async () => {
  // 默认(confirm):读放行、meta 放行、写/命令发起审批(此处无人作答,等待中)
  const sDefault = makeSession();
  const r1 = await run('read_file', sDefault);
  assert.equal(r1.isError, false, 'confirm: 读工具放行');
  const r2 = await run('todo_write', sDefault);
  assert.equal(r2.isError, false, 'confirm: meta 工具放行');
  // 不 await:审批挂起中,调用阻塞等待用户作答
  const pendingWrite = run('write_file', sDefault);
  const pendingCmd = run('run_command', sDefault);
  await new Promise((res) => setTimeout(res, 20)); // 等守卫走到审批挂起点
  const askEvt = listPendingAsks();
  assert.equal(askEvt.length, 2, 'confirm: 写/命令各挂起一条审批');
  // 审批题面必须带 kind='approval':前端据此渲染"只有拒绝/允许一次"的专用审批卡
  // (没有自定义回答输入),而不是带"其它"输入框的通用提问卡
  assert.equal(askEvt[0].questions[0].kind, 'approval', 'confirm: 审批题面带 kind=approval 标记');
  assert.equal(askEvt[0].questions[0].options?.[1]?.label, '允许一次', 'confirm: 允许动作 label 对齐 harness(允许一次)');

  // 作答"允许一次"放行
  for (const a of listPendingAsks()) answerAskUser(a.askId, [{ id: 'permission', selected: ['允许一次'] }]);
  const r3 = await pendingWrite;
  assert.equal(r3.isError, false, 'confirm: 审批允许后写入放行');
  await pendingCmd; // 同批已作答允许

  // 作答"拒绝" -> 结构化错误
  const p4 = run('run_command', sDefault);
  setTimeout(() => { for (const a of listPendingAsks()) answerAskUser(a.askId, [{ id: 'permission', selected: ['拒绝'] }]); }, 10);
  const r4 = await p4;
  assert.equal(r4.isError, true, 'confirm: 审批拒绝后命令拒绝执行');
  assert.match(r4.content, /用户拒绝了/);

  // 计划模式**不是**权限档位(dsh:guidance 与 enforcement 是两根轴):老日志里遗留的
  // permission/mode='plan' 不再拦任何工具 —— 与 dsh 的 "runs every call in plan mode untouched" 一致。
  // 计划模式真正的开关是独立的 plan/mode 事件,见 plan-mode.ts 与 goal-plan.test.js 场景 2。
  const sPlan = makeSession(['plan']);
  assert.equal((await run('write_file', sPlan)).isError, false, '遗留 plan 档位: 写工具不再被拒(与 dsh 一致)');
  assert.equal((await run('run_command', sPlan)).isError, false, '遗留 plan 档位: 命令不再被拒');
  assert.equal(listPendingAsks().length, 0, '遗留 plan 档位: 不发起审批');
  const r7 = await run('read_file', sPlan);
  assert.equal(r7.isError, false, '遗留 plan 档位: 读工具放行');

  // auto-edit:写放行,命令审批
  const sAuto = makeSession(['auto-edit']);
  const r8 = await run('write_file', sAuto);
  assert.equal(r8.isError, false, 'auto-edit: 写文件放行');
  const p9 = run('run_command', sAuto);
  setTimeout(() => { for (const a of listPendingAsks()) answerAskUser(a.askId, [{ id: 'permission', selected: ['允许一次'] }]); }, 10);
  const r9 = await p9;
  assert.equal(r9.isError, false, 'auto-edit: 命令审批允许后放行');
  assert.equal(listPendingAsks().length, 0);

  // full-access:全部放行,零审批
  const sFull = makeSession(['full-access']);
  assert.equal((await run('write_file', sFull)).isError, false, 'full-access: 写放行');
  assert.equal((await run('run_command', sFull)).isError, false, 'full-access: 命令放行');
  assert.equal(listPendingAsks().length, 0, 'full-access: 不发起审批');

  // 模式即时切换:运行中会话的日志追加 mode 事件后,下一次调用按新模式判定
  sFull.append('permission/mode', { mode: 'confirm' });
  setTimeout(() => { for (const a of listPendingAsks()) answerAskUser(a.askId, [{ id: 'permission', selected: ['允许一次'] }]); }, 10);
  assert.equal((await run('write_file', sFull)).isError, false, '运行中切回 confirm: 审批通过后放行');

  // ---- fail-closed 回归:未声明 access 的新工具不得静默放行 ----
  // 历史事故:toolAccess() 兜底分支曾返回 'read',导致新增写类工具忘记登记时
  // 既免审批、又在 plan 模式下照常执行。以下断言锁死该行为不再退化。
  assert.equal(toolAccess('some_new_tool'), 'write', '未登记工具名按 write 兜底(fail-closed)');

  // confirm 模式下:未声明 access 的工具必须发起审批,而不是直接执行
  const sFailClosed = makeSession();
  const pendingUnknown = run('some_new_tool', sFailClosed);
  await new Promise((res) => setTimeout(res, 20));
  const askList = listPendingAsks();
  assert.equal(askList.length, 1, 'confirm: 未声明 access 的工具必须挂起审批');
  for (const a of listPendingAsks()) answerAskUser(a.askId, [{ id: 'permission', selected: ['允许一次'] }]);
  assert.equal((await pendingUnknown).isError, false, 'confirm: 审批允许后放行');

  // 遗留 plan 档位下:未声明 access 的工具也照常执行(计划模式不再拦工具;兜底分类仍是 write)
  const sPlanFail = makeSession(['plan']);
  const rUnknownPlan = await run('some_new_tool', sPlanFail);
  assert.equal(rUnknownPlan.isError, false, '遗留 plan 档位: 未声明 access 的工具也放行(与 dsh 一致)');
  assert.equal(listPendingAsks().length, 0, '遗留 plan 档位: 不发审批');

  // ---- 跨会话隔离回归:全局默认档位只能给"新会话"播种,绝不能当成已有会话的实时 fallback ----
  // 历史事故:foldPermissionMode 的 fallback 传了全局默认设置,而 permission_set 又会把
  // 当前会话选的档位同步成全局默认。于是"会话 B 切计划模式"会让所有还没有自己 mode 事件的
  // 会话 A 跟着变成只读 —— 表现为跨会话串档。以下断言锁死:无 mode 事件 = 会话级默认 confirm,
  // 与全局默认设置无关。
  const { setDefaultPermissionMode, getDefaultPermissionMode } = await import('../server/store/settings-store.ts');
  setDefaultPermissionMode('full-access');
  assert.equal(getDefaultPermissionMode(), 'full-access', '全局默认已设为完全访问');
  assert.equal(foldPermissionMode([]), 'confirm', '无 mode 事件回落会话级默认 confirm,不吃全局默认');
  assert.equal(
    foldPermissionMode([{ type: 'permission/mode', data: { mode: 'plan' } }]),
    'plan',
    '有 mode 事件时只认自己日志里的值'
  );
  // 全局默认是完全访问时,一个没有任何 mode 事件的会话仍必须走审批(而不是被静默放行)
  const sNoEvent = makeSession();
  const pendingNoEvent = run('write_file', sNoEvent);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(listPendingAsks().length, 1, '全局默认=完全访问时,无 mode 事件的会话仍必须审批');
  for (const a of listPendingAsks()) answerAskUser(a.askId, [{ id: 'permission', selected: ['允许一次'] }]);
  assert.equal((await pendingNoEvent).isError, false, '审批放行后写入成功');

  console.log('permission-mode.test.js 全部通过');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
