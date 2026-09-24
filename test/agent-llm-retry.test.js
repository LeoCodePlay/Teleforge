// 端到端回归:模型响应在对话中途被网关掐断 / 限流时,本轮不再「突然中断」。
// 真实链路:LlmClient(真 fetch + 真 SSE 解析 + 真重试)→ Agent 主循环 → 会话事件日志。
// 断言的是用户可见结果:本轮仍然跑完(completed)、本轮日志里只有一条完整回复(没有半句残留)、
// 重试事件带着回滚标记;余额不足时不再空等,而是在同一提供商的多个 Key 之间自动轮询。
process.env.DATA_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'sshai-retry-'));
process.env.LLM_RETRY_BASE_DELAY_MS = '20';
process.env.LLM_RETRY_MAX_DELAY_MS = '60';
process.env.LLM_ATTEMPT_MS = '8000'; // 单次尝试总时长上限(替代已移除的重试总预算)

import http from 'node:http';
const { Agent } = await import('../server/agent/agent.ts');
const { sshManager: ssh } = await import('../server/core/ssh-manager.ts');
const { LLM_RETRY } = await import('../server/agent/llm.ts');
const { aiProviders, usableKeys } = await import('../server/store/ai-providers-store.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  OK   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${e}`); } };

ssh.status = 'connected';
ssh.platform = 'posix';
ssh.workspace = '/home';
ssh.hostInfo = { host: 'h', port: 22, username: 'u' };
ssh.listDir = async () => [];
ssh.atype = async () => 'file';
ssh.stat = async () => ({ isDirectory: () => true });

// ---- 假网关:按脚本逐次响应,记录每次请求 ----
const sse = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
let script = [];
let seen = [];
let auths = []; // 每次请求的 Authorization 头:验证「余额不足后切换到下一个 Key」
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push(JSON.parse(body || '{}'));
    auths.push(String(req.headers.authorization || ''));
    const step = script.shift() || { type: 'ok', text: '默认回复' };
    if (step.type === 'status') {
      res.writeHead(step.code, { 'Content-Type': 'application/json' });
      res.end(step.body ?? '{}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (step.reasoning) res.write(sse({ reasoning_content: step.reasoning }));
    if (step.text) res.write(sse({ content: step.text }));
    if (step.type === 'cut') { setTimeout(() => res.destroy(), 5); return; } // 已流出内容后掐断连接
    if (step.type === 'eof') { res.end(); return; } // 没有 finish_reason / [DONE] 就关闭(响应被截断)
    res.write(sse({}, 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const warns = [];
const realWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(' ')); };

function makeAgent(llmCfg = {}) {
  const events = [];
  const agent = new Agent({ emit: (e, p) => events.push([e, p]) });
  agent.configureLlm({ baseUrl, apiKey: 'test', model: 'deepseek-chat', ...llmCfg });
  return { agent, events };
}
// 只取事件载荷(payload),并按本轮切片:同一进程里会话历史会跨 Agent 累积
const agentEvents = (events, ev, pred = () => true) =>
  events.filter(([e, p]) => e === 'agent' && p && p.event === ev && pred(p)).map(([, p]) => p);
const runTurn = async (agent, events, text) => {
  const off = events.length;
  const from = agent.session.events.length;
  await agent.run(text);
  const evs = agent.session.events.slice(from);
  const ends = evs.filter((e) => e.type === 'turn/end');
  return {
    reason: ends.length ? ends[ends.length - 1].data.reason : null,
    assistant: evs.filter((e) => e.type === 'assistant/message').map((e) => e.data.message),
    retries: agentEvents(events.slice(off), 'retry'),
    errors: agentEvents(events.slice(off), 'error'),
    reasoningDeltas: agentEvents(events.slice(off), 'reasoning_delta'),
    textDeltas: agentEvents(events.slice(off), 'text_delta')
  };
};

console.log('== 对话中途被掐断不再中断本轮 ==');

// 1) 思考流到一半被掐断(实测最常见的形态:推理模型先流 reasoning 再被 terminated)
script = [{ type: 'cut', reasoning: '让我先想一下这个问题的关键点' }, { type: 'ok', text: '重试后的完整回答' }];
seen = [];
{
  const { agent, events } = makeAgent();
  const t = await runTurn(agent, events, '帮我看个问题');
  check('思考被掐断后本轮仍然跑完(completed)', t.reason?.kind === 'completed', JSON.stringify(t.reason));
  check('重试一次后拿到完整回复', t.assistant.length === 1 && t.assistant[0].content === '重试后的完整回答', JSON.stringify(t.assistant.map((m) => m.content)));
  check('本轮日志只有一条回复(没有半句残留)', t.assistant.length === 1, String(t.assistant.length));
  check('重试事件带 discard(通知前端回滚这半句)', t.retries.length === 1 && t.retries[0].discard === true, JSON.stringify(t.retries));
  check('半成品思考确实到过前端(回滚确有必要)', t.reasoningDeltas.length > 0);
  check('本轮没有报错事件', t.errors.length === 0);
  check('网关共收到 2 次请求', seen.length === 2, String(seen.length));
}

// 2) 正文流到一半被掐断:同样自动重发这一步
script = [{ type: 'cut', text: '我正在为你整理这份答案的前半段' }, { type: 'ok', text: '完整答案' }];
seen = [];
{
  const { agent, events } = makeAgent();
  const t = await runTurn(agent, events, '继续');
  check('正文被掐断后本轮仍然跑完', t.reason?.kind === 'completed', JSON.stringify(t.reason));
  check('最终只有一条完整回复、不拼接半句', t.assistant.length === 1 && t.assistant[0].content === '完整答案', JSON.stringify(t.assistant.map((m) => m.content)));
  check('重试事件带 discard', t.retries.length === 1 && t.retries[0].discard === true, JSON.stringify(t.retries));
}

// 3) 429 限流:等网关要求的时长后重试成功
script = [
  { type: 'status', code: 429, body: JSON.stringify({ code: 'RATE_LIMITED', message: '请求过于频繁', data: { retryAfterSeconds: 1 } }) },
  { type: 'ok', text: '限流后跑通' }
];
seen = [];
{
  const { agent, events } = makeAgent();
  const t = await runTurn(agent, events, '限流场景');
  check('限流后本轮跑完', t.reason?.kind === 'completed' && t.assistant[0]?.content === '限流后跑通', JSON.stringify(t.assistant.map((m) => m.content)));
  check('重试等待遵循网关 retryAfterSeconds', !!t.retries[0] && t.retries[0].delayMs >= 900, JSON.stringify(t.retries[0]));
  check('重试次数记为上界的第 1 次', !!t.retries[0] && t.retries[0].retry === 1 && t.retries[0].maxRetries === LLM_RETRY.MAX_ATTEMPTS, JSON.stringify(t.retries[0]));
}

// 4) 402 余额不足:不空等,给出可操作提示(但依然不静默中断)
script = [{ type: 'status', code: 402, body: JSON.stringify({ code: 'INSUFFICIENT_BALANCE', message: '余额不足' }) }];
seen = [];
{
  const { agent, events } = makeAgent();
  const t = await runTurn(agent, events, '余额场景');
  check('402 只请求 1 次(不白等)', seen.length === 1, String(seen.length));
  check('402 本轮以 error 收尾并可见', t.reason?.kind === 'error', JSON.stringify(t.reason));
  check('错误文案给出充值指引', /余额不足/.test(t.errors[0]?.message || '') && /充值/.test(t.errors[0]?.message || ''), t.errors[0]?.message);
  check('402 不派发无意义的重试', t.retries.length === 0, JSON.stringify(t.retries));
  check('402 不产生半截回复', t.assistant.length === 0, String(t.assistant.length));
}

// 5) 网关不吐结束标记就关闭(响应被截断):先重试,恢复后正常收尾
script = [
  { type: 'eof', text: '被截断的这半句' },
  { type: 'ok', text: '截断重试后的完整回复' }
];
seen = [];
{
  const { agent, events } = makeAgent();
  const t = await runTurn(agent, events, '截断场景');
  check('无结束标记的截断会重试并跑完', t.reason?.kind === 'completed', JSON.stringify(t.reason));
  check('截断的残句不落盘,只留重试后的完整回复',
    t.assistant.length === 1 && t.assistant[0].content === '截断重试后的完整回复',
    JSON.stringify(t.assistant.map((m) => m.content)));
  check('截断重试也带 discard', t.retries.length === 1 && t.retries[0].discard === true, JSON.stringify(t.retries));
  check('网关共收到 2 次请求', seen.length === 2, String(seen.length));
}

// 6) 连续 503 期间不在第一步就放弃:重试到上限才报错,且错误文案说明重试过
//    脚本条数必须多于重试上限:否则网关会在第 N 次改回成功,变成「重试成功」而不是「到上限放弃」
script = Array.from({ length: LLM_RETRY.MAX_ATTEMPTS + 10 }, () => ({ type: 'status', code: 503, body: 'upstream down' }));
seen = [];
{
  const { agent, events } = makeAgent();
  const t = await runTurn(agent, events, '持续 503');
  check('持续 503 时重试到上限才放弃', seen.length === LLM_RETRY.MAX_ATTEMPTS, String(seen.length));
  check('放弃时说明已重试次数', /已自动重试/.test(t.errors[0]?.message || ''), t.errors[0]?.message);
  check('放弃后本轮以 error 收尾(不是静默卡死)', t.reason?.kind === 'error', JSON.stringify(t.reason));
}

// 7) 多 Key 轮询(端到端):第 1 个 Key 余额不足 -> 自动切到第 2 个 Key,本轮照常跑完。
//    同时验证服务端确实把「无余额」写回提供商配置,并广播 key_exhausted 让界面出徽标。
const pid = 'u_e2e_multikey';
aiProviders.add({ id: pid, name: 'E2E', baseUrl, apiKey: 'key-one', apiKeys: ['key-one', 'key-two'], models: ['deepseek-chat'], note: '' });
script = [
  { type: 'status', code: 402, body: JSON.stringify({ code: 'INSUFFICIENT_BALANCE', message: '余额不足' }) },
  { type: 'ok', text: '第二个 Key 的回答' }
];
seen = [];
auths = [];
{
  const { agent, events } = makeAgent({ apiKey: 'key-one', apiKeys: ['key-one', 'key-two'], providerId: pid });
  const t = await runTurn(agent, events, '多 Key 场景');
  const exhausted = agentEvents(events, 'key_exhausted');
  const stored = aiProviders.find(pid);
  check('第 1 个 Key 余额不足后本轮仍跑完(不中断对话)', t.reason?.kind === 'completed', JSON.stringify(t.reason));
  check('最终回复来自第 2 个 Key', t.assistant.length === 1 && t.assistant[0].content === '第二个 Key 的回答', JSON.stringify(t.assistant.map((m) => m.content)));
  check('网关收到 2 次请求、第 2 次换了 Key', seen.length === 2 && auths[0] === 'Bearer key-one' && auths[1] === 'Bearer key-two', JSON.stringify(auths));
  check('本轮没有报错事件', t.errors.length === 0, JSON.stringify(t.errors));
  check('换 Key 对用户可见(重试事件说明原因)', t.retries.length === 1 && /余额不足/.test(t.retries[0].error || ''), JSON.stringify(t.retries));
  check('广播 key_exhausted 供界面刷新徽标', exhausted.length === 1 && exhausted[0].key === 'key-one' && exhausted[0].providerId === pid, JSON.stringify(exhausted));
  check('「无余额」写回提供商配置', stored?.keyStates?.['key-one']?.exhausted === true, JSON.stringify(stored?.keyStates));
  check('该提供商的可用 Key 只剩第 2 个(重置前不再尝试第 1 个)', JSON.stringify(usableKeys(stored)) === '["key-two"]', JSON.stringify(usableKeys(stored)));
  check('重置后第 1 个 Key 重新可用', aiProviders.resetKey(pid, 'key-one') === true && JSON.stringify(usableKeys(aiProviders.find(pid))) === '["key-one","key-two"]', JSON.stringify(usableKeys(aiProviders.find(pid))));
}

// 8) 所有 Key 都余额不足:停止重试,本轮以 error 收尾并指引「充值 + 重置」
const pid2 = 'u_e2e_allgone';
aiProviders.add({ id: pid2, name: 'E2E2', baseUrl, apiKey: 'k1', apiKeys: ['k1', 'k2'], models: ['deepseek-chat'], note: '' });
script = [
  { type: 'status', code: 402, body: JSON.stringify({ code: 'INSUFFICIENT_BALANCE', message: '余额不足' }) },
  { type: 'status', code: 402, body: JSON.stringify({ code: 'INSUFFICIENT_BALANCE', message: '余额不足' }) }
];
seen = [];
auths = [];
{
  const { agent, events } = makeAgent({ apiKey: 'k1', apiKeys: ['k1', 'k2'], providerId: pid2 });
  const t = await runTurn(agent, events, '全部 Key 都没余额');
  const exhausted = agentEvents(events, 'key_exhausted');
  const stored = aiProviders.find(pid2);
  check('全部 Key 无余额时只遍历一遍(每 Key 一次)', seen.length === 2, String(seen.length));
  check('两个 Key 都被判定无余额', exhausted.map((e) => e.key).join(',') === 'k1,k2', JSON.stringify(exhausted.map((e) => e.key)));
  check('本轮以 error 收尾(不静默卡死)', t.reason?.kind === 'error', JSON.stringify(t.reason));
  check('错误文案指引充值 + 重置', /充值/.test(t.errors[0]?.message || '') && /重置/.test(t.errors[0]?.message || ''), t.errors[0]?.message);
  check('该提供商已无任何可用 Key', usableKeys(stored).length === 0, JSON.stringify(usableKeys(stored)));
}

console.warn = realWarn;
check('重试过程有可诊断日志', warns.some((w) => /\[llm\]/.test(w)));

server.close();
console.log(`\n== 结果:${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
