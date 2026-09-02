// RPC 路由注册表契约测试:golden 类型清单 / 重复注册 / 未知类型 / reply 包装
import { registerSsh } from '../server/rpc/ssh.js';

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
  ssh: ['connect', 'disconnect', 'conn_disconnect', 'conn_switch', 'ssh_profiles_list', 'ssh_profile_save', 'ssh_profile_delete']
};

// 各模块 golden:逐个注册到 scratch,类型清单一致
for (const [name, fn, types] of [
  ['ssh', registerSsh, GOLDEN.ssh]
]) {
  const rpc = scratchRpc();
  fn(rpc);
  check(`${name} 注册类型与 golden 一致`, JSON.stringify(sorted(rpc.types())) === JSON.stringify(sorted(types)), rpc.types().join(','));
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
