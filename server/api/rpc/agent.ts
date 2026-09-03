// 会话与对话消息:speak / stop_agent / get_history / clear_history / compact_now / session_*
import { agent } from '../../agent/agent.ts';
import { sshManager as ssh } from '../../core/ssh-manager.ts';
import { localFs } from '../../core/local-fs.ts';
import type { RpcModule } from './router.ts';

export function registerAgent(rpc: RpcModule) {
  rpc.register('speak', async (msg, { reply, send, emitStatus }) => {
    // 原 ws.js speak case(445-458)逐字复制
    if (!msg.text?.trim()) throw new Error('指令为空');
    // 可连服务器对话(操作远程+本地),也可不连服务器仅操作本地工作区
    if (!ssh.workspace && !localFs.workspace) throw new Error('请先选择远程工作区或本地工作区');
    // 不 await:流式回收,事件经 send 推送;reasoning 为推理等级(default|off|low|high|xhigh|max)
    // 提交到当前活跃会话:该会话空闲时开新轮,运行中自动进入待执行队列(当前轮结束后按序执行)
    // 其他会话的运行不受影响(多会话并行)
    Promise.resolve(agent.submit(agent.sessionId, msg.text, { reasoning: msg.reasoning || 'default' }))
      .catch((e) => send({ type: 'agent', event: 'error', message: e.message, sid: agent.sessionId }))
      .finally(() => { emitStatus(); send({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId }); });
    emitStatus(); // busy 立即置位,让前端马上显示"停止/暂停"
    reply({ type: 'ok' });
  });

  rpc.register('stop_agent', async (msg, { reply, emitStatus }) => {
    // 原 ws.js stop_agent case(459-463)逐字复制
    agent.stop();
    emitStatus();
    reply({ type: 'ok' });
  });

  rpc.register('get_history', async (msg, { reply }) => {
    // 原 ws.js get_history case(210-212)逐字复制
    reply({ type: 'history', turns: agent.getHistory(), todos: agent.currentTodos(), queue: agent.queueSnapshot(agent.sessionId) });
  });

  rpc.register('clear_history', async (msg, { reply, send }) => {
    // 原 ws.js clear_history case(213-217)逐字复制
    agent.clearHistory();
    reply({ type: 'ok' });
    send({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
  });

  rpc.register('compact_now', async (msg, { reply }) => {
    // 原 ws.js compact_now case(219-223)逐字复制
    // 手动压缩当前会话上下文(/compact 命令:无条件把早期对话压缩成摘要)
    const r = await agent.compactNow(msg.id);
    reply({ type: 'ok', ...r });
  });

  rpc.register('session_list', async (msg, { reply }) => {
    // 原 ws.js session_list case(225-227)逐字复制
    reply({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
  });

  rpc.register('session_create', async (msg, { reply }) => {
    // 原 ws.js session_create case(228-233)逐字复制
    // 多会话并行:新建/切换不影响其他会话的运行
    const s = agent.createSession(msg.title);
    reply({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId, created: s });
  });

  rpc.register('session_switch', async (msg, { reply }) => {
    // 原 ws.js session_switch case(234-238)逐字复制
    agent.switchSession(msg.id);
    reply({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
  });

  rpc.register('session_delete', async (msg, { reply }) => {
    // 原 ws.js session_delete case(239-243)逐字复制
    agent.deleteSession(msg.id);
    reply({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
  });

  rpc.register('session_rename', async (msg, { reply }) => {
    // 原 ws.js session_rename case(244-247)逐字复制
    agent.renameSession(msg.id, msg.title);
    reply({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
  });

  rpc.register('session_fork', async (msg, { reply }) => {
    // 原 ws.js session_fork case(248-254)逐字复制
    // 从当前活跃会话创建分支(at 为 turns 索引,截断到该条消息为止;
    // 缺省 -1 从尾部整体克隆)并切换
    const forked = agent.forkSession(typeof msg.at === 'number' && msg.at >= 0 ? msg.at : -1);
    reply({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId, created: forked });
  });

  rpc.register('message_delete', async (msg, { reply, send }) => {
    // 删除一条用户消息(及其所在轮回复);成功后把最新历史一并返回,前端免二次拉取
    agent.deleteMessageAt(typeof msg.at === 'number' ? msg.at : -1);
    reply({ type: 'ok', turns: agent.getHistory(), todos: agent.currentTodos() });
    send({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
  });

  rpc.register('message_rewind', async (msg, { reply, send }) => {
    // 回到本轮对话发起前:截断该条消息及其之后的所有内容;返回最新历史
    agent.rewindToBefore(typeof msg.at === 'number' ? msg.at : -1);
    reply({ type: 'ok', turns: agent.getHistory(), todos: agent.currentTodos() });
    send({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
  });

  rpc.register('queue_steer', async (msg, { reply }) => {
    // 立即执行一条待执行队列消息:忙碌时作为下一步注入当前运行,空闲时直接开新轮
    reply({ type: 'ok', ...agent.steerQueueItem(msg.id) });
  });

  rpc.register('queue_remove', async (msg, { reply }) => {
    // 从待执行队列移除一条消息(编辑=移除后由前端撤回输入框重新编辑)
    reply({ type: 'ok', ...agent.removeQueueItem(msg.id) });
  });
}
