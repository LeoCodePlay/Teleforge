// RPC 路由注册表核心:register/handle/types + 重复注册检测
import { registerSsh } from './ssh.js';
import { registerAgent } from './agent.js';
import { registerSkills } from './skills.js';
import { registerConfig } from './config.js';
import { registerLocal } from './local.js';
import { registerRemote } from './remote.js';
import { registerTransfer } from './transfer.js';
import { registerExec } from './exec.js';
import { registerAskUser } from './ask-user.js';

export function createRpcRouter(ctx) {
  const handlers = new Map();
  const register = (type, handler) => {
    if (handlers.has(type)) throw new Error(`RPC 消息重复注册: ${type}`);
    handlers.set(type, handler);
  };
  const rpc = { register, ctx };
  registerSsh(rpc); registerAgent(rpc); registerSkills(rpc);
  registerConfig(rpc); registerLocal(rpc); registerRemote(rpc);
  registerTransfer(rpc); registerExec(rpc); registerAskUser(rpc);
  return {
    handle(msg) {
      const handler = handlers.get(msg.type);
      if (!handler) throw new Error(`未知消息类型: ${msg.type}`);
      return handler(msg, { ...ctx, reply: (p) => ctx.send({ ...p, reqId: msg.reqId }) });
    },
    types() { return [...handlers.keys()]; },
    register
  };
}
