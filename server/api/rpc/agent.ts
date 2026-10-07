// 会话与对话消息:speak / stop_agent / get_history / clear_history / compact_now / session_*
//
// 子代理会话(sa_…)复用同一套 RPC:对话前端(ChatPanel)不需要知道自己在渲染谁 ——
// 它按 sid 拿历史、发消息、停止、排队,而这两个世界在服务端按 sid 前缀分流。
// 这不是权宜之计,而是 harness 的形态:子代理本来就是"一个会话",前端同一套对话系统。
import { agent, projectEvents, toolRegistry } from '../../agent/agent.ts';
import { resolveMentionImageAttachments } from '../../agent/mention-refs.ts';
import { sshManager as ssh } from '../../core/ssh-manager.ts';
import { localFs } from '../../core/local-fs.ts';
import { browserManager } from '../../core/browser-manager.ts';
import { foldSessionStats, foldTokenUsage } from '../../agent/session.ts';
import { get as getSubagentRun } from '../../store/subagent-store.ts';
import {
  isChildId, childSessionFor, childQueueSnapshot, queueSteer as childQueueSteer,
  queueRemove as childQueueRemove, sendMessage as sendChildMessage, interruptChild,
  parentNotifier, captureBinding, isResident
} from '../../agent/subagent-runtime.ts';
import type { RpcModule } from './router.ts';

// 操作目标会话:前端带的 sid 优先。切服务器 / 新建会话都会让服务端「活跃会话」静默改变
// (syncAgentScope → setConnKey → _settleActive),只按活跃会话投递/停止/清空,就会把
// 动作落在用户并不在看的会话上(可能就是另一台服务器上正在后台跑的那个)。
// 缺省(旧客户端未带 sid、内部调用)回落当前活跃会话,行为与从前一致。
const targetSid = (msg: any): string | undefined =>
  (typeof msg?.sid === 'string' && msg.sid ? msg.sid : undefined);

/** 子代理 id 的冷恢复/通知依赖(人类从子会话界面发消息时用;模型那条路在 tools.ts 里) */
function childResumeDeps(runId: string) {
  const rec = getSubagentRun(runId);
  const parentSid = rec?.sid ?? null;
  return {
    llm: agent._llmFor(parentSid),
    registry: toolRegistry,
    emit: agent.emit as (event: string, payload: any) => void,
    notifyParent: parentNotifier(agent, parentSid),
    binding: captureBinding(agent, parentSid)
  };
}

/**
 * 子代理会话的历史:与父会话**同一形状**。
 * turns 由 projectEvents 投影子会话事件(与父会话同一个函数),于是前端能拿同一个
 * ChatPanel 渲染它:同样的回合折叠行、同样的工具行、同样的批注与统计。
 */
function childHistoryReply(runId: string) {
  const rec = getSubagentRun(runId);
  const session = childSessionFor(runId);
  const events: any[] = session ? session.events : [];
  return {
    type: 'history',
    turns: projectEvents(events),
    todos: [],                                   // 子代理的工具白名单里没有 todo_write
    queue: childQueueSnapshot(runId),
    // 子代理的权限在派发时固定(harness:delegation scope 不能被自己放宽):
    // 回父会话当前的档位,前端在子会话里把这个选择器显示成只读
    permissionMode: agent.getPermissionMode(rec?.sid ?? undefined),
    usage: foldTokenUsage(events),
    stats: foldSessionStats(events),
    compacting: false,
    goal: null,
    // 子代理视图的附加信息(父会话不需要):派发记录 id / 是否还能继续 / 所属父会话
    subagent: rec ? { runId, sid: rec.sid ?? null, mode: rec.mode ?? 'continuable', resident: isResident(runId) } : null
  };
}

