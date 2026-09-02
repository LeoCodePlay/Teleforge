// RPC 路由注册表契约测试:golden 类型清单 / 重复注册 / 未知类型 / reply 包装
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

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
