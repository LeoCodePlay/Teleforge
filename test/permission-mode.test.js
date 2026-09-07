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
registry.register({ name: 'read_file', run: () => 'content' });
registry.register({ name: 'write_file', run: () => 'written' });
registry.register({ name: 'run_command', run: () => 'ran' });
registry.register({ name: 'todo_write', run: () => 'todo' });
registerPermissionGuard(registry);

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

  // 作答"允许"放行
  for (const a of listPendingAsks()) answerAskUser(a.askId, [{ id: 'permission', selected: ['允许'] }]);
  const r3 = await pendingWrite;
  assert.equal(r3.isError, false, 'confirm: 审批允许后写入放行');
  await pendingCmd; // 同批已作答允许

  // 作答"拒绝" -> 结构化错误
  const p4 = run('run_command', sDefault);
  setTimeout(() => { for (const a of listPendingAsks()) answerAskUser(a.askId, [{ id: 'permission', selected: ['拒绝'] }]); }, 10);
  const r4 = await p4;
  assert.equal(r4.isError, true, 'confirm: 审批拒绝后命令拒绝执行');
  assert.match(r4.content, /用户拒绝了/);

  // plan:写/命令直接拒绝(无审批挂起),读放行
  const sPlan = makeSession(['plan']);
  const r5 = await run('write_file', sPlan);
  assert.equal(r5.isError, true, 'plan: 写工具直接拒绝');
  assert.match(r5.content, /计划模式/);
  const r6 = await run('run_command', sPlan);
  assert.equal(r6.isError, true, 'plan: 命令直接拒绝');
  assert.equal(listPendingAsks().length, 0, 'plan: 不发起审批');
  const r7 = await run('read_file', sPlan);
  assert.equal(r7.isError, false, 'plan: 读工具放行');

  // auto-edit:写放行,命令审批
  const sAuto = makeSession(['auto-edit']);
  const r8 = await run('write_file', sAuto);
  assert.equal(r8.isError, false, 'auto-edit: 写文件放行');
  const p9 = run('run_command', sAuto);
  setTimeout(() => { for (const a of listPendingAsks()) answerAskUser(a.askId, [{ id: 'permission', selected: ['允许'] }]); }, 10);
  const r9 = await p9;
  assert.equal(r9.isError, false, 'auto-edit: 命令审批允许后放行');
  assert.equal(listPendingAsks().length, 0);

  // full-access:全部放行,零审批
  const sFull = makeSession(['full-access']);
  assert.equal((await run('write_file', sFull)).isError, false, 'full-access: 写放行');
  assert.equal((await run('run_command', sFull)).isError, false, 'full-access: 命令放行');
  assert.equal(listPendingAsks().length, 0, 'full-access: 不发起审批');

  // 模式即时切换:运行中会话的日志追加 mode 事件后,下一次调用按新模式判定
  sFull.append('permission/mode', { mode: 'plan' });
  assert.equal((await run('write_file', sFull)).isError, true, '运行中切换到 plan 即时生效');

  console.log('permission-mode.test.js 全部通过');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
