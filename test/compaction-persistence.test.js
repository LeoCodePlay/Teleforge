// 上下文压缩的持久化与会话切换回归测试。
// 起因:/compact 压缩在前端看起来成功,切换会话再切回却消失——因为压缩从未真正落到
// 服务端事件日志。这组用例锁定「压缩结果必须活过会话切换」这条不变量:
//   1) compactNow 写入的检查点带 dropThroughSeq 且已落盘;
//   2) 该会话 runtime 被释放(切走)再载入,历史投影仍含压缩标记行;
//   3) 模型面历史确实跳过被压缩区间(压缩真的生效,不只是显示);
//   4) 已从内存释放的空闲会话同样可压缩(旧实现直接抛「会话不存在」);
//   5) 压缩只作用于指定 sid,不污染当前活跃会话;
//   6) 非破坏压缩:显示视图仍完整保留早期消息。
//   7) 中途压过多次时,每次压缩各留一条标记行;失败行(compaction/failed)同样进记录。
// 全程用假 LLM,不打真实网络;会话写入临时 DATA_DIR,不碰用户数据。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-compact-'));

const { Agent, projectEvents, messageFaceIndexes } = await import('../server/agent/agent.ts');
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

// ---- 8: 手动 /compact 的失败必须抛错且**一条历史都不丢**(绝不退化成"丢弃早期消息") ----
// 历史缺陷:摘要返回空串时,compactNow 会写入一条「早期 N 条消息已省略」的通知行——
// 用户主动按了压缩,换来的却是永久丢失早期对话,而且看起来"成功了"。
{
  // 8a) 摘要为空:必须抛错、历史原样
  const a = fakeAgent();
  a.llm = { isMock: false, contextWindow: 8000, maxTokens: 1024, async chat() { return { content: '', toolCalls: [] }; } };
  const sid = a.createSession('空摘要').id;
  const session = a._runtimes.get(sid).session;
  fillConversation(session, 4);
  const beforeEvents = session.events.length;
  const beforeMsgs = session.deriveMessages({ budgetChars: Infinity }).length;
  let err = null;
  try { await a.compactNow(sid); } catch (e) { err = e; }
  check('空摘要:compactNow 抛错(不静默成功)', !!err, `err=${err && err.message}`);
  check('空摘要:错误信息说明历史保持不变', /历史保持不变/.test(String(err?.message)), `msg=${err?.message}`);
  check('空摘要:事件日志无 compaction/done 检查点', !session.events.some((e) => e.type === 'compaction/done'));
  check('空摘要:事件数与模型面消息数都没变(未裁剪)', session.events.length === beforeEvents
    && session.deriveMessages({ budgetChars: Infinity }).length === beforeMsgs,
  `events=${session.events.length}/${beforeEvents} msgs=${session.deriveMessages({ budgetChars: Infinity }).length}/${beforeMsgs}`);

  // 8b) 摘要请求失败:同样抛错、历史原样
  const b = fakeAgent();
  b.llm = { isMock: false, contextWindow: 8000, maxTokens: 1024, async chat() { throw new Error('上游摘要 500'); } };
  const sid2 = b.createSession('摘要失败').id;
  const s2 = b._runtimes.get(sid2).session;
  fillConversation(s2, 4);
  const before2 = s2.events.length;
  let err2 = null;
  try { await b.compactNow(sid2); } catch (e) { err2 = e; }
  check('摘要失败:compactNow 抛错', !!err2 && /上游摘要 500/.test(String(err2?.message)), `msg=${err2?.message}`);
  check('摘要失败:事件数不变(未裁剪)', s2.events.length === before2, `${s2.events.length}/${before2}`);
  check('摘要失败:无 compaction/done 检查点', !s2.events.some((e) => e.type === 'compaction/done'));

  // 8c) 摘要正常时仍然照常成功(确认上面的改动没有把成功路径也堵死)
  const c = fakeAgent();
  const sid3 = c.createSession('正常压缩').id;
  const s3 = c._runtimes.get(sid3).session;
  fillConversation(s3, 4);
  const r = await c.compactNow(sid3);
  check('摘要正常:compactNow 正常成功', r.compacted === true && r.dropCount > 0, JSON.stringify(r));
  check('摘要正常:模型面首条是压缩摘要', /上下文已手动压缩/.test(s3.deriveMessages({ budgetChars: Infinity })[0]?.content || ''));
  check('摘要正常:被压早期消息仍完整保留在日志里(非破坏)', s3.events.some((e) => e.type === 'user/message' && e.data.source === 'user'));
}


