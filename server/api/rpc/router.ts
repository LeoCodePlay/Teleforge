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

export interface RpcCtx {
  send: (payload: any) => void;
  reply: (payload: any) => void;
  emitStatus: () => void;
  syncAgentScope: () => void;
}

export type RpcHandler = (msg: any, ctx: RpcCtx) => void | Promise<void>;

export interface RpcModule {
  register: (type: string, handler: RpcHandler) => void;
  ctx: RpcRouterCtx;
}

export interface RpcRouterCtx {
  send: (p: any) => void;
  emitStatus: () => void;
  syncAgentScope: () => void;
}

export function createRpcRouter(ctx: RpcRouterCtx) {
  const handlers = new Map<string, RpcHandler>();
  const register = (type: string, handler: RpcHandler) => {
    if (handlers.has(type)) throw new Error(`RPC 消息重复注册: ${type}`);
    handlers.set(type, handler);
  };
  const rpc = { register, ctx };
  registerSsh(rpc); registerAgent(rpc); registerSkills(rpc);
  registerConfig(rpc); registerLocal(rpc); registerRemote(rpc);
  registerTransfer(rpc); registerExec(rpc); registerAskUser(rpc);
  return {
    handle(msg: any): any {
      const handler = handlers.get(msg.type);
      if (!handler) throw new Error(`未知消息类型: ${msg.type}`);
      return handler(msg, { ...ctx, reply: (p: any) => ctx.send({ ...p, reqId: msg.reqId }) });
    },
    types(): string[] { return [...handlers.keys()]; },
    register
  };
}
