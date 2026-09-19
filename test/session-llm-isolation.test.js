// 回归:模型配置按会话隔离。
//
// 线上故障:在 A 会话切到一个没余额的模型(402 INSUFFICIENT_BALANCE),正在后台运行的 B 会话
// 下一步请求也被换成了那个模型,于是 B 也以「本轮执行失败」收尾并停下——用户的理解是
// 「切模型只针对 A 会话」,这没错,错的是当时 agent.llm 是全局单例、主循环每一步都读它。
//
// 修复后的契约(本文件断言的就是它):
// 1) 下发带 sid 的配置只写该会话的模型快照(见 Agent._llmFor);
// 2) 一轮在开始时就锁定模型,轮内不再读全局——所以切换不能打断正在跑的一轮;
// 3) 不带 sid(草稿/新建态)只更新全局默认,新会话继承它,已有快照的会话不受影响;
// 4) 「模型不支持工具 → 纯对话」的降级标记同样按会话隔离。
process.env.DATA_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'sshai-llm-iso-'));
process.env.LLM_RETRY_BASE_DELAY_MS = '20';
process.env.LLM_RETRY_MAX_DELAY_MS = '60';
process.env.LLM_RETRY_BUDGET_MS = '8000';

import http from 'node:http';
const { Agent } = await import('../server/agent/agent.ts');
const { sshManager: ssh } = await import('../server/core/ssh-manager.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  OK   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${e}`); } };

ssh.status = 'connected';
ssh.platform = 'posix';
ssh.workspace = '/home';
ssh.hostInfo = { host: 'h', port: 22, username: 'u' };
ssh.listDir = async () => [];
ssh.atype = async () => 'file';
ssh.stat = async () => ({ isDirectory: () => true });

// ---- 假网关:按脚本逐次响应,记录每次请求(用于核对每次请求实际用的 model) ----
const sse = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
let script = [];
let seen = [];
let afterFirstResponse = null; // 第 1 个响应发出后触发的钩子(制造「请求之间」的切换窗口)
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push(JSON.parse(body || '{}'));
    const n = seen.length;
    const step = script.shift() || { type: 'ok', text: '默认回复' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (step.tool) {
      res.write(sse({ tool_calls: [{ index: 0, id: `call_${n}`, type: 'function', function: { name: step.tool, arguments: '{}' } }] }));
      res.write(sse({}, 'tool_calls'));
    } else {
      res.write(sse({ content: step.text || '' }));
      res.write(sse({}, 'stop'));
    }
    res.write('data: [DONE]\n\n');
    res.end();
    if (n === 1 && afterFirstResponse) { const cb = afterFirstResponse; afterFirstResponse = null; setImmediate(cb); }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const events = [];
const agent = new Agent({ emit: (e, p) => events.push([e, p]) });
agent.configureLlm({ baseUrl, apiKey: 'test', model: 'deepseek-chat' });
const a = agent.createSession('A');
const b = agent.createSession('B');
// 模拟"前端打开过 B":切到某个会话时会把该会话的模型带 sid 下发一次(见 web 的 trackSession)
agent.configureLlm(b.id, { baseUrl, apiKey: 'test', model: 'deepseek-chat' });

const runTurn = async (sid) => {
  const from = agent._runtimes.get(sid).session.events.length;
  await agent.submit(sid, '干活');
  const evs = agent._runtimes.get(sid).session.events.slice(from);
  const ends = evs.filter((e) => e.type === 'turn/end');
  return { reason: ends.length ? ends[ends.length - 1].data.reason : null, notices: evs.filter((e) => e.type === 'notice').map((e) => e.data.text) };
};

console.log('== A 会话切模型不能打断正在后台运行的 B 会话 ==');
{
  // B 第 1 步返回工具调用:在"第 1 步响应之后、第 2 步请求之前"插入 A 会话的模型切换
  script = [{ tool: 'get_local_info' }, { type: 'ok', text: 'B 的第 2 步' }];
  seen = [];
  afterFirstResponse = () => agent.configureLlm(a.id, { baseUrl, apiKey: 'test', model: 'deepseek-flash' });
  const t = await runTurn(b.id);
  check('B 第 1 步用自己的模型', seen[0]?.model === 'deepseek-chat', String(seen[0]?.model));
  check('A 切模型后 B 下一步没被换模型', seen[1]?.model === 'deepseek-chat', String(seen[1]?.model));
  check('B 本轮正常收尾(不再被陌生的 402 打断)', t.reason?.kind === 'completed', JSON.stringify(t.reason));
  check('B 没有收到「本轮执行失败」', !t.notices.some((x) => /本轮执行失败/.test(String(x))), JSON.stringify(t.notices));
  check('A 的切换没有改动全局默认(还没打开过的会话不会被带走)', agent.llm?.model === 'deepseek-chat', String(agent.llm?.model));
}

console.log('== 切模型只改目标会话,不带 sid 只更新全局默认(新会话继承) ==');
{
  script = [{ type: 'ok', text: 'A 用新模型' }, { type: 'ok', text: 'B 仍用旧模型' }];
  seen = [];
  const ta = await runTurn(a.id);
  check('A 的请求用刚切过去的模型', seen[0]?.model === 'deepseek-flash', String(seen[0]?.model));
  check('A 本轮正常收尾', ta.reason?.kind === 'completed', JSON.stringify(ta.reason));
  const tb = await runTurn(b.id);
  check('B 的请求仍是自己的模型', seen[1]?.model === 'deepseek-chat', String(seen[1]?.model));
  check('B 本轮正常收尾', tb.reason?.kind === 'completed', JSON.stringify(tb.reason));

  // 旧签名(不带 sid):只更新全局默认;已有快照的会话不被波及,新会话继承新默认
  agent.configureLlm({ baseUrl, apiKey: 'test', model: 'default-model' });
  check('不带 sid 的旧签名仍更新全局默认', agent.llm?.model === 'default-model', String(agent.llm?.model));
  check('已固化快照的 B 不受全局默认变化影响', agent._llmFor(b.id)?.model === 'deepseek-chat', String(agent._llmFor(b.id)?.model));
  const c = agent.createSession('C');
  check('新会话继承全局默认', agent._llmFor(c.id)?.model === 'default-model', String(agent._llmFor(c.id)?.model));
  const d = agent.createSession('D');
  check('从未打开过的会话也跟随全局默认', agent._llmFor(d.id)?.model === 'default-model', String(agent._llmFor(d.id)?.model));
}

console.log('== 「工具降级纯对话」标记按会话隔离 ==');
{
  agent._markChatOnly(a.id);
  check('被标记的会话进入降级', agent._chatOnlyFor(a.id) === true);
  check('未标记的会话不受影响', agent._chatOnlyFor(b.id) === false);
  agent.configureLlm(b.id, { baseUrl, apiKey: 'test', model: 'deepseek-chat' });
  check('B 换模型不会清掉 A 的降级标记', agent._chatOnlyFor(a.id) === true);
  agent.configureLlm(a.id, { baseUrl, apiKey: 'test', model: 'deepseek-chat' });
  check('A 自己换模型才清掉自己的降级标记', agent._chatOnlyFor(a.id) === false);
}

server.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
