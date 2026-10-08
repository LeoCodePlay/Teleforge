// 子代理的**后台/可续聊/可暂停**语义测试(对齐 deepseek-harness 的 continuable subagent):
// 这一组针对的正是用户提的那三条:
//   1) 派发**不阻塞主会话**:subagent 工具缺省立即返回 `started subagent <id>`;
//   2) 结算通知:子代理跑完把"结束情况 + 最后结论"作为一条消息投回父会话(父会话空闲被唤醒);
//   3) 可续聊/可暂停:send_message 继续派活,interrupt_agent 只停当前这一轮(排队保留),
//      list_agents 看 running / inactive。
// 说明:ESM 静态 import 先于代码执行,故用顶层 await 在导入 agent 前设置 DATA_DIR
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-sub-bg-'));

const { Agent, toolRegistry } = await import('../server/agent/agent.ts');
const rt = await import('../server/agent/subagent-runtime.ts');
const { SUBAGENT_SYSTEM_PROMPT, SUBAGENT_GUIDANCE } = await import('../server/agent/subagent.ts');
const saStore = await import('../server/store/subagent-store.ts');
const { localFs } = await import('../server/core/local-fs.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const root = mkdtempSync(path.join(tmpdir(), 'sshai-sub-bg-ws-'));
localFs.workspace = root;
writeFileSync(path.join(root, 'note.txt'), 'hello');

const BRIEF = {
  description: '看目录',
  objective: '列出工作区目录并确认 note.txt 是否存在',
  scope: '只读本机工作区;不要写文件、不要执行命令'
};

/** 让假模型"卡住"到某个闸门放开,或到 signal 中止为止(真实 llm 客户端就是被 abort 打断的) */
function waitGate(gate, signal) {
  if (signal?.aborted) return Promise.reject(new Error('已停止'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('已停止'));
    signal?.addEventListener('abort', onAbort, { once: true });
    gate.then(() => resolve());
  });
}

