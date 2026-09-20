// 「本轮为什么停住」必须留在对话里(可见、可回放),且绝不进入发给模型的上下文。
// 覆盖三条曾经会静默收尾的路径(用户反馈:对话毫无征兆停掉、也没有报错):
//   1) 模型请求失败并自动重试 → 重试记录落库、在对话里发生的位置显示、不进模型上下文;
//   2) 上游流被截断(重试后仍无结束标记)→ 本轮以 truncated 收尾,并在对话里留下可见披露;
//   3) 绑定服务器掉线被迫中断 → 对话里写明「与哪台服务器的连接断了」,而不是无声停住。
// 注意:本测试写会话历史,需在临时 DATA_DIR 里隔离运行。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-interrupt-'));
process.env.LLM_RETRY_BASE_DELAY_MS = '20';
process.env.LLM_RETRY_MAX_DELAY_MS = '60';
process.env.LLM_RETRY_BUDGET_MS = '5000';
process.env.LLM_RETRY_MAX_ATTEMPTS = '4';
// 看门狗压到 3s:本地假网关假死时测试不会挂到 180s
process.env.LLM_STREAM_IDLE_MS = '3000';

import http from 'node:http';
const { Agent, projectEvents, messageFaceIndexes } = await import('../server/agent/agent.ts');
const { sshManager: ssh } = await import('../server/core/ssh-manager.ts');
const sessions = await import('../server/store/session-store.ts');
const { Session } = await import('../server/agent/session.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const finish = () => { console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`); process.exit(fail ? 1 : 0); };
const waitFor = async (fn, timeout = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
  return fn();
};

ssh.status = 'connected';
ssh.platform = 'posix';
ssh.workspace = '/home';
ssh.hostInfo = { host: 'h', port: 22, username: 'u' };
ssh.listDir = async () => [];
ssh.atype = async () => 'file';
ssh.stat = async () => ({ isDirectory: () => true });

// ---- 假网关:按脚本逐次响应 ----
const sse = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
let script = [];
let seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push(JSON.parse(body || '{}'));
    const step = script.shift() || { type: 'ok', text: '默认回复' };
    if (step.type === 'status') {
      res.writeHead(step.code, { 'Content-Type': 'application/json' });
      res.end(step.body ?? '{}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (step.text) res.write(sse({ content: step.text }));
    if (step.type === 'cut') { setTimeout(() => res.destroy(), 5); return; }   // 已流出内容后掐断
    if (step.type === 'eof') { res.end(); return; }                            // 无 finish_reason / [DONE] 就关闭
    if (step.type === 'doneOnly') { res.write('data: [DONE]\n\n'); res.end(); return; } // 有 [DONE] 但整条流没有 finish_reason
    if (step.type === 'hold') return;                                          // 保持打开:等客户端中止(模拟掉线)
    res.write(sse({}, 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const realWarn = console.warn;
console.warn = () => {}; // 静音重试日志,断言结果保持可读

function makeAgent() {
  const events = [];
  const agent = new Agent({ emit: (e, p) => events.push([e, p]) });
  agent.configureLlm({ baseUrl, apiKey: 'test', model: 'deepseek-chat' });
  return { agent, events };
}
const agentEvents = (events, ev, pred = () => true) =>
  events.filter(([e, p]) => e === 'agent' && p && p.event === ev && pred(p)).map((pair) => pair[1]);

const runTurn = async (agent, text) => {
  const from = agent.session.events.length;
  await agent.run(text);
  const evs = agent.session.events.slice(from);
  const ends = evs.filter((e) => e.type === 'turn/end');
  return {
    evs,
    reason: ends.length ? ends[ends.length - 1].data.reason : null,
    turns: agent.getHistory(),
    derived: agent.session.deriveMessages()
  };
};

const j = (v) => JSON.stringify(v ?? null);

console.log('== 1) 重试记录:落库 + 显示在对话发生的位置 + 不进模型上下文 ==');
{
  script = [{ type: 'cut', text: '被掐断的半句' }, { type: 'ok', text: '重试后的完整回答' }];
  seen = [];
  const { agent, events } = makeAgent();
  const t = await runTurn(agent, '请回答');

  const retryEv = t.evs.filter((e) => e.type === 'llm/retry');
  check('重试记录已写进会话日志(llm/retry)', retryEv.length === 1, j(t.evs.map((e) => e.type)));
  check('重试记录带次数/上限/原因', retryEv[0] && retryEv[0].data.retry === 1 && retryEv[0].data.maxRetries === 4 && /terminated|other side closed|请求/i.test(String(retryEv[0].data.error)), j(retryEv[0]?.data));
  check('重试记录标记了半成品已回滚(discard)', retryEv[0]?.data.discard === true, j(retryEv[0]?.data));

  const retryTurns = t.turns.filter((x) => x.retry);
  check('历史投影里有重试行(刷新/切回后仍然可见)', retryTurns.length === 1, j(t.turns.map((x) => x.role)));
  check('重试行渲染为 notice + RetryRow 数据', retryTurns[0]?.role === 'notice' && retryTurns[0]?.retry?.state === 'started', j(retryTurns[0]));
  const userIdx = t.turns.findIndex((x) => x.role === 'user' && String(x.content).includes('请回答'));
  const asstIdx = t.turns.findIndex((x) => x.role === 'assistant' && String(x.content).includes('重试后的完整回答'));
  const rIdx = t.turns.findIndex((x) => x.retry);
  check('重试行落在「用户提问之后、最终回答之前」的位置', userIdx >= 0 && rIdx > userIdx && rIdx < asstIdx, `user=${userIdx} retry=${rIdx} asst=${asstIdx}`);

  check('重试记录不进模型上下文', t.derived.every((m) => !m.retry && !m.kind), j(t.derived.map((m) => m.role)));
  check('模型上下文里没有重试失败原文', !j(t.derived).includes(String(retryEv[0]?.data?.error || '\u0000none')), String(retryEv[0]?.data?.error));
  check('模型上下文里只有一条 assistant 回复(重试没有额外产生消息)', t.derived.filter((m) => m.role === 'assistant').length === 1, j(t.derived.map((m) => [m.role, String(m.content).slice(0, 20)])));
  check('发给网关的第二次请求里也没有重试记录', !/llm\/retry|"retry"|被掐断/.test(j(seen[seen.length - 1]?.messages)), j(seen[seen.length - 1]?.messages));

  check('投影与消息面下标一一对应(回退/删除索引不会错位)',
    projectEvents(agent.session.events).length === messageFaceIndexes(agent.session.events).length,
    `turns=${projectEvents(agent.session.events).length} faces=${messageFaceIndexes(agent.session.events).length}`);
}

console.log('== 2) 流被截断:本轮显式收尾 + 对话里留下可见披露 ==');
{
  script = [{ type: 'eof', text: '只写了一半' }, { type: 'eof', text: '第二次还是没写完' }];
  seen = [];
  const { agent, events } = makeAgent();
  const t = await runTurn(agent, '写一篇长文');

  check('本轮结束原因记为 truncated(不是静默 completed)', t.reason?.kind === 'truncated', j(t.reason));
  const noticeEv = t.evs.filter((e) => e.type === 'notice' && e.data?.kind === 'truncated');
  check('截断披露已写进会话日志(notice)', noticeEv.length === 1, j(t.evs.filter((e) => e.type === 'notice').map((e) => e.data)));
  check('实时也广播了这条披露且标记 persisted', agentEvents(events, 'notice').some((p) => p.kind === 'truncated' && p.persisted === true), j(agentEvents(events, 'notice')));

  const lastTurns = t.turns.slice(-2);
  check('披露行紧跟在本步回复之后(对话最后位置)', lastTurns[0]?.role === 'assistant' && /没写完/.test(String(lastTurns[0].content)) && lastTurns[1]?.role === 'notice' && lastTurns[1]?.kind === 'truncated', j(lastTurns));
  check('截断的正文保留下来(不白扔)', /没写完/.test(String(lastTurns[0]?.content || '')), j(lastTurns[0]));
  check('截断披露不进模型上下文', t.derived.every((m) => !/本次回复可能不完整/.test(String(m.content || ''))), j(t.derived.map((m) => m.content)));
  check('用户继续对话时模型看不到这条披露(只在显示面)', !/本次回复可能不完整/.test(j(seen[seen.length - 1]?.messages)), j(seen[seen.length - 1]?.messages));

  // 「用户继续」:披露行必须留在历史里,并且新一轮的模型上下文依然看不到它
  script = [{ type: 'ok', text: '接着写完了' }];
  const from = agent.session.events.length;
  await agent.run('继续');
  const evs2 = agent.session.events.slice(from);
  const turns2 = agent.getHistory();
  check('用户继续后披露行仍在对话里', turns2.some((x) => x.role === 'notice' && x.kind === 'truncated'), j(turns2.map((x) => x.kind || x.role)));
  check('继续后的新一轮上下文同样不含披露行', agent.session.deriveMessages().every((m) => !/本次回复可能不完整/.test(String(m.content || ''))));
  check('新一轮确实跑完了', evs2.some((e) => e.type === 'assistant/message' && /接着写完了/.test(String(e.data.message.content))), j(evs2.map((e) => e.type)));
}

console.log('== 3) 服务器掉线被迫中断:对话里写明原因,而不是无声停住 ==');
{
  const KEY = 'root@10.9.9.9:22';
  const fakeConn = { status: 'connected', hostInfo: { host: '10.9.9.9', port: 22, username: 'root' } };
  ssh.conns.set(KEY, fakeConn);
  ssh._activeId = KEY;              // 活动连接 = 这台(production 由 connect 写入,测试直接注入)
  ssh.workspace = '/home';          // 把工作区写进该连接:会话据此归属并绑定这台服务器

  const { agent, events } = makeAgent();
  agent._connKey = KEY;             // 会话归属这台服务器(绑定到它才能被"掉线"连带中止)
  agent.createSession('掉线中断');
  const rt = agent._runtimes.get(agent.sessionId);
  rt.workspace = '/home';           // 占用远程工作区 → 本轮绑定该连接

  script = [{ type: 'hold', text: '正在生成的内容' }];
  seen = [];
  const from = agent.session.events.length;
  const p = agent.run('长任务');
  await waitFor(() => agentEvents(events, 'text_delta').length > 0, 3000);
  agent.stopForConn(fakeConn);      // 模拟 SSH 连接掉线
  await p;

  const evs = agent.session.events.slice(from);
  const ends = evs.filter((e) => e.type === 'turn/end');
  const reason = ends.length ? ends[ends.length - 1].data.reason : null;
  check('本轮结束原因记录了中止来源(conn-lost)', reason?.kind === 'aborted' && reason?.cause === 'conn-lost', j(reason));

  const notice = evs.filter((e) => e.type === 'notice' && e.data?.kind === 'interrupted');
  check('掉线中断已写进会话日志(notice/interrupted)', notice.length === 1, j(evs.filter((e) => e.type === 'notice').map((e) => e.data)));
  check('提示里写明是哪台服务器的连接断了', /root@10\.9\.9\.9:22/.test(String(notice[0]?.data?.text || '')), String(notice[0]?.data?.text));
  const turns = agent.getHistory();
  check('提示行落在对话最后(可回看的可见记录)', turns[turns.length - 1]?.role === 'notice' && turns[turns.length - 1]?.kind === 'interrupted', j(turns.slice(-2)));
  check('已生成的部分内容被保留', turns.some((x) => x.role === 'assistant' && /正在生成的内容/.test(String(x.content))), j(turns.map((x) => x.content)));
  check('掉线提示不进模型上下文', agent.session.deriveMessages().every((m) => !/连接已断开/.test(String(m.content || ''))), j(agent.session.deriveMessages().map((m) => m.content)));

  // 用户主动停止(不是掉线)不该刷出"被迫中断"的提示
  script = [{ type: 'hold', text: '第二批内容' }];
  const from2 = agent.session.events.length;
  const p2 = agent.run('再来一次');
  await waitFor(() => agentEvents(events, 'text_delta').length > 1, 3000);
  agent.stop();
  await p2;
  const evs2 = agent.session.events.slice(from2);
  check('用户主动停止不出「被迫中断」提示', !evs2.some((e) => e.type === 'notice' && e.data?.kind === 'interrupted'), j(evs2.filter((e) => e.type === 'notice').map((e) => e.data)));

  ssh.conns.delete(KEY);
  ssh._activeId = null;
}

console.log('== 4) 请求彻底失败:原因也留在对话里(不只在瞬时错误条) ==');
{
  script = Array.from({ length: 6 }, () => ({ type: 'status', code: 402, body: '{"error":"insufficient balance"}' }));
  const { agent } = makeAgent();
  const t = await runTurn(agent, '会被拒绝的请求');
  check('本轮以 error 收尾', t.reason?.kind === 'error', j(t.reason));
  const notice = t.evs.filter((e) => e.type === 'notice' && e.data?.kind === 'turn-error');
  check('失败原因已落库(notice/turn-error)', notice.length === 1, j(t.evs.filter((e) => e.type === 'notice').map((e) => e.data)));
  check('失败原因里带上原始错误(可追溯)', /402|余额|insufficient/i.test(String(notice[0]?.data?.text || '')), String(notice[0]?.data?.text));
  check('失败披露不进模型上下文', t.derived.every((m) => !/本轮执行失败/.test(String(m.content || ''))), j(t.derived.map((m) => m.content)));
}

console.log('== 5) 重载(模拟重启/刷新/切走切回)后,重试与披露记录仍在对话里 ==');
{
  script = [
    { type: 'cut', text: '被掐断的半句' },
    { type: 'eof', text: '第一次没有结束标记' },
    { type: 'eof', text: '第二次还是没有结束标记' }
  ];
  const { agent } = makeAgent();
  agent.createSession('重载可见性');
  const sid = agent.sessionId;
  await agent.run('会被中断的问题');
  const before = agent.getHistory();
  check('前置:本轮既有重试记录又有截断披露',
    before.filter((x) => x.retry).length === 2 && before.some((x) => x.kind === 'truncated'),
    j(before.map((x) => x.kind || x.role)));

  // 新实例 = 重启/刷新:会话事件从磁盘重新载入后投影,记录必须还在
  const fresh = new Agent({ emit: () => {} });
  const after = fresh.getHistory(sid);
  check('重载后重试记录仍在(2 条,一条不少)', after.filter((x) => x.retry).length === 2, j(after.map((x) => x.kind || x.role)));
  check('重载后截断披露仍在', after.some((x) => x.role === 'notice' && x.kind === 'truncated'), j(after.map((x) => x.kind || x.role)));
  check('重载后对话顺序与重载前一致',
    j(after.map((x) => x.kind || x.role)) === j(before.map((x) => x.kind || x.role)),
    `${j(before.map((x) => x.kind || x.role))} vs ${j(after.map((x) => x.kind || x.role))}`);
  const diskEvents = sessions.loadEvents(sid);
  check('重载后的投影与消息面下标依然一一对应(回退索引不错位)',
    projectEvents(diskEvents).length === messageFaceIndexes(diskEvents).length,
    `turns=${projectEvents(diskEvents).length} faces=${messageFaceIndexes(diskEvents).length}`);
}

console.log('== 6) 进程中途被杀/热重启:输入不丢,且补出"未正常结束"的可见记录 ==');
{
  // 6a) 轮次一开始就把用户输入落盘(旧行为:整轮只在收尾落盘 → 崩溃时连问题都没了)
  script = [{ type: 'hold', text: '生成到一半' }];
  const { agent, events } = makeAgent();
  agent.createSession('崩溃前落盘');
  const sid = agent.sessionId;
  const p = agent.run('崩溃前我发的问题');
  await waitFor(() => agentEvents(events, 'text_delta').length > 0, 3000);
  const mid = sessions.loadEvents(sid);
  check('轮次一开始用户输入就已落盘',
    mid.some((e) => e.type === 'user/message' && String(e.data?.content || '').includes('崩溃前我发的问题')),
    j(mid.map((e) => e.type)));
  check('此刻磁盘上还没有 turn/end(正是崩溃前的状态)', !mid.some((e) => e.type === 'turn/end'), j(mid.map((e) => e.type)));
  agent.stop();
  await p;

  // 6b) 载入磁盘上的"未闭合轮次"→ 自愈:补可见披露 + turn/end,并把结果落盘
  const meta = sessions.create('崩溃遗留', 'local', {});
  const now = Date.now();
  sessions.saveEvents(meta.id, [
    { seq: 0, time: now, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: now, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, time: now, type: 'user/message', data: { content: '崩溃前我发的问题', display: '崩溃前我发的问题', source: 'user' } }
  ]);
  const fresh = new Agent({ emit: () => {} });   // 新实例 = 重启
  const turns = fresh.getHistory(meta.id);
  check('载入自愈:用户输入仍在对话里',
    turns.some((x) => x.role === 'user' && String(x.content).includes('崩溃前我发的问题')),
    j(turns.map((x) => x.kind || x.role)));
  check('载入自愈:补出"未正常结束"的可见披露',
    turns.some((x) => x.role === 'notice' && x.kind === 'unclean-shutdown'),
    j(turns.map((x) => x.kind || x.role)));
  check('披露落在该轮用户消息之后(对话发生的位置)',
    turns.findIndex((x) => x.kind === 'unclean-shutdown') > turns.findIndex((x) => x.role === 'user'),
    j(turns.map((x) => x.kind || x.role)));
  const disk = sessions.loadEvents(meta.id);
  check('自愈结果已落盘(turn/end 已补,下次载入不会再补一次)',
    disk.some((e) => e.type === 'turn/end') && disk.some((e) => e.type === 'notice' && e.data?.kind === 'unclean-shutdown'),
    j(disk.map((e) => e.type)));
  check('再次载入不重复补披露',
    fresh.getHistory(meta.id).filter((x) => x.kind === 'unclean-shutdown').length === 1);
  check('披露不进模型上下文',
    new Session(sessions.loadEvents(meta.id)).deriveMessages().every((m) => !/没有正常结束/.test(String(m.content || ''))),
    j(new Session(sessions.loadEvents(meta.id)).deriveMessages().map((m) => m.content)));
}

console.log('== 7) 绑定连接失败(本轮未执行):原因与未送达的输入都留在对话里 ==');
{
  const KEY = 'root@10.8.8.8:22';
  const { agent } = makeAgent();
  agent._connKey = KEY;
  const s = agent.createSession('绑定失败');
  const rt = agent._runtimes.get(s.id);
  rt.connKey = KEY;
  rt.workspace = '/home';                 // 占用该服务器上的工作区 → 本轮必须绑定它
  const realLookup = ssh.connByUserKey.bind(ssh);
  ssh.connByUserKey = () => null;         // 模拟"那台服务器当前没连上"
  const from = agent.session.events.length;
  await agent.run('这次会失败的问题');
  const evs = agent.session.events.slice(from);
  const notice = evs.filter((e) => e.type === 'notice' && e.data?.kind === 'turn-not-started');
  check('本轮未执行也留下可见记录', notice.length === 1, j(evs.map((e) => e.type)));
  check('记录里写明原因(未连接)', /未连接/.test(String(notice[0]?.data?.text || '')), String(notice[0]?.data?.text));
  check('记录里带上未送达的输入(用户的话不丢)', /这次会失败的问题/.test(String(notice[0]?.data?.text || '')), String(notice[0]?.data?.text));
  check('投影为对话里的一行 notice', agent.getHistory().some((x) => x.kind === 'turn-not-started'), j(agent.getHistory().map((x) => x.kind || x.role)));
  check('记录不进模型上下文', agent.session.deriveMessages().every((m) => !/本轮未执行/.test(String(m.content || ''))));
  ssh.connByUserKey = realLookup;
}

console.log('== 8) [DONE] 但没有 finish_reason(网关掐断后"干净收尾"):必须重试且不得记成正常完成 ==');
{
  script = [{ type: 'doneOnly', text: '说到一半' }, { type: 'doneOnly', text: '重试后仍无结束标记' }];
  seen = [];
  const { agent, events } = makeAgent();
  const t = await runTurn(agent, '会被掐断的问题');
  check('本轮以 truncated 收尾(不是 completed)', t.reason?.kind === 'truncated', j(t.reason));
  check('自动重试了一次(网关共收到 2 次请求)', seen.length === 2, String(seen.length));
  check('对话里有可见披露(不隐藏)', t.turns.some((x) => x.role === 'notice' && x.kind === 'truncated'), j(t.turns.map((x) => x.kind || x.role)));
  check('披露已落盘(重载后仍在)', t.evs.some((e) => e.type === 'notice' && e.data?.kind === 'truncated'), j(t.evs.map((e) => e.type)));
  const stepEnds = t.evs.filter((e) => e.type === 'step/end');
  check('step/end 落盘了 finish_reason 诊断(下次可直接判定根因)',
    stepEnds.some((e) => e.data && Object.prototype.hasOwnProperty.call(e.data, 'finishReason') && e.data.finishReason === null),
    j(stepEnds.map((e) => e.data)));
  check('step/end 标记了 truncated=true', stepEnds.some((e) => e.data?.truncated === true), j(stepEnds.map((e) => e.data)));
  check('披露不进模型上下文', t.derived.every((m) => !/本次回复可能不完整/.test(String(m.content || ''))), j(t.derived.map((m) => m.content)));
}

console.warn = realWarn;
server.close();
finish();
