// RPC 路由注册表契约测试:golden 类型清单 / 重复注册 / 未知类型 / reply 包装
import { createRpcRouter } from '../server/rpc/router.js';
import { registerSsh } from '../server/rpc/ssh.js';
import { registerAgent } from '../server/rpc/agent.js';
import { registerSkills } from '../server/rpc/skills.js';
import { registerConfig } from '../server/rpc/config.js';
import { registerLocal } from '../server/rpc/local.js';
import { registerRemote } from '../server/rpc/remote.js';
import { registerTransfer } from '../server/rpc/transfer.js';
import { registerExec } from '../server/rpc/exec.js';
import { registerAskUser } from '../server/rpc/ask-user.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };
const sorted = (a) => [...a].sort();

// 造一个最小 rpc 注册器(与 router.js 相同的重复注册守卫)
const scratchRpc = () => {
  const handlers = new Map();
  const rpc = {
    register: (t, h) => {
      if (handlers.has(t)) throw new Error(`RPC 消息重复注册: ${t}`);
      handlers.set(t, h);
    },
    types: () => [...handlers.keys()]
  };
  return rpc;
};

const GOLDEN = {
  ssh:      ['connect', 'disconnect', 'conn_disconnect', 'conn_switch', 'ssh_profiles_list', 'ssh_profile_save', 'ssh_profile_delete'],
  agent:    ['speak', 'stop_agent', 'get_history', 'clear_history', 'compact_now', 'session_list', 'session_create', 'session_switch', 'session_delete', 'session_rename', 'session_fork'],
  skills:   ['skills_list', 'skill_get', 'skill_save', 'skill_delete', 'skill_copy_builtin'],
  config:   ['llm', 'get_status', 'tools_list', 'tool_toggle', 'prompt_inject_get', 'prompt_inject_set'],
  local:    ['list_local_dir', 'read_local_file', 'write_local_file', 'create_local_dir', 'local_delete', 'local_copy', 'set_local_workspace'],
  remote:   ['list_dir', 'read_file', 'write_file', 'create_dir', 'delete', 'copy', 'set_workspace'],
  transfer: ['local_to_remote', 'remote_to_local'],
  exec:     ['run_command', 'stop_command'],
  'ask-user': ['ask_user_answer', 'ask_user_cancel']
};

// 各模块 golden:逐个注册到 scratch,类型清单一致
for (const [name, fn, types] of [
  ['ssh', registerSsh, GOLDEN.ssh],
  ['agent', registerAgent, GOLDEN.agent],
  ['skills', registerSkills, GOLDEN.skills],
  ['config', registerConfig, GOLDEN.config],
  ['local', registerLocal, GOLDEN.local],
  ['remote', registerRemote, GOLDEN.remote],
  ['transfer', registerTransfer, GOLDEN.transfer],
  ['exec', registerExec, GOLDEN.exec],
  ['ask-user', registerAskUser, GOLDEN['ask-user']]
]) {
  const rpc = scratchRpc();
  fn(rpc);
  check(`${name} 注册类型与 golden 一致`, JSON.stringify(sorted(rpc.types())) === JSON.stringify(sorted(types)), rpc.types().join(','));
}

// ---- router 全量 ----
const ALL49 = [...Object.values(GOLDEN)].flat();
const sent = [];
const router = createRpcRouter({
  send: (p) => sent.push(p),
  emitStatus() {},
  syncAgentScope() {}
});
check('router 注册全部 49 种类型', JSON.stringify(sorted(router.types())) === JSON.stringify(sorted(ALL49)),
  `缺/多: ${sorted(router.types()).filter((t) => !ALL49.includes(t)).join(',') || '(无)'}`);

// 重复注册被拒
let dup = '';
try { router.register('list_dir', async () => {}); } catch (e) { dup = e.message; }
check('重复注册抛「RPC 消息重复注册」', dup === 'RPC 消息重复注册: list_dir', dup);

// 未知类型抛「未知消息类型」
let unk = '';
try { router.handle({ type: 'nope', reqId: 'x' }); } catch (e) { unk = e.message; }
check('未知类型抛「未知消息类型」', unk === '未知消息类型: nope', unk);

// 离线安全端到端:get_status 经 stub ctx 验证 reply 注入 reqId
sent.length = 0;
await router.handle({ type: 'get_status', reqId: 'r7' });
const okMsg = sent.find((p) => p.type === 'ok');
check('get_status 回复携带 reqId', okMsg && okMsg.reqId === 'r7', JSON.stringify(sent));

// tools_list / llm 离线安全(仅读注册表 / 配置 agent.llm,无 I/O)
sent.length = 0;
await router.handle({ type: 'tools_list', reqId: 'r8' });
check('tools_list 返回工具清单', sent.some((p) => p.type === 'tools' && Array.isArray(p.tools)), JSON.stringify(sent));
sent.length = 0;
await router.handle({ type: 'llm', reqId: 'r9', llm: { provider: 'mock', model: 'm' } });
check('llm 回复 ok', sent.some((p) => p.type === 'ok' && p.reqId === 'r9'), JSON.stringify(sent));

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
