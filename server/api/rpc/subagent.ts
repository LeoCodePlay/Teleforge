// 子代理 RPC:按会话列出派发记录 + 拉取某次派发的完整对话。
// 低频控制类请求走这里;实时变更走 agent 事件总线(ws.ts 里的 event='subagent_changed')。
// 只读语义:子代理运行记录是"已发生事实"的快照,面板不提供任何修改入口(不删、不改、不续聊)。
import { get, list } from '../../store/subagent-store.ts';
import type { RpcModule } from './router.ts';

export function registerSubagent(rpc: RpcModule) {
  // sid 可选:不传 = 全部会话的派发记录(面板默认只查当前会话)
  rpc.register('subagent_list', async (msg, { reply }) => {
    const sid = msg.sid ? String(msg.sid) : null;
    reply({ type: 'subagent_list', sid, runs: list(sid) });
  });

  rpc.register('subagent_get', async (msg, { reply }) => {
    const runId = String(msg.runId || '');
    const run = get(runId);
    // 找不到(记录被保留策略清掉/换过数据目录)如实回 null,前端渲染"记录已不在"而不是空对话
    reply({ type: 'subagent_run', runId, run });
  });
}
