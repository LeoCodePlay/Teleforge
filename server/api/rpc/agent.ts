// 会话与对话消息:speak / stop_agent / get_history / clear_history / compact_now / session_*
import { agent } from '../../agent/agent.ts';
import { sshManager as ssh } from '../../core/ssh-manager.ts';
import { localFs } from '../../core/local-fs.ts';
import type { RpcModule } from './router.ts';

// 操作目标会话:前端带的 sid 优先。切服务器 / 新建会话都会让服务端「活跃会话」静默改变
// (syncAgentScope → setConnKey → _settleActive),只按活跃会话投递/停止/清空,就会把
// 动作落在用户并不在看的会话上(可能就是另一台服务器上正在后台跑的那个)。
// 缺省(旧客户端未带 sid、内部调用)回落当前活跃会话,行为与从前一致。
const targetSid = (msg: any): string | undefined =>
  (typeof msg?.sid === 'string' && msg.sid ? msg.sid : undefined);

export function registerAgent(rpc: RpcModule) {
  rpc.register('speak', async (msg, { reply, send, emitStatus }) => {
    // 原 ws.js speak case(445-458)逐字复制;附件(图片/文件/视频)为后加能力:
    // 纯附件消息允许 text 为空,附件按 id 解析,元数据以服务端存储为准
    const hasAttachments = Array.isArray(msg.attachments) && msg.attachments.length > 0;
    if (!msg.text?.trim() && !hasAttachments) throw new Error('指令为空');
    // 可连服务器对话(操作远程+本地),也可不连服务器仅操作本地工作区;
    // 任一侧选了「不在工作区对话」(全盘模式)同样可以对话(边界=整台机器)
    if (!ssh.workspace && !localFs.workspace && !ssh.noWorkspace && !localFs.noWorkspace) {
      throw new Error('请先选择远程工作区或本地工作区(或选择「不在工作区对话」)');
    }
    // 不 await:流式回收,事件经 send 推送;reasoning 为推理等级(default|off|low|high|xhigh|max)
    // 提交到当前活跃会话:该会话空闲时开新轮,运行中自动进入待执行队列(当前轮结束后按序执行)
    // 其他会话的运行不受影响(多会话并行)
    const sid = targetSid(msg) ?? agent.sessionId;
    Promise.resolve(agent.submit(sid, msg.text || '', {
      reasoning: msg.reasoning || 'default',
      attachments: hasAttachments ? msg.attachments : null
    }))
      .catch((e) => send({ type: 'agent', event: 'error', message: e.message, sid }))
      .finally(() => { emitStatus(); send({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId }); });
    emitStatus(); // busy 立即置位,让前端马上显示"停止/暂停"
    reply({ type: 'ok' });
  });

  rpc.register('stop_agent', async (msg, { reply, emitStatus }) => {
    // 按 sid 停止指定会话(缺省=活跃会话):不传 sid 就停不了用户正在看的那个会话
    agent.stop(targetSid(msg));
    emitStatus();
    reply({ type: 'ok' });
  });

  rpc.register('get_history', async (msg, { reply }) => {
    // 原 ws.js get_history case(210-212)逐字复制
    // permissionMode:当前会话的访问权限模式,前端输入区左下角选择器据此回显
    const sid = targetSid(msg);
    reply({ type: 'history', turns: agent.getHistory(sid), todos: agent.currentTodos(sid), queue: agent.queueSnapshot(sid), permissionMode: agent.getPermissionMode(sid) });
  });

  rpc.register('permission_get', async (msg, { reply }) => {
    // 当前会话的访问权限模式(变更前确认/自动编辑/计划模式/完全访问)
    reply({ type: 'permission', mode: agent.getPermissionMode() });
  });

  rpc.register('permission_default_get', async (msg, { reply }) => {
    // 全局默认访问权限模式(settings-store 持久化):新建会话继承的档位。
    // 新会话草稿态(尚未创建会话)据此回显输入区左下角的权限选择器。
    reply({ type: 'permission_default', mode: agent.getDefaultPermissionMode() });
  });

  rpc.register('permission_set', async (msg, { reply }) => {
    // 切换当前会话的访问权限模式:写入会话事件日志(可回放/分支继承)并广播
    // permission_changed;该档位同时持久化为全局默认,新会话直接继承
    reply({ type: 'permission', mode: agent.setPermissionMode(msg.mode) });
  });

  rpc.register('clear_history', async (msg, { reply, send }) => {
    // 原 ws.js clear_history case(213-217)逐字复制
    agent.clearHistory(targetSid(msg));
    reply({ type: 'ok' });
    send({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
  });

  rpc.register('compact_now', async (msg, { reply }) => {
    // 原 ws.js compact_now case(219-223)逐字复制
    // 手动压缩指定会话上下文(/compact 命令:无条件把早期对话压缩成摘要)。
    // 按 sid 定位目标会话:命令请求只带 sid,读 msg.id 会永远回落服务端「活跃会话」,
    // 两者失步时压缩就写进了用户并没在看的那个会话。
    const r = await agent.compactNow(targetSid(msg));
    reply({ type: 'ok', ...r });
  });

  rpc.register('session_list', async (msg, { reply }) => {
    // 原 ws.js session_list case(225-227)逐字复制
    reply({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
  });

  rpc.register('session_create', async (msg, { reply, emitStatus }) => {
    // 原 ws.js session_create case(228-233)逐字复制
    // 多会话并行:新建/切换不影响其他会话的运行
    // permissionMode:新会话生效的访问权限模式(=全局默认,见 settings-store),
    // 前端草稿态据此对齐权限选择器,避免"用户设了完全访问、新会话却显示变更前确认"
    const s = agent.createSession(msg.title);
    emitStatus(); // 新会话已捕获并应用绑定工作区,同步下发状态
    reply({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId, created: s, permissionMode: agent.getPermissionMode(s.id) });
  });

  rpc.register('session_switch', async (msg, { reply, emitStatus }) => {
    // 原 ws.js session_switch case(234-238)逐字复制
    agent.switchSession(msg.id);
    emitStatus(); // 切回会话时把绑定工作区应用到活动连接,下发新工作区供 UI 自动跟随
    reply({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
  });

  rpc.register('session_delete', async (msg, { reply, emitStatus }) => {
    // 原 ws.js session_delete case(239-243)逐字复制
    agent.deleteSession(msg.id);
    emitStatus(); // 删除活跃会话后 _settleActive 收敛到新会话,同步其绑定工作区
    reply({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
  });

  rpc.register('session_rename', async (msg, { reply }) => {
    // 原 ws.js session_rename case(244-247)逐字复制
    agent.renameSession(msg.id, msg.title);
    reply({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
  });

  rpc.register('session_fork', async (msg, { reply, emitStatus }) => {
    // 原 ws.js session_fork case(248-254)逐字复制
    // 从当前活跃会话创建分支(at 为 turns 索引,截断到该条消息为止;
    // 缺省 -1 从尾部整体克隆)并切换;分支继承源会话的工作区绑定
    const forked = agent.forkSession(typeof msg.at === 'number' && msg.at >= 0 ? msg.at : -1);
    emitStatus();
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
    reply({ type: 'ok', ...agent.steerQueueItem(msg.id, targetSid(msg)) });
  });

  rpc.register('queue_remove', async (msg, { reply }) => {
    // 从待执行队列移除一条消息(编辑=移除后由前端撤回输入框重新编辑)
    reply({ type: 'ok', ...agent.removeQueueItem(msg.id, targetSid(msg)) });
  });
}