/** 轮询等待条件成立(子代理是后台跑的,断言必须等它自己推进) */
async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function main() {
  // ---- 1. 控制工具注册与权限声明 ----
  {
    for (const name of ['send_message', 'interrupt_agent', 'list_agents']) {
      const def = toolRegistry.get(name);
      check(`${name} 已注册`, !!def);
    }
    check('send_message / interrupt_agent 按写类处理(plan 拒绝、confirm 审批)',
      toolRegistry.get('send_message')?.access === 'write' && toolRegistry.get('interrupt_agent')?.access === 'write');
    check('list_agents 是只读(任何模式都不拦)', toolRegistry.get('list_agents')?.access === 'read');
    check('三个控制工具都并发安全', ['send_message', 'interrupt_agent', 'list_agents']
      .every((n) => toolRegistry.isConcurrencySafe(n) === true));
    check('subagent 工具 schema 暴露 run_in_background(缺省 true)',
      toolRegistry.get('subagent')?.parameters?.properties?.run_in_background?.type === 'boolean');
  }

  // ---- 1b. 提示词模板:文案逐条对齐 deepseek-harness 原文(工具描述 / 参数描述 / 系统提示词)----
  {
    const def = toolRegistry.get('subagent');
    const desc = String(def?.description || '');
    check('工具描述用 harness 的 providerWording(spawn)原文开头',
      desc.startsWith('Delegate a self-contained task to a subagent (a separate agent that works in its own context)')
      && desc.includes('so it does not consume this conversation\'s context. The subagent returns its result, not its intermediate steps.'),
      desc.slice(0, 120));
    check('工具描述含 harness 的 continuable 后台那句原文',
      desc.includes('It runs in the background by default and returns a subagent id you can continue with `send_message`; you are notified when the run settles.'),
      desc.slice(0, 260));
    check('prompt 参数描述用 harness 原文 + 本项目的 objective/scope 扩展',
      String(def?.parameters?.properties?.prompt?.description || '').startsWith('The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.'),
      String(def?.parameters?.properties?.prompt?.description));
    check('run_in_background 描述用 harness 原文',
      String(def?.parameters?.properties?.run_in_background?.description || '').startsWith('Defaults to true. Set false only when your next action depends on the result'),
      String(def?.parameters?.properties?.run_in_background?.description));
    check('description 参数描述用 harness 原文',
      String(def?.parameters?.properties?.description?.description) === 'A short (3-5 word) description of the delegated task, for display.',
      String(def?.parameters?.properties?.description?.description));

    const send = String(toolRegistry.get('send_message')?.description || '');
    check('send_message 描述用 harness 原文',
      send.startsWith('Send a message to an agent. A working agent receives it at its next step; an idle agent starts a new turn with it. Returns delivery confirmation, not the agent\'s answer.'),
      send.slice(0, 140));
    const intr = String(toolRegistry.get('interrupt_agent')?.description || '');
    check('interrupt_agent 描述用 harness 原文',
      intr.startsWith('Ask a subagent to stop its current work. This call returns without waiting for it to stop. ')
      && intr.includes('You can continue a direct child\'s conversation later with send_message'),
      intr.slice(0, 160));
    const list = String(toolRegistry.get('list_agents')?.description || '');
    check('list_agents 描述用 harness 原文',
      list.startsWith('List subagents you started, with their ids, labels, and status. running means it is working; inactive means it is not currently working. You will be notified when a subagent finishes')
      && list.includes('Use send_message to continue the conversation.'),
      list.slice(0, 200));
    check('list_agents 的 scope 参数描述用 harness 原文',
      String(toolRegistry.get('list_agents')?.parameters?.properties?.scope?.description || '').startsWith('children (default) lists direct children, which accept send_message in any status.'),
      String(toolRegistry.get('list_agents')?.parameters?.properties?.scope?.description));

    check('子代理系统提示词第一段 = harness 的 delegation-scope 声明(权限派发时固定 / 不重试被拒操作 / 把限制写回主代理)',
      SUBAGENT_SYSTEM_PROMPT.startsWith('你是一个子代理(subagent),由主代理派发')
      && SUBAGENT_SYSTEM_PROMPT.includes('你的权限范围在派发时就已经固定')
      && SUBAGENT_SYSTEM_PROMPT.includes('不要重试被拒绝的操作')
      && SUBAGENT_SYSTEM_PROMPT.includes('让派发你的主代理去处理'),
      SUBAGENT_SYSTEM_PROMPT.slice(0, 120));
    check('父侧 system prompt 段 = harness 的 tool:<name> 原文',
      SUBAGENT_GUIDANCE === 'Start independent subagent delegations together in one assistant message and continue useful work while they run.',
      SUBAGENT_GUIDANCE);
  }

  // ---- 2. 派发立即返回(不阻塞),子代理在后台继续跑 ----
  {
    let releaseChild = () => {};
    const gate = new Promise((r) => { releaseChild = r; });
    let childCalls = 0;
    const llm = {
      isMock: false,
      async chat({ messages, signal }) {
        const isChild = messages.some((m) => m.role === 'system' && String(m.content).includes('你是一个子代理'));
        if (isChild) {
          childCalls += 1;
          if (childCalls === 1) { await waitGate(gate, signal); return { content: '结论:后台调研完成,note.txt 在。', toolCalls: [] }; }
          return { content: `结论:第 ${childCalls} 轮续聊回答。`, toolCalls: [] };
        }
        return { content: '父代理自己的回答', toolCalls: [] };
      }
    };
    const notices = [];
    let noticeSource = null;
    const r = await toolRegistry.execute({
      name: 'subagent',
      args: JSON.stringify({ ...BRIEF }),
      invokeCtx: { sid: 's_bg', llm, registry: toolRegistry, emit: () => {}, agent: { submit: (sid, text, opts) => { notices.push(text); noticeSource = opts?.source ?? null; } } }
    });
    check('缺省后台派发:工具立即返回 started subagent <id>(不等结果)',
      !r.isError && /^started subagent sa_[0-9a-z]+$/.test(r.content.trim()), `${r.isError} / ${r.content}`);
    const runId = r.meta?.subagent?.runId;
    check('tool/result 的 meta 带 runId 与 mode=continuable',
      runId === r.content.trim().replace('started subagent ', '') && r.meta?.subagent?.mode === 'continuable',
      JSON.stringify(r.meta));
    check('后台派发时子代理仍在跑(记录 status=running)', saStore.get(runId)?.status === 'running', String(saStore.get(runId)?.status));
    check('父代理此刻没有被阻塞(工具已经返回)', childCalls >= 1);

    // 让子代理自己跑完
    releaseChild();
    const settled = await waitFor(() => !!notices.length);
    check('子代理跑完后投递结算通知(父会话能拿到结论)', settled, JSON.stringify(notices));
    check('结算通知是 dsh 的 settlement notice 文案(一句话账 + 收尾消息)',
      notices[0]?.includes(runId) && notices[0]?.includes('已完成;除非你再给它发消息')
      && notices[0]?.includes('它的收尾消息:') && notices[0]?.includes('后台调研完成'),
      String(notices[0]).slice(0, 200));
    check('结算通知带 dsh 的 source 归属(kind=subagent-settled / form=notice / summary / senderSessionId)',
      noticeSource?.kind === 'subagent-settled' && noticeSource?.form === 'notice'
      && String(noticeSource?.summary || '').includes(runId) && noticeSource?.senderSessionId === runId,
      JSON.stringify(noticeSource));
    check('结算后记录停在 idle(常驻、可继续),不是终局',
      await waitFor(() => saStore.get(runId)?.status === 'idle'), String(saStore.get(runId)?.status));
    check('结算后常驻 Activation 还在(可续聊)', rt.isResident(runId) === true);

    // ---- 3. list_agents:列出本会话可继续的子代理与状态 ----
    const listed = await toolRegistry.execute({
      name: 'list_agents', args: '{}',
      invokeCtx: { sid: 's_bg', session: null, emit: () => {}, agent: null }
    });
    check('list_agents 列出该子代理(inactive)',
      listed.content.includes(runId) && listed.content.includes('[inactive]') && listed.content.includes('看目录'), listed.content);
    const other = await toolRegistry.execute({
      name: 'list_agents', args: '{}',
      invokeCtx: { sid: 's_other', emit: () => {}, agent: null }
    });
    check('list_agents 只列本会话派发的(别的会话回 (no subagents))', other.content === '(no subagents)', other.content);

    // ---- 4. send_message 续聊:空闲的子代理被唤醒开新一轮 ----
    let releaseSecond = () => {};
    const gate2 = new Promise((r) => { releaseSecond = r; });
    llm.chat = async ({ messages, signal }) => {
      const isChild = messages.some((m) => m.role === 'system' && String(m.content).includes('你是一个子代理'));
      if (!isChild) return { content: '父代理自己的回答', toolCalls: [] };
      childCalls += 1;
      if (childCalls === 2) { await waitGate(gate2, signal); return { content: '结论:续聊轮完成(已补充证据)。', toolCalls: [] }; }
      return { content: `结论:第 ${childCalls} 轮续聊回答。`, toolCalls: [] };
    };
    const sent = await toolRegistry.execute({
      name: 'send_message',
      args: JSON.stringify({ agent_id: runId, message: '再补一句证据' }),
      invokeCtx: { sid: 's_bg', emit: () => {}, agent: null }
    });
    check('send_message 受理并回执(不给回复)',
      !sent.isError && sent.content === `message delivered to agent ${runId}`, sent.content);
    check('子会话里能看到这条后续消息(带主代理署名)',
      saStore.get(runId)?.messages?.some((m) => m.role === 'user' && m.from === 'parent' && m.text.includes('再补一句证据')),
      JSON.stringify(saStore.get(runId)?.messages?.slice(-2)));
    check('续聊把空闲的子代理唤醒了(重新变成 running)',
      await waitFor(() => saStore.get(runId)?.status === 'running'), String(saStore.get(runId)?.status));

    // ---- 5. interrupt_agent:只停当前这一轮,子代理不销毁、记录回 idle ----
    const stopped = await toolRegistry.execute({
      name: 'interrupt_agent', args: JSON.stringify({ agent_id: runId }),
      invokeCtx: { sid: 's_bg', emit: () => {}, agent: null }
    });
    check('interrupt_agent 受理并回执', !stopped.isError && stopped.content === `interrupt requested for agent ${runId}`, stopped.content);
    check('暂停后记录回 idle(可继续),不是终局 stopped',
      await waitFor(() => saStore.get(runId)?.status === 'idle'), String(saStore.get(runId)?.status));
    check('暂停不会销毁子代理(仍能续聊)', rt.isResident(runId) === true);
    check('暂停后仍可 send_message(排队保留、下一条消息唤醒)', (() => {
      let ok = false;
      try { rt.sendMessage(runId, '继续吧', { from: 'parent' }); ok = true; } catch { ok = false; }
      return ok;
    })());
    releaseSecond();
    check('被暂停的一轮不会再产出结论,新消息那一轮照常跑完',
      await waitFor(() => String(saStore.get(runId)?.messages?.slice(-1)?.[0]?.text || '').includes('续聊回答'), 6000),
      JSON.stringify(saStore.get(runId)?.messages?.slice(-1)));

    // ---- 6. 授权:别的会话不能操作本会话的子代理 ----
    const deniedResult = await toolRegistry.execute({
      name: 'interrupt_agent', args: JSON.stringify({ agent_id: runId }),
      invokeCtx: { sid: 's_other', emit: () => {}, agent: null }
    });
    check('别的会话操作本会话的子代理被拒绝',
      deniedResult.isError === true && /不属于本会话/.test(deniedResult.content), deniedResult.content);
  }

  // ---- 6b. 冷恢复:进程重启过(常驻 Activation 没了)也要能继续发消息 + 结算照常通知父会话 ----
  {
    const seen = [];
    const notices = [];
    let n = 0;
    const llm = {
      isMock: false,
      async chat({ messages }) {
        seen.push(messages);
        n += 1;
        return { content: `结论:冷恢复后的第 ${n} 轮,note.txt 仍在。`, toolCalls: [] };
      }
    };
    const coldSid = 's_cold';
    const started = await toolRegistry.execute({
      name: 'subagent', args: JSON.stringify(BRIEF),
      invokeCtx: { sid: coldSid, llm, registry: toolRegistry, emit: () => {}, agent: { submit: () => {} } }
    });
    const coldId = started.meta.subagent.runId;
    check('(前置)后台子代理跑完停在可继续状态',
      await waitFor(() => saStore.get(coldId)?.status === 'idle'), String(saStore.get(coldId)?.status));

    // 模拟进程重启:常驻 Activation 全部消失(运行记录留在磁盘上)
    rt.disposeAll();
    check('重启后不再常驻(resident=false)', rt.isResident(coldId) === false);

    // 没有模型客户端时不假装受理
    let noDeps = '';
    try { rt.sendMessage(coldId, '继续', { from: 'human' }); } catch (e) { noDeps = e.message; }
    check('没有模型客户端时如实拒绝(而不是假装受理)', /不在内存中/.test(noDeps) && /模型客户端/.test(noDeps), noDeps);

    // 带上冷恢复依赖:从运行记录重建会话并继续干
    const resumed = rt.sendMessage(coldId, '继续:把 note.txt 的证据补上', {
      from: 'human', resume: { llm, registry: toolRegistry, notifyParent: (t) => notices.push(t) }
    });
    check('冷恢复受理这条消息', resumed.delivered === true && resumed.resumed === true, JSON.stringify(resumed));
    check('冷恢复后重新常驻(可继续/可暂停)', rt.isResident(coldId) === true);
    const coldReq = seen.find((msgs) => JSON.stringify(msgs).includes('把 note.txt 的证据补上'));
    check('冷恢复把上一次的对话一起恢复进上下文(模型看得到之前的结论与任务边界)',
      !!coldReq && JSON.stringify(coldReq).includes('冷恢复后的第 1 轮') && JSON.stringify(coldReq).includes('【任务目标】'),
      JSON.stringify(coldReq || []).slice(0, 200));
    check('冷恢复后这一轮照常跑完并回到可继续状态',
      await waitFor(() => saStore.get(coldId)?.status === 'idle' && seen.length >= 2, 6000),
      String(saStore.get(coldId)?.status));
    check('冷恢复后跑完照常投递结算通知给父会话',
      await waitFor(() => notices.length > 0) && notices[0].includes('冷恢复后的第 2 轮'),
      String(notices[0]).slice(0, 160));

    // 一次性派发:仍然只读(不能冷恢复)
    const once = await rt.startSubagent({ ...BRIEF, llm, registry: toolRegistry, sid: coldSid, mode: 'one-shot' });
    await once.settled;
    let onceErr = '';
    try { rt.sendMessage(once.runId, '再来一次', { from: 'human', resume: { llm, registry: toolRegistry } }); }
    catch (e) { onceErr = e.message; }
    check('一次性派发仍然不接受后续消息(冷恢复只对可继续的子代理生效)',
      /一次性派发/.test(onceErr), onceErr);
  }

  // ---- 7. 端到端:父代理不等子代理就继续自己的活,结论晚一点以结算通知回来 ----
  {
    const agent = new Agent({ emit: () => {} });
    agent.setPermissionMode('full-access');
    agent.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake' });
    let releaseChild = () => {};
    const gate = new Promise((r) => { releaseChild = r; });
    let parentCalls = 0, childFirst = null;
    agent.llm = {
      isMock: false,
      async chat({ messages, signal }) {
        const isChild = messages.some((m) => m.role === 'system' && String(m.content).includes('你是一个子代理'));
        if (isChild) { childFirst = childFirst ?? messages; await waitGate(gate, signal); return { content: '子代理结论:语义对齐已确认。', toolCalls: [] }; }
        parentCalls += 1;
        if (parentCalls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'p1', name: 'subagent',
              arguments: JSON.stringify({ description: '看目录', objective: 'PARENT-OBJ 列出工作区目录', scope: 'PARENT-SCOPE 只读本机;不要写文件' })
            }]
          };
        }
        if (parentCalls === 2) return { content: '父代理:我先干别的活,不等子代理。', toolCalls: [] };
        return { content: '父代理:收到结算通知。', toolCalls: [] };
      }
    };

    await agent.run('派个后台子代理去看看');
    check('父代理的 system prompt 里带上了 harness 的子代理指引段',
      String(agent._systemPrompt()).includes(SUBAGENT_GUIDANCE), '');
    check('父代理在自己的一轮里没有等子代理(第二步照常产出)',
      agent.history.some((m) => m.role === 'assistant' && String(m.content).includes('我先干别的活')), '');
    check('子代理确实还没跑完(受 gate 控制)', agent.history.some((m) => m.role === 'tool' && String(m.content).startsWith('started subagent ')));
    const rpcNote = agent.history.filter((m) => m.role === 'user' && String(m.content).includes('子代理'));
    check('子代理没跑完之前,父会话里还没有结算通知',
      !rpcNote.some((m) => /已完成;除非你再给它发消息|它的收尾消息:/.test(String(m.content))),
      JSON.stringify(rpcNote.map((m) => m.content).slice(0, 2)));

    releaseChild();
    const got = await waitFor(() => agent.history.some((m) => m.role === 'assistant' && String(m.content).includes('收到结算通知')), 8000);
    const hist = agent.history;
    // 事件日志里这条通知的 source 必须是 dsh 形状的对象(form=notice → 前端渲染通知行)
    const noticeEvent = agent.session.events.find((e) => e.type === 'user/message'
      && e.data?.source && typeof e.data.source === 'object' && e.data.source.kind === 'subagent-settled');
    const notice = hist.find((m) => m.role === 'user' && /已完成;除非你再给它发消息|它的收尾消息:/.test(String(m.content)));
    check('子代理跑完后父会话被唤醒(父代理自己开了一轮回应)', got, '');
    check('结算通知作为一条消息进了父会话,带着子代理结论',
      !!notice && String(notice.content).includes('语义对齐已确认'), String(notice?.content || '').slice(0, 200));
    check('结算通知带 form=notice 的 source(前端据此渲染成通知行,而不是用户气泡)',
      noticeEvent?.data?.source?.form === 'notice' && noticeEvent?.data?.source?.kind === 'subagent-settled',
      JSON.stringify(noticeEvent?.data?.source));
    check('子代理上下文隔离:父会话里没有子代理的事件/中间步骤',
      !hist.some((m) => m.role === 'tool' && String(m.content).includes('子代理结论')), '');
    check('子代理第一次请求只看到自己的系统提示词 + 本次任务(与父会话隔离)',
      childFirst?.length === 2 && !JSON.stringify(childFirst).includes('派个后台子代理去看看'), `实际 ${childFirst?.length}`);
  }

  // ---- 8. 子会话 = 父会话同一套对话系统(事件同构 + 按父会话协议广播)----
  {
    const { projectEvents } = await import('../server/agent/agent.ts');
    const sid = 's_ui';
    const emitted = [];
    let uiStep = 0;
    const llm = {
      isMock: false,
      async chat({ onDelta }) {
        if (uiStep === 0) {
          uiStep += 1;
          onDelta?.({ kind: 'text', text: '先看一眼目录。' });
          return { content: '先看一眼目录。', toolCalls: [{ id: 'c1', name: 'list_local_dir', arguments: JSON.stringify({ path: root }) }] };
        }
        uiStep += 1;
        onDelta?.({ kind: 'text', text: '结论:目录里有 note.txt。' });
        return { content: '结论:目录里有 note.txt。', toolCalls: [] };
      }
    };
    const started = await toolRegistry.execute({
      name: 'subagent', args: JSON.stringify(BRIEF),
      invokeCtx: { sid, llm, registry: toolRegistry, emit: (ev, p) => emitted.push(p), agent: null }
    });
    const rid = started.meta.subagent.runId;
    check('(前置)子代理跑完停在可继续状态',
      await waitFor(() => saStore.get(rid)?.status === 'idle'), String(saStore.get(rid)?.status));

    // 事件面:与父会话同一协议、sid 就是子代理自己的 id
    const byEvent = (name) => emitted.filter((p) => p.event === name && p.sid === rid);
    check('广播了父会话同款事件流(status/start/iteration/文本增量/tool_call/tool_result/done/session_stats/queue_update)',
      ['status', 'start', 'iteration', 'text_delta', 'tool_call', 'tool_result', 'done', 'session_stats', 'queue_update']
        .every((n) => byEvent(n).length > 0),
      emitted.map((p) => p.event).join(','));
    check('start 事件带本轮用户消息原文(前端据此推入用户气泡)',
      String(byEvent('start')[0]?.text || '').includes('【任务目标】'), JSON.stringify(byEvent('start')[0]));
    check('tool_result 带结果与耗时(前端渲染同款工具行)',
      !!byEvent('tool_result')[0]?.result && byEvent('tool_result')[0]?.ok === true,
      JSON.stringify(byEvent('tool_result')[0]).slice(0, 120));

    // 投影:与父会话同一个 projectEvents,能直接喂给同一个 ChatPanel
    const session = rt.childSessionFor(rid);
    const turns = projectEvents(session ? session.events : []);
    const roles = turns.map((t) => t.role).join(',');
    check('子会话事件能被 projectEvents 投影成一段普通对话(user/assistant/tool/assistant)',
      roles === 'user,assistant,tool,assistant', roles);
    const toolTurn = turns.find((t) => t.role === 'tool');
    check('工具行带工具名与入参(与父会话同一渲染原子)',
      toolTurn?.tool_name === 'list_local_dir' && !!toolTurn?.tool_args && toolTurn?.ok === true,
      JSON.stringify(toolTurn).slice(0, 140));
    const lastAi = turns.filter((t) => t.role === 'assistant').pop();
    check('回合折叠行数据齐备(耗时 + 结束原因 = 父会话的「已完成,用时 X」)',
      typeof lastAi?.turnElapsedMs === 'number' && lastAi?.turnEndReason === 'completed',
      JSON.stringify({ ms: lastAi?.turnElapsedMs, why: lastAi?.turnEndReason }));
    check('结论在最后一条 assistant 里(前端与刷新后一致)',
      String(lastAi?.content || '').includes('note.txt'), String(lastAi?.content).slice(0, 80));

    // 回归:人类发一条消息只该留下**一条** user 记录(曾经重复写:会话 + 记录各写一次)
    rt.sendMessage(rid, '只写一次', { from: 'human' });
    const dupes = (saStore.get(rid)?.messages || []).filter((m) => m.role === 'user' && String(m.text || '') === '只写一次').length;
    check('一条后续消息只落一条 user 记录(不重复)', dupes === 1, `实际 ${dupes}`);
    await waitFor(() => saStore.get(rid)?.status === 'idle');
  }

  // ---- 9. 父会话**运行中**收到结算通知:直接 steer 进正在跑的那一轮(dsh 的 notifySettlement)----
  //
  // dsh 的投递目标是选出来的:parent.status === 'idle' ? 'queue' : 'steer'。
  // 运行中的父会话收到通知**不该**进"待执行队列"等人点「立即执行」(那会把它变成一条用户消息),
  // 而是交给正在跑的那一轮的下一个 step 边界认领(dsh 的 inbox next-step)。
  {
    const { projectEvents } = await import('../server/agent/agent.ts');
    const emitted = [];
    const a = new Agent({ emit: (ev, p) => emitted.push(p) });
    a.setPermissionMode('full-access');
    a.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake' });
    const sid = a.createSession('运行中收通知').id;
    let release = () => {};
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    const seenMsgs = [];
    a.llm = {
      isMock: false,
      async chat({ messages, signal }) {
        calls += 1; seenMsgs.push(messages);
        if (calls === 1) {
          // 卡住第一步的模型请求(此刻父会话正在跑)
          await waitGate(gate, signal);
          // 第一步就发起一个工具调用 → 这一轮还有第二步(通知会在那一步边界被认领)
          return { content: '', toolCalls: [{ id: 'c1', name: 'list_local_dir', arguments: JSON.stringify({ path: root }) }] };
        }
        return { content: '收到子代理的通知,接着处理。', toolCalls: [] };
      }
    };
    a.submit(sid, '干个长活'); // 不 await:这一轮会卡在 gate 上
    await waitFor(() => calls >= 1, 4000);
    check('(前置)父会话此刻正在跑', a._runtimes.get(sid).busy === true, String(a._runtimes.get(sid).busy));

    const summary = '后台子代理 sa_busy 已完成;除非你再给它发消息,它不会再做任何事。';
    const src = { kind: 'subagent-settled', form: 'notice', summary, senderSessionId: 'sa_busy' };
    // 走**真实投递通路**(子代理收尾 → parentNotifier → agent 的投递目标选择)
    const { parentNotifier } = await import('../server/agent/subagent-runtime.ts');
    parentNotifier(a, sid)(`${summary}\n\n它的收尾消息:\n结论:目录可读`, src);
    check('运行中投递通知被受理(交给正在跑的这一轮,而不是丢弃)',
      a._runtimes.get(sid).steer.length === 1, JSON.stringify(a._runtimes.get(sid).steer.map((s) => s.text)));
    check('运行中收到的通知**不进"待执行队列"**(dsh 用 steer,不需要人点「立即执行」)',
      a.queueSnapshot(sid).length === 0, JSON.stringify(a.queueSnapshot(sid)));
    check('实时推了一条 steer_message(前端据此把通知行插进本轮,不必刷新)',
      emitted.some((p) => p.event === 'steer_message' && p.sid === sid
        && p.source?.form === 'notice' && String(p.text).includes('它的收尾消息')),
      JSON.stringify(emitted.filter((p) => p.event === 'steer_message').map((p) => p.sid)));

    release();
    await waitFor(() => calls >= 2, 8000);
    const evs = a._runtimes.get(sid).session.events;
    const noticeEv = evs.find((e) => e.type === 'user/message' && e.data?.source?.kind === 'subagent-settled');
    check('通知作为一条 user/message 落进日志(刷新/切回后仍在原位)',
      !!noticeEv && noticeEv.data.source.form === 'notice' && noticeEv.data.source.senderSessionId === 'sa_busy',
      JSON.stringify(noticeEv?.data?.source));
    check('它落在**同一轮**里(steer 被正在跑的那一轮的下一个 step 认领,不为它新开一轮)',
      evs.filter((e) => e.type === 'turn/start').length === 1,
      String(evs.filter((e) => e.type === 'turn/start').length));
    const pRow = projectEvents(evs).find((r) => r.role === 'user' && r.source?.form === 'notice');
    check('投影把它标成轮内通知(inline:前端渲染轮内通知行,不是用户气泡)',
      !!pRow && pRow.inline === true, JSON.stringify(pRow && { inline: pRow.inline, source: pRow.source }));
    check('下一步的模型请求里带着这条通知(被正在跑的这一轮认领,而不是等下一轮)',
      seenMsgs.length >= 2 && JSON.stringify(seenMsgs[1]).includes('它的收尾消息'), '');

    // 单步轮次里投递(模型这一步就收尾、没有下一个 step 边界):通知仍不进队列,
    // 由下一步活动开头认领 —— dsh 的 inbox 在开新轮时同样会领取 next-step 里的消息
    await waitFor(() => a._runtimes.get(sid).busy === false, 8000);
    let release2 = () => {};
    const gate2 = new Promise((r) => { release2 = r; });
    const before = calls;
    a.llm = {
      isMock: false,
      async chat({ messages, signal }) {
        calls += 1; seenMsgs.push(messages);
        if (calls === before + 1) { await waitGate(gate2, signal); return { content: '这轮就一句话收尾。', toolCalls: [] }; }
        return { content: '第二段:通知我已经看了。', toolCalls: [] };
      }
    };
    a.submit(sid, '再来个长活');
    await waitFor(() => calls >= before + 1, 4000);
    const summary2 = '后台子代理 sa_next 已完成;除非你再给它发消息,它不会再做任何事。';
    a.deliverNotice(sid, `${summary2}\n\n它的收尾消息:\n结论:好了`, {
      source: { kind: 'subagent-settled', form: 'notice', summary: summary2, senderSessionId: 'sa_next' }
    });
    check('单步轮次里投递同样不进队列', a.queueSnapshot(sid).length === 0, JSON.stringify(a.queueSnapshot(sid)));
    release2();
    await waitFor(() => calls >= before + 2, 8000);
    const evs2 = a._runtimes.get(sid).session.events;
    const proj2 = projectEvents(evs2);
    const rows = proj2.filter((r) => r.role === 'user' && r.source?.kind === 'subagent-settled');
    check('没有下一步可认领时,通知作为下一轮的开头被认领(仍是通知行,不是用户气泡)',
      rows.length === 2 && !!rows[1] && rows[1].inline === undefined,
      JSON.stringify(rows.map((r) => ({ inline: r.inline, kind: r.source?.kind }))));
    check('这条通知同样带着 dsh 的 source(前端渲染成「触发本轮的通知」)',
      rows[1]?.source?.form === 'notice' && rows[1]?.source?.senderSessionId === 'sa_next',
      JSON.stringify(rows[1]?.source));
  }

  // ---- 10. 子智能体会话里分支:把这个子智能体当成一个新的**父对话**克隆(dsh 的 fork 语义)----
  //
  // dsh: 分支动作作用于"当前正在看的那个会话"(`ui-chat/apply.ts` 的 forkAt → sessions.fork({sessionId})),
  // 在子代理视图里 sessionId 就是子代理;产出的是 seed 了那份日志的**普通会话**
  // (`isSeeded: true`,不是子代理 Activation、不受只读白名单约束)。所以这里断言:
  // 新会话是普通顶层会话、内容来自子代理自己的日志、并且能干子代理干不了的写操作。
  {
    const { projectEvents } = await import('../server/agent/agent.ts');
    const sid = 's_forkchild';
    const llm = {
      isMock: false,
      async chat({ messages }) {
        if (!messages.some((m) => m.role === 'system' && String(m.content).includes('你是一个子代理'))) {
          return { content: '（父会话的假模型,本用例不用）', toolCalls: [] };
        }
        return { content: '结论:工作区里有 note.txt。', toolCalls: [] };
      }
    };
    const started = await toolRegistry.execute({
      name: 'subagent', args: JSON.stringify(BRIEF),
      invokeCtx: { sid, llm, registry: toolRegistry, emit: () => {}, agent: { submit: () => {} } }
    });
    const runId = started.meta.subagent.runId;
    check('(前置)子代理跑完停在可继续状态',
      await waitFor(() => saStore.get(runId)?.status === 'idle'), String(saStore.get(runId)?.status));

    const a = new Agent({ emit: () => {} });
    a.setPermissionMode('full-access');
    a.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake' });
    a.createSession('父会话');
    const forked = a.forkChildSession(runId);
    check('分支产出一条新的普通会话(出现在会话列表里)',
      !!forked?.id && a.listVisible().some((s) => s.id === forked.id), JSON.stringify(a.listVisible().map((s) => s.title)));
    check('分支后活跃会话就是它(可以直接接着聊)',
      a.sessionId === forked.id && a.getSessionId() === forked.id);
    check('标题来自子代理的任务名 + (分支)',
      /看目录/.test(forked.title) && /\(分支\)$/.test(forked.title), forked.title);

    const evs = a._runtimes.get(forked.id).session.events;
    const turns = projectEvents(evs);
    check('新会话带着子代理自己的对话(任务 brief + 结论都在)',
      JSON.stringify(turns).includes('列出工作区目录') && JSON.stringify(turns).includes('结论:工作区里有 note.txt'),
      turns.map((t) => t.role).join(','));
    check('它照常被投影成一段普通对话(user/assistant 行)',
      turns.some((t) => t.role === 'user') && turns.some((t) => t.role === 'assistant'),
      turns.map((t) => t.role).join(','));
    check('分支是独立的:改新会话不影响子代理记录',
      saStore.get(runId)?.messages?.length > 0 && evs !== rt.childSessionFor(runId).events);

    // "新的父对话"的实质:它能干子代理干不了的写操作(子代理是只读白名单)
    const writeLlm = {
      isMock: false,
      async chat({ messages }) {
        const already = messages.some((m) => m.role === 'tool');
        if (already) return { content: '写完了。', toolCalls: [] };
        return { content: '', toolCalls: [{ id: 'w1', name: 'write_local_file', arguments: JSON.stringify({ path: 'forked.txt', content: 'from fork' }) }] };
      }
    };
    a.llm = writeLlm;
    a._llmBySid.set(forked.id, writeLlm);
    a._runtimes.get(forked.id).localWorkspace = root;
    await a.submit(forked.id, '在新会话里写个文件');
    const wrote = await waitFor(() => existsSync(path.join(root, 'forked.txt')), 8000);
    const lastRows = a.getHistory().filter((t) => t.role === 'tool' || t.role === 'assistant').slice(-3);
    check('新会话是全量工具的普通会话(能写文件,子代理只读做不到)', wrote,
      JSON.stringify(lastRows).slice(0, 300));

    // 截断分支:at=0 只保留第一条消息面之前的内容
    const cut0 = a.forkChildSession(runId, 0);
    const cut0Events = a._runtimes.get(cut0.id).session.events;
    check('at 截断分支:只克隆到那条消息为止',
      cut0Events.length < evs.length && cut0Events.every((e) => e.type !== 'assistant/message'), String(cut0Events.length));
    let bad = '';
    try { a.forkChildSession('sa_nope'); } catch (e) { bad = e.message; }
    check('没有可分支对话的子代理如实报错', /没有可分支的对话/.test(bad), bad);
  }

  rt.disposeAll();
  console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
