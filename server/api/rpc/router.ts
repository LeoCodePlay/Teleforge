// RPC 路由注册表核心:register/handle/types + 重复注册检测
import { registerSsh } from './ssh.ts';
import { registerAgent } from './agent.ts';
import { registerSkills } from './skills.ts';
import { registerConfig } from './config.ts';
import { registerLocal } from './local.ts';
import { registerRemote } from './remote.ts';
import { registerTransfer } from './transfer.ts';
import { registerExec } from './exec.ts';
import { registerAskUser } from './ask-user.ts';

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
