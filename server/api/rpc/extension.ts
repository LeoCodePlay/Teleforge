// 真机浏览器(扩展桥接)RPC:连接状态 / 标签清单 / 授权 / 操作模式。
//
// 刻意**不在这里暴露配对 token** —— token 只走 /api/browser-bridge/pair(要求自定义头,
// 网页触发预检后拿不到响应)。若把它放进这条无鉴权的 /ws 通道,
// 任意本机网页都能连上把 token 读走,进而冒充扩展接管用户浏览器。
import { browserBridge } from '../../core/browser-bridge.ts';
import type { RpcModule } from './router.ts';

export function registerExtension(rpc: RpcModule) {
  // 当前状态:是否在线、扩展版本、标签清单(含每个标签是否允许 AI 操作)
  rpc.register('ext_status', async (_msg, { reply }) => {
    reply({ type: 'ext_status', ...browserBridge.status() });
  });

  // 标签清单(前端面板轮询用;状态变化也会由 /ws 主动广播 ext_status)
  rpc.register('ext_tabs', async (_msg, { reply }) => {
    const st = browserBridge.status();
    reply({ type: 'ext_tabs', online: st.online, tabs: st.tabs });
  });

  // 用户把某个标签「交给 AI」
  rpc.register('ext_grant', async (msg, { reply }) => {
    browserBridge.grant(Number(msg.tabId));
    reply({ type: 'ext_status', ...browserBridge.status() });
  });

  // 收回授权(同时清掉「AI 自建」标记,避免撤销后又被算作可操作)
  rpc.register('ext_revoke', async (msg, { reply }) => {
    browserBridge.revoke(Number(msg.tabId));
    reply({ type: 'ext_status', ...browserBridge.status() });
  });

  // 操作模式:'ai-tabs'(默认,只碰 AI 自建 + 用户授权的标签)| 'all'(放开全部)
  rpc.register('ext_set_mode', async (msg, { reply }) => {
    browserBridge.setMode(msg.mode === 'all' ? 'all' : 'ai-tabs');
    reply({ type: 'ext_status', ...browserBridge.status() });
  });
}
