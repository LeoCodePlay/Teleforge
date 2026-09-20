// 手动压缩(/compact)期间切换会话的回归测试。
// 线上现象:点了「压缩上下文」,摘要还没生成完就切到别的会话再切回来 —— 压缩记录不见了,
// 而且模型上下文也没有真的被压缩(下次继续对话又会爆窗)。
// 根因:compactNow 在 await 摘要之前捕获了 rt.session 的引用;摘要生成期间用户切走,
// switchSession 见 prev.busy=false 就把该会话的 runtime 从 _runtimes 里释放了;
// 用户切回时又从磁盘重新载入了一个**不含检查点**的新 runtime。压缩完成时写回的是那个
// 已经没人持有的孤儿 session,而 _runtimes 里留着的新 runtime 永远不知道检查点存在:
//   1) getHistory 优先读内存 runtime -> 压缩标记行消失;
//   2) 之后任何一轮落盘都会用内存日志覆盖磁盘 -> 检查点被永久抹掉。
// 不变量:压缩完成后,无论期间怎么切会话,「当前注册的 runtime」必须能看到检查点。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-compact-race-'));

const { Agent } = await import('../server/agent/agent.ts');
const store = await import('../server/store/session-store.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const finish = () => { console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`); if (fail) process.exit(1); };

function fillConversation(session, groups) {
  for (let g = 0; g < groups; g++) {
    const turn = g + 1;
    session.append('turn/start', { turn });
    session.append('user/message', { content: `问题${g}:` + '请分析这个模块的实现细节并给出改造方案。'.repeat(60), source: 'user' });
    session.append('assistant/message', { turn, step: 1, message: { role: 'assistant', content: `回答${g}:` + '这里是一大段实现说明与代码走读结论。'.repeat(60) } });
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
  }
}

// 摘要调用可控挂起:让测试精确落在「摘要生成中」这个窗口里切会话
function gatedAgent() {
  const a = new Agent({ emit: () => {} });
  a._systemPrompt = () => 'sys';
  a.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake-1', contextWindow: 8000 });
  let release;
  const gate = new Promise((res) => { release = res; });
  a.llm = {
    isMock: false, contextWindow: 8000, maxTokens: 1024,
    async chat() {
      await gate;
      return { content: '【checkpoint 摘要】目标:治理上下文;已完成:读取与修改;待办:验证。', toolCalls: [], reasoning: '' };
    }
  };
  a.llmConfigured = true;
  return { a, release };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- 1: 摘要生成中切走再切回:压缩完成后当前 runtime 必须带检查点 ----
{
  const { a, release } = gatedAgent();
  const sid = a.createSession('压缩中切走').id;
  fillConversation(a._runtimes.get(sid).session, 3);
  store.saveEvents(sid, a._runtimes.get(sid).session.events);
  const other = a.createSession('其它会话').id;
  a.switchSession(sid); // 回到目标会话,使其成为活跃会话

  const p = a.compactNow(sid); // 摘要请求挂起,尚未返回
  await tick();
  a.switchSession(other); // 摘要生成中切走 -> 旧实现会释放 sid 的 runtime
  a.switchSession(sid);   // 再切回来 -> 旧实现从磁盘重建了一个不含检查点的 runtime
  release();
  const r = await p;
  check('compactNow 报告压缩成功', r.compacted === true, JSON.stringify(r));

  const mem = a._runtimes.get(sid)?.session.events || [];
  check('当前 runtime 的内存日志含压缩检查点(切回后也能看到标记行)',
    mem.some((e) => e.type === 'compaction/done'), `memEvents=${mem.length}`);
  const hist = a.getHistory(sid);
  check('getHistory(切回后的当前会话)投影出压缩标记行',
    hist.some((t) => t.compaction && !t.compaction.failed), `turns=${hist.length}`);
  check('磁盘日志同样保留检查点', store.loadEvents(sid).some((e) => e.type === 'compaction/done'));
}

// ---- 2: 压缩期间切走且**不再切回**:不能把 runtime 复活成与磁盘不一致的孤儿 ----
{
  const { a, release } = gatedAgent();
  const sid = a.createSession('切走不回').id;
  fillConversation(a._runtimes.get(sid).session, 3);
  store.saveEvents(sid, a._runtimes.get(sid).session.events);
  const other = a.createSession('别的会话').id;
  a.switchSession(sid);

  const p = a.compactNow(sid);
  await tick();
  a.switchSession(other); // 切走,之后不再切回
  release();
  await p;

  const mem = a._runtimes.get(sid)?.session.events || [];
  check('压缩期间切走:磁盘与(可能被复活的)内存 runtime 一致',
    mem.length === 0 || mem.some((e) => e.type === 'compaction/done'),
    `memEvents=${mem.length} disk=${store.loadEvents(sid).length}`);
  const hist = a.getHistory(sid);
  check('切回该会话(冷载入)仍能看到压缩标记行',
    hist.some((t) => t.compaction && !t.compaction.failed), `turns=${hist.length}`);
}

// ---- 3: 压缩期间切走再切回后继续对话:下一轮落盘不得抹掉检查点 ----
{
  const { a, release } = gatedAgent();
  const sid = a.createSession('压缩后继续').id;
  fillConversation(a._runtimes.get(sid).session, 3);
  store.saveEvents(sid, a._runtimes.get(sid).session.events);
  const other = a.createSession('旁边会话').id;
  a.switchSession(sid);

  const p = a.compactNow(sid);
  await tick();
  a.switchSession(other);
  a.switchSession(sid);
  release();
  await p;

  // 模拟"继续对话后轮末落盘":用当前 runtime 的日志写回磁盘(agent 的常规落盘路径)
  const rt = a._runtimes.get(sid);
  if (rt) store.saveEvents(sid, rt.session.events);
  check('继续对话后的落盘不会抹掉压缩检查点',
    store.loadEvents(sid).some((e) => e.type === 'compaction/done'));
}

finish();
