// 访问权限模式的**跨会话隔离**回归(对应 agent.ts 的 getPermissionMode / _pinDefaultPermission):
// - 全局默认档位只给"新会话/清空历史后的会话"播种,绝不作为已有会话的实时 fallback;
// - 会话 B 改档位(或进/出计划模式)不得回溯改变会话 A;
// - 没有 mode 事件的旧会话回落会话级默认 confirm,不吃全局默认(否则就是串档 bug 的根因);
// - 计划模式与权限档位**正交**(dsh 的 guidance/enforcement 两根轴):进出计划模式既不写
//   permission/mode,也不写全局默认 —— 它只写自己的 plan/mode 事件。
// 运行:node test/permission-session-isolation.test.js
// 说明:与 permission-mode.test.js 同理,需在临时目录隔离 settings.json / 会话存储。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-perm-iso-'));

const { Agent } = await import('../server/agent/agent.ts');
const { sshManager: ssh } = await import('../server/core/ssh-manager.ts');
const sessions = await import('../server/store/session-store.ts');
const { setDefaultPermissionMode, getDefaultPermissionMode } = await import('../server/store/settings-store.ts');

// 会话创建/绑定会读连接状态,给它一个稳定的假连接(同 goal-plan.test.js 的做法)
ssh.status = 'connected';
ssh.platform = 'posix';
ssh.workspace = '/home';
ssh.hostInfo = { host: 'h', port: 22, username: 'u' };

const emitted = [];
const agent = new Agent({ emit: (e, p) => emitted.push([e, p]) });

// ---- 1. 新会话播种当时的全局默认,之后与全局默认脱钩 ----
setDefaultPermissionMode('full-access');
assert.equal(getDefaultPermissionMode(), 'full-access');
const a = agent.createSession('A').id;
assert.equal(agent.getPermissionMode(a), 'full-access', '新会话继承创建时的全局默认档位');

const b = agent.createSession('B').id;
assert.equal(agent.getPermissionMode(b), 'full-access', '第二个新会话同样继承');

// ---- 2. 会话 B 切档位,不得改变会话 A ----
agent.setPermissionMode('auto-edit', b); // 模拟权限选择器:permission_set(默认会同步全局默认)
assert.equal(agent.getPermissionMode(b), 'auto-edit', 'B 切到自动编辑');
assert.equal(agent.getPermissionMode(a), 'full-access', 'B 切档位后 A 仍是完全访问(不串档)');

// ---- 3. 计划模式与权限档位正交:B 进计划模式不动档位、也不动 A ----
// 计划模式的广播走模块级单例 agent(宿主回调注册在单例创建之前,回调体延迟取它),
// 所以这里临时接管单例的 emit 来验广播,结束后原样还原。
const { agent: singletonAgent } = await import('../server/agent/agent.ts');
const singletonEvents = [];
const origEmit = singletonAgent.emit;
singletonAgent.emit = (event, payload) => { singletonEvents.push([event, payload]); };
const inPlan = agent.planCommand('', b);
assert.equal(inPlan.active, true, 'B 进入计划模式');
assert.equal(agent.isPlanMode(b), true, 'B 在计划模式');
assert.equal(agent.isPlanMode(a), false, 'A 不在计划模式');
assert.equal(agent.getPermissionMode(b), 'auto-edit', '进计划模式不改 B 的权限档位(两根轴正交)');
assert.equal(agent.getPermissionMode(a), 'full-access', 'A 的档位不受影响');
assert.equal(getDefaultPermissionMode(), 'auto-edit', '计划模式从不写全局默认');

// ---- 4. 会话 B 退出计划模式:回到未开启,且仍不影响 A / 档位 ----
agent.planCommand('off', b);
assert.equal(agent.isPlanMode(b), false, 'B 退出计划模式');
assert.equal(agent.getPermissionMode(b), 'auto-edit', '退出计划模式不改档位');
assert.equal(agent.getPermissionMode(a), 'full-access', 'A 依旧不受影响');
assert.equal(getDefaultPermissionMode(), 'auto-edit', '退出计划模式也不写全局默认');
singletonAgent.emit = origEmit;

// ---- 5. 没有 mode 事件的旧会话回落会话级默认 confirm,不吃全局默认 ----
// 这是历史 bug 的核心:旧会话(日志里没有 permission/mode)以前会把全局默认当实时 fallback,
// 于是别的会话一改档位,它就跟着变。
setDefaultPermissionMode('full-access');
const legacy = sessions.create('旧会话', 'local');
sessions.saveEvents(legacy.id, []);
assert.equal(
  agent.getPermissionMode(legacy.id),
  'confirm',
  '无 mode 事件的会话回落 confirm,不继承全局默认(不串档)'
);

// ---- 6. 播种只发生在空会话:已有意图的会话绝不被覆盖 ----
setDefaultPermissionMode('auto-edit');
assert.equal(agent.getPermissionMode(a), 'full-access', 'A 自己的意图不被后来的默认值改写');
const c = agent.createSession('C').id;
assert.equal(agent.getPermissionMode(c), 'auto-edit', '再新建的会话播种新的全局默认');

// ---- 7. 广播带有正确的 sid(前端据此只更新对应会话的选择器) ----
const changes = emitted.filter(([, p]) => p?.event === 'permission_changed');
assert.equal(changes.length, 1, 'permission_changed 只广播了 B 的一次档位切换');
assert.equal(changes[0][1].sid, b, '广播绑定 B');
assert.equal(changes.every(([, p]) => p.sid === b), true, '没有任何一次广播绑定到 A');
// 计划模式的变更走自己的事件(plan_mode_changed),不混进 permission_changed
const planChanges = singletonEvents.filter(([, p]) => p?.event === 'plan_mode_changed');
assert.equal(planChanges.length, 2, 'plan_mode_changed 广播了 B 的进入与退出各一次');
assert.equal(planChanges.every(([, p]) => p.sid === b), true, '计划模式广播也只绑定 B');

console.log('permission-session-isolation.test.js 全部通过');
process.exit(0);
