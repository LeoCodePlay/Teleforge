// 回归:手动压缩(/compact)期间提交的消息,压缩结束后必须被自动派发执行。
//
// 线上现象:用户在一个会话里点了「压缩上下文」,摘要还在生成时又发了一条任务(前端显示
// 「等待执行」)。压缩成功后那条任务确实离开了待执行队列,但 agent 再也没回复——界面停在
// 「生成中」、毫无输出。
//
// 不变量:compactNow 的 finally 复位 rt.compacting 时,只要该会话不忙,就必须把
// rt.pending / rt.inbox 里的输入真正交给 driver(而不是只把队列快照广播成空)。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-compact-queued-'));

const { Agent } = await import('../server/agent/agent.ts');
const store = await import('../server/store/session-store.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const finish = () => { console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`); if (fail) process.exit(1); };

const tick = () => new Promise((r) => setTimeout(r, 0));
const waitFor = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await tick(); }
  return !!fn();
};

function fillConversation(session, groups) {
  for (let g = 0; g < groups; g++) {
    const turn = g + 1;
    session.append('turn/start', { turn });
    session.append('user/message', { content: `问题${g}:` + '请分析这个模块的实现细节并给出改造方案。'.repeat(200), source: 'user' });
    session.append('assistant/message', { turn, step: 1, message: { role: 'assistant', content: `回答${g}:` + '这里是一大段实现说明与代码走读结论。'.repeat(200) } });
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
  }
}

/**
 * 摘要请求可控挂起(用来精确落在「压缩中」这个窗口),普通一轮请求立即返回。
 * @param {() => boolean} paused 返回 true 表示摘要请求已被发起、正挂起
 */
function gatedAgent() {
  const a = new Agent({ emit: () => {} });
  a._systemPrompt = () => 'sys';
  a.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake-1', contextWindow: 64000 });
  let release;
  const gate = new Promise((res) => { release = res; });
  const turnReqs = []; // 普通轮次的请求(不含摘要请求)
  let summaryPaused = false;
  a.llm = {
    isMock: false, contextWindow: 64000, maxTokens: 1024,
    async chat({ messages, maxTokens }) {
      const isSummary = (maxTokens === 8192) || messages.some((m) => String(m.content || '').includes('压缩引擎'));
      if (isSummary) {
        summaryPaused = true;
        await gate;
        return { content: '【checkpoint 摘要】目标:治理上下文;已完成:读取与修改;待办:验证。', toolCalls: [], reasoning: '' };
      }
      turnReqs.push(messages);
      return { content: '已收到,开始处理。', toolCalls: [], reasoning: '' };
    }
  };
  a.llmConfigured = true;
  return { a, release, turnReqs, summaryPaused: () => summaryPaused };
}

function setup(name, groups = 4) {
  const { a, release, turnReqs, summaryPaused } = gatedAgent();
  const sid = a.createSession(name).id;
  fillConversation(a._runtimes.get(sid).session, groups);
  store.saveEvents(sid, a._runtimes.get(sid).session.events);
  a.switchSession(sid);
  return { a, sid, release, turnReqs, summaryPaused };
}

const lastEvent = (a, sid) => {
  const ev = a._runtimes.get(sid)?.session.events || [];
  return ev[ev.length - 1];
};
const typesAfter = (a, sid, n) => (a._runtimes.get(sid)?.session.events || []).slice(n).map((e) => e.type);

// ---- 1: 压缩期间提交一条消息 → 压缩结束后必须自动开轮 ----
{
  const { a, sid, release, turnReqs, summaryPaused } = setup('压缩期间排队');
  const before = a._runtimes.get(sid).session.events.length;

  const cp = a.compactNow(sid);
  await waitFor(() => summaryPaused());
  check('已进入压缩(摘要请求挂起)', summaryPaused() === true);

  const p = Promise.resolve(a.submit(sid, '下一条任务:把刚才的改动补上测试')).catch(() => {});
  await tick();
  check('压缩期间提交进入待执行队列', a.queueSnapshot(sid).length === 1, JSON.stringify(a.queueSnapshot(sid)));

  release();
  const r = await cp;
  check('手动压缩成功', r.compacted === true, JSON.stringify(r));

  const started = await waitFor(() => turnReqs.length > 0 || typesAfter(a, sid, before).includes('turn/start'));
  check('压缩结束后待执行消息被真正派发(开了一轮)', started === true,
    'events=' + typesAfter(a, sid, before).join(','));
  check('该轮带着那条排队的消息', typesAfter(a, sid, before).includes('user/message'),
    'events=' + typesAfter(a, sid, before).join(','));
  check('待执行队列已清空', a.queueSnapshot(sid).length === 0);
  await p;
  const done = await waitFor(() => a._runtimes.get(sid)?.busy === false, 3000);
  check('该轮跑完回到空闲', done === true);
  const userMsgs = (a._runtimes.get(sid)?.session.events || []).slice(before)
    .filter((e) => e.type === 'user/message' && (e.data || {}).source === 'user');
  check('那一轮落盘的用户消息就是排队的那条',
    userMsgs.some((e) => String(e.data.content || '').includes('下一条任务')),
    JSON.stringify(userMsgs.map((e) => String(e.data.content).slice(0, 30))));
  check('回复已落盘', typesAfter(a, sid, before).includes('assistant/message'));
  check('空闲后 isCompacting 复位', a.isCompacting(sid) === false);
}

// ---- 2: 压缩期间点「立即执行」→ 压缩结束后同样必须开轮 ----
{
  const { a, sid, release, turnReqs, summaryPaused } = setup('压缩期间立即执行');
  const before = a._runtimes.get(sid).session.events.length;

  const cp = a.compactNow(sid);
  await waitFor(() => summaryPaused());
  a.submit(sid, '立即执行的任务');
  await tick();
  const item = a.queueSnapshot(sid)[0];
  check('队列里拿到待执行项', !!item, JSON.stringify(a.queueSnapshot(sid)));
  a.steerQueueItem(item.id, sid); // 前端「立即执行」:消息从 pending 移进 inbox
  check('立即执行后队列面板已空(看起来"发出去了")', a.queueSnapshot(sid).length === 0);

  release();
  await cp;
  const started = await waitFor(() => turnReqs.length > 0, 2000);
  check('压缩结束后立即执行的消息被派发', started === true, 'turnReqs=' + turnReqs.length);
  check('模型收到的是那条消息',
    turnReqs.some((msgs) => msgs.some((m) => String(m.content || '').includes('立即执行的任务'))),
    JSON.stringify((turnReqs[turnReqs.length - 1] || []).map((m) => [m.role, String(m.content || '').slice(0, 40)])));
}

// ---- 3: 压缩期间提交 + 期间切走再切回 → 消息不能永远留在队列里 ----
{
  const { a, sid, release, turnReqs, summaryPaused } = setup('压缩期间切走再切回');
  const other = a.createSession('旁边会话').id;
  a.switchSession(sid);

  const cp = a.compactNow(sid);
  await waitFor(() => summaryPaused());
  a.submit(sid, '切走期间排队的任务');
  await tick();
  a.switchSession(other);
  a.switchSession(sid);
  release();
  await cp;
  const started = await waitFor(() => turnReqs.length > 0, 2000);
  check('切走再切回后压缩结束,排队的消息仍被派发', started === true, 'turnReqs=' + turnReqs.length);
}

finish();