// ---- 9: 中途压了多次 —— 每条检查点各留一行;失败行也进记录(投影与下标同构) ----
// 历史缺陷:显示投影只保留"最后一条生效检查点",一次对话里压过好几次时,刷新/切回会话后
// 早期每一次压缩的痕迹全都没了(用户看到的只是"上下文忽然变短了")。
{
  const s = new Session();
  fillConversation(s, 4);
  let trace = s.deriveMessagesWithTrace({ budgetChars: Infinity });
  s.markCompacted(trace.slice(0, 4).map((t) => t.seq), '【上下文已自动压缩】摘要#1', { dropCount: 4, manual: false });
  s.append('turn/start', { turn: 5 });
  s.append('user/message', { content: '继续', source: 'user' });
  s.append('assistant/message', { turn: 5, step: 1, message: { role: 'assistant', content: '继续的回复' } });
  trace = s.deriveMessagesWithTrace({ budgetChars: Infinity });
  const drop2 = trace.length - 2;
  s.markCompacted(trace.slice(0, drop2).map((t) => t.seq), '【上下文已自动压缩】摘要#2', { dropCount: drop2, manual: false });
  // 之后又触发过一次压缩但被用户按停:不再弹 ⚠ 提示,记录里留一行「压缩未完成」
  s.append('compaction/failed', { reason: '摘要生成失败:已停止', manual: false });

  const turns = projectEvents(s.events);
  const rows = turns.filter((t) => t.compaction);
  check('两次压缩各留一条标记行(不再只剩最后一次)', rows.length === 3, `rows=${rows.length}`);
  check('标记行按发生顺序排列,且各自带摘要正文',
    /摘要#1/.test(String(rows[0]?.content || '')) && /摘要#2/.test(String(rows[1]?.content || '')),
    JSON.stringify(rows.map((r) => String(r.content || '').slice(0, 14))));
  check('失败行投影为「压缩未完成」并带原因',
    rows[2]?.compaction?.failed === true && /已停止/.test(String(rows[2]?.compaction?.reason || '')),
    JSON.stringify(rows[2]));
  check('显示投影与消息面下标同构(删除/回退/分支仍需正确索引)',
    turns.length === messageFaceIndexes(s.events).length,
    `turns=${turns.length} faces=${messageFaceIndexes(s.events).length}`);
  check('失败行不进模型上下文',
    !s.deriveMessages({ budgetChars: Infinity }).some((m) => String(m.content || '').includes('压缩未完成')));
  check('模型面仍只遵循最新检查点', /摘要#2/.test(s.deriveMessages({ budgetChars: Infinity })[0]?.content || ''));
  // 删掉第一条标记行 = 取消第一次压缩(下标必须命中那条检查点事件)
  const firstMarkerIdx = turns.findIndex((t) => t.compaction && !t.compaction.failed);
  check('第一条标记行的下标对应第一次压缩的检查点事件',
    s.events[messageFaceIndexes(s.events)[firstMarkerIdx]]?.type === 'compaction/done');
}

// ---- 10: 原位投影——标记行落在压缩发生那一刻的最后一条消息之后,且重投影位置不变 ----
// 用户诉求:压缩记录只在「当前这次压缩」时出现在对话流末尾(当时最后一条消息之后),
// 之后作为普通历史记录固定在那里;刷新/切回会话重投影时不得再次搬动。
{
  const s = new Session();
  // 两组历史 + 本轮提问,再压缩早期 4 条消息面(前两组)
  fillConversation(s, 2);
  s.append('turn/start', { turn: 3 });
  s.append('user/message', { content: '本轮的新问题', source: 'user' });
  const trace = s.deriveMessagesWithTrace({ budgetChars: Infinity });
  s.markCompacted(trace.slice(0, 4).map((t) => t.seq), '摘要#原位', { dropCount: 4, manual: true });

  const once = projectEvents(s.events);
  const markerIdx = once.findIndex((t) => t.compaction && !t.compaction.failed);
  check('标记行落在压缩发生那一刻的最后一条消息之后(本轮提问之后)',
    markerIdx > 0 && once[markerIdx - 1]?.role === 'user' && once[markerIdx - 1]?.content === '本轮的新问题',
    JSON.stringify(once.map((t) => `${t.role}:${String(t.content || '').slice(0, 6)}`)));
  // 压缩之后再继续对话:新消息排在标记行之后(记录固定在原处,不再被搬到末尾)
  s.append('turn/start', { turn: 4 });
  s.append('user/message', { content: '后续新问题', source: 'user' });
  const twice = projectEvents(s.events);
  const mIdx = twice.findIndex((t) => t.compaction && !t.compaction.failed);
  check('后续新消息排在标记行之后(记录固定在原处,不再每次重载被搬到末尾)',
    mIdx >= 0 && twice.slice(mIdx + 1).some((t) => t.content === '后续新问题'),
    JSON.stringify(twice.map((t) => `${t.role}:${String(t.content || '').slice(0, 6)}`)));
  check('重投影后标记行下标不变(刷新/切回会话位置稳定)', mIdx === markerIdx, `first=${markerIdx} again=${mIdx}`);
  // 原位投影下标记行排在保留区之后:模型面起点(retainedFrom)必须先于标记行,才能还原 [摘要, ...保留区]
  check('标记行携带 retainedFrom(保留区起点在标记行之前)',
    typeof once[markerIdx]?.compaction?.retainedFrom === 'number'
    && once[markerIdx].compaction.retainedFrom < markerIdx,
    JSON.stringify(once[markerIdx]?.compaction));
}
finish();
