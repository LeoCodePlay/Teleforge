// 回归:DeepSeek thinking_mode 的 reasoning_content 回传规则 + 「未回传」400 的自动降级重试。
// 真实链路:LlmClient(真 fetch + 真 SSE 解析 + 真重试)。断言的是实际发到网关的请求体。
process.env.LLM_RETRY_BASE_DELAY_MS = '10';
process.env.LLM_RETRY_MAX_DELAY_MS = '30';
process.env.LLM_RETRY_BUDGET_MS = '8000';

import http from 'node:http';
const { LlmClient } = await import('../server/agent/llm.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  OK   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${e}`); } };

const sse = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

// ---- 假网关:记录每次请求体;可按脚本先回错误状态码 ----
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
    res.write(sse({}, 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const TOOLS = [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } } }];
// 历史:一轮工具调用(带 reasoning)+ 一轮纯文本最终回答(带 reasoning)
const HISTORY = () => ([
  { role: 'user', content: '北京天气?' },
  { role: 'assistant', content: '我查一下。', reasoning_content: '调用 get_weather。', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'sunny' },
  { role: 'assistant', content: '北京晴。', reasoning_content: '已有工具结果,直接回答。' },
  { role: 'user', content: '那上海呢?' }
]);

const run = async (model, tools) => {
  seen = [];
  script = [{ type: 'ok', text: '好' }];
  const llm = new LlmClient({ baseUrl, apiKey: 'k', model });
  await llm.chat({ messages: HISTORY(), tools, onDelta: () => {} });
  return seen[0];
};

console.log('== reasoning_content 回传规则 ==');
{
  const body = await run('deepseek-flash', TOOLS);
  check('DeepSeek + tools:纯文本轮的 reasoning_content 保留(官方要求完整回传)',
    body.messages[3].reasoning_content === '已有工具结果,直接回答。', JSON.stringify(body.messages[3]));
  check('DeepSeek + tools:工具调用轮的 reasoning_content 保留',
    body.messages[1].reasoning_content === '调用 get_weather。', JSON.stringify(body.messages[1]));
}
{
  const body = await run('deepseek-flash', undefined);
  check('DeepSeek 不带 tools:纯文本轮的 reasoning_content 剥离(上游会忽略)',
    !('reasoning_content' in body.messages[3]), JSON.stringify(body.messages[3]));
  check('DeepSeek 不带 tools:工具调用轮的 reasoning_content 仍保留',
    body.messages[1].reasoning_content === '调用 get_weather。', JSON.stringify(body.messages[1]));
}
{
  const body = await run('gpt-4o', TOOLS);
  check('非 DeepSeek 提供方:维持原有剥离行为(只留 tool_calls 轮)',
    !('reasoning_content' in body.messages[3]) && body.messages[1].reasoning_content === '调用 get_weather。',
    JSON.stringify(body.messages.map((m) => m.reasoning_content)));
}

console.log('== 「reasoning_content 未回传」400 自动降级重试 ==');
{
  seen = [];
  script = [
    { type: 'status', code: 400, body: JSON.stringify({ code: 'LITELLM_ERROR', message: 'The `reasoning_content` in the thinking mode must be passed back to the API.' }) },
    { type: 'ok', text: '降级后跑通' }
  ];
  const llm = new LlmClient({ baseUrl, apiKey: 'k', model: 'deepseek-flash' });
  const res = await llm.chat({ messages: HISTORY(), tools: TOOLS, onDelta: () => {} });
  check('网关共收到 2 次请求(自动重试)', seen.length === 2, String(seen.length));
  check('第 2 次请求剥离了全部 reasoning_content', seen[1].messages.every((m) => !m || !('reasoning_content' in m)), JSON.stringify(seen[1].messages.map((m) => m.reasoning_content)));
  check('降级重试后本轮正常拿到回复', res.content === '降级后跑通', JSON.stringify(res));
}

server.close();
console.log(`\n== 结果:${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
