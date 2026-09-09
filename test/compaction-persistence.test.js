// 上下文压缩的持久化与会话切换回归测试。
// 起因:/compact 压缩在前端看起来成功,切换会话再切回却消失——因为压缩从未真正落到
// 服务端事件日志。这组用例锁定「压缩结果必须活过会话切换」这条不变量:
//   1) compactNow 写入的检查点带 dropThroughSeq 且已落盘;
//   2) 该会话 runtime 被释放(切走)再载入,历史投影仍含压缩标记行;
//   3) 模型面历史确实跳过被压缩区间(压缩真的生效,不只是显示);
//   4) 已从内存释放的空闲会话同样可压缩(旧实现直接抛「会话不存在」);
//   5) 压缩只作用于指定 sid,不污染当前活跃会话;
//   6) 非破坏压缩:显示视图仍完整保留早期消息。
// 全程用假 LLM,不打真实网络;会话写入临时 DATA_DIR,不碰用户数据。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-compact-'));

const { Agent, projectEvents } = await import('../server/agent/agent.ts');
const { Session } = await import('../server/agent/session.ts');
const store = await import('../server/store/session-store.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const finish = () => { console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`); if (fail) process.exit(1); };

// 短摘要 + 长对话:确保通过 shrink 校验(摘要必须明显小于被压缩区间)
function fakeAgent() {
  const a = new Agent({ emit: () => {} });
  a._systemPrompt = () => 'sys'; // 不依赖真实环境快照
  a.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake-1', contextWindow: 8000 });
  a.llm = {
    isMock: false,
    contextWindow: 8000,
    maxTokens: 1024,
    async chat() {
      return { content: '【checkpoint 摘要】目标:治理上下文;已完成:读取与修改;待办:验证。', toolCalls: [], reasoning: '' };
    }
  };
  a.llmConfigured = true;
  return a;
}

// 往会话里灌 n 组「用户提问 + 助手长回复」，内容足够长以触发压缩收益
function fillConversation(session, groups) {
  for (let g = 0; g < groups; g++) {
    const turn = g + 1;
    session.append('turn/start', { turn });
    session.append('user/message', { content: `问题${g}:` + '请分析这个模块的实现细节并给出改造方案。'.repeat(60), source: 'user' });
    session.append('assistant/message', { turn, step: 1, message: { role: 'assistant', content: `回答${g}:` + '这里是一大段实现说明与代码走读结论。'.repeat(60) } });
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
  }
}

// ---- 1/2/3/6: 压缩落盘 + 切走再切回仍在 ----
{
  const agent = fakeAgent();
  const sid = agent.createSession('压缩持久化').id;
  const session = agent._runtimes.get(sid).session;
  fillConversation(session, 3);
  store.saveEvents(sid, session.events);

  const before = projectEvents(store.loadEvents(sid));
  check('压缩前投影不含压缩标记行', !before.some((t) => t.compaction));

  const r = await agent.compactNow(sid);
  check('compactNow 报告已压缩', r.compacted === true && r.dropCount >= 2, `got ${JSON.stringify({ c: r.compacted, d: r.dropCount })}`);

  const onDisk = store.loadEvents(sid);
  const cp = onDisk.filter((e) => e.type === 'compaction/done');
  check('压缩检查点已落盘(切会话/重启读得到的正是它)', cp.length === 1 && typeof cp[0].data?.dropThroughSeq === 'number',
    `got ${JSON.stringify(cp.map((e) => Object.keys(e.data || {})))}`);
  check('手动压缩标记 manual=true 已持久化', cp[0]?.data?.manual === true);

  // 模拟「切到别的会话」:空闲 runtime 被回收,只剩磁盘日志
  agent._runtimes.delete(sid);
  const back = agent.getHistory(sid);
  const row = back.find((t) => t.compaction);
  check('切走再切回:历史投影仍带压缩标记行', !!row && row.compaction.manual === true);
  check('压缩标记行携带摘要正文', !!row && /checkpoint 摘要/.test(row.content || ''));
  // 非破坏压缩:早期消息仍在显示视图里(压缩标记行本身也是 user 角色,故额外 +1)
  check('非破坏压缩:早期消息在显示视图里仍完整可回看',
    back.filter((t) => t.role === 'user' && !t.compaction).length === 3,
    `got ${back.filter((t) => t.role === 'user' && !t.compaction).length}`);

  // 切回后重建的运行时,模型面历史必须真的跳过被压缩区间
  agent.switchSession(sid);
  const modelMsgs = agent._runtimes.get(sid).session.deriveMessages({ budgetChars: Infinity });
  check('模型历史以压缩摘要打头', modelMsgs[0]?.role === 'user' && /上下文已手动压缩/.test(modelMsgs[0].content));
  check('模型历史不再包含被压缩的早期提问',
    !modelMsgs.slice(1).some((m) => m.role === 'user' && /^问题0:/.test(m.content)));
}

// ---- 4: 已从内存释放的空闲会话也要能压缩(旧实现回落活跃会话或抛「会话不存在」) ----
{
  const agent = fakeAgent();
  const sid = agent.createSession('磁盘态会话').id;
  fillConversation(agent._runtimes.get(sid).session, 3);
  store.saveEvents(sid, agent._runtimes.get(sid).session.events);
  agent._runtimes.delete(sid); // 释放运行时:此后内存里没有任何该会话状态

  let err = null;
  const r = await agent.compactNow(sid).catch((e) => { err = e; });
  check('空闲会话(不在内存)可被压缩,不再报「会话不存在」', !err && r?.compacted === true, err ? err.message : '');
  check('压缩结果写回的是目标会话自己的日志',
    store.loadEvents(sid).some((e) => e.type === 'compaction/done'));
}

// ---- 5: 压缩只作用于指定 sid,不污染当前活跃会话 ----
{
  const agent = fakeAgent();
  const aId = agent.createSession('会话A').id;
  const bId = agent.createSession('会话B').id; // createSession 会把它设为活跃
  fillConversation(agent._runtimes.get(aId).session, 3);
  fillConversation(agent._runtimes.get(bId).session, 3);
  store.saveEvents(aId, agent._runtimes.get(aId).session.events);
  store.saveEvents(bId, agent._runtimes.get(bId).session.events);

  check('压缩目标与会话B一致(活跃会话正是 B)', agent.sessionId === bId);
  // 把活跃会话指向 B,却请求压缩 A:A 应被压缩,B 保持原样
  agent.switchSession(bId);
  const r = await agent.compactNow(aId);
  check('按 sid 压缩 A 成功', r?.compacted === true);
  check('A 已带压缩检查点', store.loadEvents(aId).some((e) => e.type === 'compaction/done'));
  check('B 未被顺手压缩(压缩不会写到活跃会话之外)',
    !store.loadEvents(bId).some((e) => e.type === 'compaction/done'));
}

// ---- 会话日志的序列化往返:检查点字段不得在 JSON 往返中丢失 ----
{
  const s = new Session();
  fillConversation(s, 2);
  const trace = s.deriveMessagesWithTrace({ budgetChars: Infinity });
  s.markCompacted(trace.slice(0, 2).map((t) => t.seq), 'SUMMARY', { dropCount: 2, manual: true });
  const round = new Session(JSON.parse(JSON.stringify(s.events)));
  const cp = round.events.find((e) => e.type === 'compaction/done');
  check('dropThroughSeq 经序列化往返保留(切会话读盘等价路径)', cp && typeof cp.data.dropThroughSeq === 'number');
  const msgs = round.deriveMessages({ budgetChars: Infinity });
  check('往返后模型历史仍以摘要顶替早期消息', msgs[0]?.content === 'SUMMARY');
}

// ---- 7: RPC 接线:前端带的 { sid } 必须真的落到 compactNow 的目标参数上 ----
// 过去 handler 读的是 msg.id(前端从不发送该字段),于是压缩永远落在服务端「活跃会话」上,
// 与用户正在看的会话失步时就把压缩写进了别的会话。
{
  const { createRpcRouter } = await import('../server/api/rpc/router.ts');
  const { agent: singleton } = await import('../server/agent/agent.ts');
  const orig = singleton.compactNow;
  let seen = 'NOT_CALLED';
  singleton.compactNow = async (id) => { seen = id; return { compacted: true, dropCount: 7 }; };
  let out = null;
  const rpc = createRpcRouter({ send: () => {}, emitStatus: () => {}, syncAgentScope: () => {} });
  await rpc.handle({ type: 'compact_now', sid: 's_target_1', reqId: 42 }, { send: (p) => { out = p; } });
  singleton.compactNow = orig;
  check('compact_now 把 msg.sid 作为目标会话传给 compactNow', seen === 's_target_1', `got ${JSON.stringify(seen)}`);
  check('compact_now 应答带回结果并携带 reqId(前端据此 resolve 命令卡)',
    !!out && out.reqId === 42 && out.compacted === true && out.dropCount === 7, `got ${JSON.stringify(out)}`);
}

finish();