export function registerAgent(rpc: RpcModule) {
  rpc.register('speak', async (msg, { reply, send, emitStatus }) => {
    // 原 ws.js speak case(445-458)逐字复制;附件(图片/文件/视频)为后加能力:
    // 纯附件消息允许 text 为空,附件按 id 解析,元数据以服务端存储为准
    const hasAttachments = Array.isArray(msg.attachments) && msg.attachments.length > 0;
    if (!msg.text?.trim() && !hasAttachments) throw new Error('指令为空');
    // 子代理会话:同一条 speak 走子代理运行时(排队/唤醒/冷恢复都在那边)
    const childTarget = targetSid(msg);
    if (isChildId(childTarget)) {
      if (hasAttachments) throw new Error('子代理会话暂不支持附件:把要它看的内容写成文字,或在父会话里发送附件。');
      sendChildMessage(String(childTarget), String(msg.text || ''), {
        from: 'human', delivery: 'queue', resume: childResumeDeps(String(childTarget))
      });
      reply({ type: 'ok' });
      return;
    }
    // 可连服务器对话(操作远程+本地),也可不连服务器仅操作本地工作区;
    // 任一侧选了「不在工作区对话」(全盘模式)同样可以对话(边界=整台机器)
    if (!ssh.workspace && !localFs.workspace && !ssh.noWorkspace && !localFs.noWorkspace) {
      throw new Error('请先选择远程工作区或本地工作区(或选择「不在工作区对话」)');
    }
    // 不 await:流式回收,事件经 send 推送;reasoning 为推理等级(default|off|low|high|xhigh|max)
    // 提交到当前活跃会话:该会话空闲时开新轮,运行中自动进入待执行队列(当前轮结束后按序执行)
    // 其他会话的运行不受影响(多会话并行)
    const sid = targetSid(msg) ?? agent.sessionId;
    // @引用的图片文件补成附件:过去 @local:/@remote: 只是给模型的路径提示,多模态看不到画面、
    // generate_image 也拿不到附件 id,导致「@一张图让我改」无法完成。补成附件后与粘贴图片
    // 走完全相同的链路(请求期 image_url 注入 + reference_attachment_ids)。
    const refAtts = Array.isArray(msg.refs) ? await resolveMentionImageAttachments(msg.refs) : [];
    const attachments: any = [...(hasAttachments ? msg.attachments : []), ...refAtts];
    Promise.resolve(agent.submit(sid, msg.text || '', {
      reasoning: msg.reasoning || 'default',
      attachments: attachments.length ? attachments : null
    }))
      .catch((e) => send({ type: 'agent', event: 'error', message: e.message, sid }))
      .finally(() => { emitStatus(); send({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId }); });
    emitStatus(); // busy 立即置位,让前端马上显示"停止/暂停"
    reply({ type: 'ok' });
  });

  rpc.register('stop_agent', async (msg, { reply, emitStatus }) => {
    // 按 sid 停止指定会话(缺省=活跃会话):不传 sid 就停不了用户正在看的那个会话
    const sid = targetSid(msg);
    // 子代理会话:停止 = 暂停它的当前这一轮(排队保留、可继续),与父会话的"停止本轮"同语义
    if (isChildId(sid)) interruptChild(String(sid), '用户暂停');
    else agent.stop(sid);
    emitStatus();
    reply({ type: 'ok' });
  });

  rpc.register('get_history', async (msg, { reply }) => {
    // 原 ws.js get_history case(210-212)逐字复制
    // permissionMode:当前会话的访问权限模式,前端输入区左下角选择器据此回显
    const sid = targetSid(msg);
    // 子代理会话:同一份历史形状(projectEvents 投影子会话事件),前端同一个 ChatPanel 渲染
    if (isChildId(sid)) { reply(childHistoryReply(String(sid))); return; }
    reply({
      type: 'history',
      turns: agent.getHistory(sid),
      todos: agent.currentTodos(sid),
      queue: agent.queueSnapshot(sid),
      permissionMode: agent.getPermissionMode(sid),
      // 统计栏数据随历史一起下发:刷新/切会话后立即正确,不必等下一步的 session_stats 事件
      usage: agent.sessionUsage(sid),
      stats: agent.sessionStats(sid),
      // 该会话此刻是否在生成压缩摘要:实时事件 compaction_start 不落盘,切回会话时靠这个标志
      // 把对话流里的「正在压缩…」运行行补回来(见 ChatPanel 历史载入)
      compacting: agent.isCompacting(sid),
      // 当前长期目标(移植自 harness goals 投影):无目标为 null,前端据此渲染输入卡上方的目标条
      goal: agent.getGoal(sid) ?? null
    });
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

  rpc.register('plan_command', async (msg, { reply }) => {
    // /计划 命令(移植自 harness plan/plan-mode 的 /plan):
    //   /计划        → 进入计划模式;/计划 off → 退出并回到进入前的档位;/计划 <消息> → 进入并把消息作为本轮请求
    // attachments 只有"随消息进入"这一种用法,/计划 off 带附件会在变更前直接报错(harness 同语义)
    // 不带 sid(旧客户端/内部调用)由 agent 侧回落到当前活跃会话,行为与其它会话级 RPC 一致
    const r = agent.planCommand(String(msg.input ?? ''), targetSid(msg), Array.isArray(msg.attachments) ? msg.attachments : null);
    reply({ type: 'ok', ...r });
  });

  rpc.register('goal_command', async (msg, { reply }) => {
    // /目标 命令(移植自 harness command-goal 的 /goal):
    //   裸 /目标 查看状态;`/目标 <描述>` 创建;edit/pause/resume/clear 走同一套 CAS 语义。
    // 成功创建/编辑且带附件时,附件作为一条参考消息进入后续目标轮(harness 同语义)。
    const r = agent.goalCommand(String(msg.input ?? ''), targetSid(msg), Array.isArray(msg.attachments) ? msg.attachments : null);
    reply({ type: 'ok', ...r });
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
    // "新会话草稿"里已经打开的预览浏览器继承给这个真实会话(前端传草稿 id d_…)。
    // 没有这一步,草稿期开的预览会变成没人认领的孤儿:新会话无权操作它,用户得手动重开。
    if (msg.transferFrom) {
      try { browserManager.transferOwner(String(msg.transferFrom), s.id); } catch { /* 继承失败不影响建会话 */ }
    }
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

  rpc.register('session_delete_group', async (msg, { reply, emitStatus }) => {
    // 工作区分组「删除分组」:一次删掉该分组下的全部会话。
    // agent.deleteSessions 先整组校验再删,组内有任务运行时整组拒绝(错误经 router 回给前端 toast)
    agent.deleteSessions(msg.ids);
    emitStatus(); // 分组含活跃会话时已收敛到新会话,同步其绑定工作区
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
    // 删除一条用户消息(及其所在轮回复);成功后把最新历史一并返回,前端免二次拉取。
    // at 是前端实时流里推算的下标(失败/中断轮会漂移),ordinal「第几条用户消息」才是权威定位,
    // text 用于服务端校验(见 agent.locateUserEvent);三者都可缺,缺省回落旧行为
    agent.deleteMessageAt(typeof msg.at === 'number' ? msg.at : -1, {
      ordinal: typeof msg.ordinal === 'number' ? msg.ordinal : undefined,
      text: typeof msg.text === 'string' ? msg.text : undefined
    });
    reply({ type: 'ok', turns: agent.getHistory(), todos: agent.currentTodos() });
    send({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
  });

  rpc.register('message_rewind', async (msg, { reply, send }) => {
    // 回到本轮对话发起前:截断该条消息及其之后的所有内容;返回最新历史。
    // 定位口径同 message_delete:ordinal(第几条用户消息)权威、at(forkTail)兜底
    agent.rewindToBefore(typeof msg.at === 'number' ? msg.at : -1, {
      ordinal: typeof msg.ordinal === 'number' ? msg.ordinal : undefined,
      text: typeof msg.text === 'string' ? msg.text : undefined
    });
    reply({ type: 'ok', turns: agent.getHistory(), todos: agent.currentTodos() });
    send({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
  });

  rpc.register('queue_steer', async (msg, { reply }) => {
    // 立即执行一条待执行队列消息:忙碌时作为下一步注入当前运行,空闲时直接开新轮
    const sid = targetSid(msg);
    if (isChildId(sid)) {
      childQueueSteer(String(sid), Number(msg.id));
      reply({ type: 'ok', queue: childQueueSnapshot(String(sid)) });
      return;
    }
    reply({ type: 'ok', ...agent.steerQueueItem(msg.id, sid) });
  });

  rpc.register('queue_remove', async (msg, { reply }) => {
    // 从待执行队列移除一条消息(编辑=移除后由前端撤回输入框重新编辑)
    const sid = targetSid(msg);
    if (isChildId(sid)) {
      childQueueRemove(String(sid), Number(msg.id));
      reply({ type: 'ok', queue: childQueueSnapshot(String(sid)) });
      return;
    }
    reply({ type: 'ok', ...agent.removeQueueItem(msg.id, sid) });
  });
}
