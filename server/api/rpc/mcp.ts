// MCP 服务接入的 RPC 消息:读取清单与状态 / 保存整份配置 / 整体重连。
//
// 配置就是一份 JSON(数组,每个元素一个 server),界面直接编辑这份 JSON:
//   mcp_list    读 -> { type:'mcp_servers', servers:[{config,status}] }
//   mcp_save    写 <- { servers:[…] }(整份替换,只重建真正变化的 server)
//   mcp_reload  让所有连接按当前磁盘配置重连(排查用)
import { mcpManager } from '../../mcp/manager.ts';
import type { RpcModule } from './router.ts';

/** 统一的应答体:完整清单 + 每个 server 的当前状态。 */
function payload() {
  return { type: 'mcp_servers', servers: mcpManager.statuses() };
}

export function registerMcp(rpc: RpcModule) {
  rpc.register('mcp_list', async (msg, { reply }) => {
    reply(payload());
  });

  // 整份替换:校验的是"这整份配置",所以一份写坏的配置不会落盘、也不会动现有连接。
  rpc.register('mcp_save', async (msg, { reply }) => {
    await mcpManager.saveAll(msg.servers);
    reply(payload());
  });

  rpc.register('mcp_reload', async (msg, { reply }) => {
    await mcpManager.reload();
    reply(payload());
  });
}
