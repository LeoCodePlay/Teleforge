// 子代理 RPC:按会话列出派发记录 + 拉取某次派发的完整对话 + 续聊/暂停。
// 低频控制类请求走这里;实时变更走 agent 事件总线(ws.ts 里的 event='subagent_changed')。
//
// 与 deepseek-harness 的对应关系:
//   subagent_list      ↔ 父会话的子智能体 catalog(只看本会话派发的)
//   subagent_get       ↔ 子会话正文(完整对话 = 它的 Session 投影)
//   subagent_prompt    ↔ harness 的 `subagent.prompt` Remote(人类在子会话里发消息)
//   subagent_interrupt ↔ harness 的 `interruptByParent`(暂停当前这一轮,子代理仍可继续)
//
// 关键语义:子代理不常驻(服务重启过 / 这条记录来自上一次运行)**不是**不能发消息的理由 ——
// 只要模型客户端可用,这里就把冷恢复依赖交给运行时,由它从运行记录里重建会话继续干
// (harness:no Activation → cold-resume a new Activation)。只有一次性派发才是只读的。
import { get, list } from '../../store/subagent-store.ts';
import { agent, toolRegistry } from '../../agent/agent.ts';
import { sendMessage, interruptChild, isResident, parentNotifier, captureBinding } from '../../agent/subagent-runtime.ts';
import type { RpcModule } from './router.ts';

export function registerSubagent(rpc: RpcModule) {
  // sid 可选:不传 = 该会话的派发记录(不带 sid 时返回空,不暴露其它会话)
  rpc.register('subagent_list', async (msg, { reply }) => {
    const sid = msg.sid ? String(msg.sid) : null;
    // 必须带 sid:没有 sid 一律回空,绝不回"全部会话"(面板只显示当前对话的记录,
    // 旧前端/别的调用方也不能借这个入口看到其它会话的派发)
    const runs = sid ? list(sid).map((r) => ({ ...r, resident: isResident(r.runId) })) : [];
    reply({ type: 'subagent_list', sid, runs });
  });

  rpc.register('subagent_get', async (msg, { reply }) => {
    const runId = String(msg.runId || '');
    const run = get(runId);
    // 找不到(记录被保留策略清掉/换过数据目录)如实回 null,前端渲染"记录已不在"而不是空对话
    reply({ type: 'subagent_run', runId, run: run ? { ...run, resident: isResident(runId) } : null });
  });

  // 人类在子会话里发消息(harness 的 subagent.prompt):默认排到当前轮之后的下一轮(FIFO),
  // delivery='steer' 时投到最近一步边界被认领。只回受理结果,回复不从这里返回。
  rpc.register('subagent_prompt', async (msg, { reply }) => {
    const runId = String(msg.runId || '');
    const text = String(msg.text ?? '');
    const delivery = msg.delivery === 'steer' ? 'steer' : 'queue';
    const rec = get(runId);
    // 抛错由 ws 层转成 { type:'error' } 应答:前端 api.request 会 reject 并显示原因
    sendMessage(runId, text, {
      from: 'human', delivery,
      resume: {
        llm: agent._llmFor(rec?.sid ?? null),
        registry: toolRegistry,
        emit: agent.emit,
        notifyParent: parentNotifier(agent, rec?.sid ?? null),
        binding: captureBinding(agent, rec?.sid ?? null)
      }
    });
    reply({ type: 'subagent_run', runId, run: get(runId) });
  });

  // 暂停 = 只停当前这一轮:排队消息保留、子代理不销毁,下一条消息继续(harness 的 interrupt)
  rpc.register('subagent_interrupt', async (msg, { reply }) => {
    const runId = String(msg.runId || '');
    const accepted = interruptChild(runId, '用户暂停');
    reply({ type: 'subagent_run', runId, accepted, run: get(runId) });
  });
}
