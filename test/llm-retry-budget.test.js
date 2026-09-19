// 「重试预算」账目测试(用户反馈:模型连接中断时「只重试 1 次就放弃」)。
// 用可控的假网关验证三件事:
//   1) 网关假死(接了连接一个字节都不发)时,单次尝试的等待不超过剩余预算,
//      所以同一轮里还能继续重试,而不是一次假死就把整轮预算吃光;
//   2) 流一直有数据却永不结束时,由预算 deadline 兜底掐断(静默看门狗永远等不到);
//   3) 放弃时文案写清「为什么停」(重试总预算用尽),且总耗时不超过预算。
process.env.LLM_RETRY_BASE_DELAY_MS = '20';
process.env.LLM_RETRY_MAX_DELAY_MS = '60';
process.env.LLM_RETRY_BUDGET_MS = '1200';
process.env.LLM_RETRY_MAX_ATTEMPTS = '20';
// 静默看门狗压到 300ms(生产默认 60s):毫秒级跑完与生产同一套时序
process.env.LLM_STREAM_IDLE_MS = '300';

import http from 'node:http';
const { LlmClient, LLM_RETRY } = await import('../server/agent/llm.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

const sseChunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

let script = [];
let seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push(JSON.parse(body || '{}'));
    const step = script.shift() || { type: 'ok' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (step.type === 'silent') return; // 建好连接却一个字节都不发:网关假死
    if (step.type === 'trickle') {       // 一直有数据在流、但永远不结束:静默看门狗等不到
      const stop = () => clearInterval(timer);
      const timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) return stop();
        try { res.write(sseChunk({ content: '.' })); } catch { stop(); }
      }, 80);
      res.on('close', stop);
      res.on('error', stop);
      return;
    }
    res.write(sseChunk({}, 'stop')); // 空响应:只有结束标记,正文/思考/工具调用全空
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const mkClient = () => new LlmClient({ baseUrl, apiKey: 'test', model: 'deepseek-chat', maxTokens: 64 });

const realWarn = console.warn;
console.warn = () => {}; // 静音重试日志,只保留断言结果

const run = async () => {
  const t0 = Date.now();
  let err = null;
  try {
    await mkClient().chat({ messages: [{ role: 'user', content: 'hi' }] });
  } catch (e) { err = e; }
  return { ms: Date.now() - t0, message: String(err?.message || '') };
};

console.log('== 重试预算账目 ==');
const BUDGET = LLM_RETRY.BUDGET_MS;

// 1) 网关假死:单次尝试不允许吃掉整轮预算(否则用户看到的就是「只重试 1 次就放弃」)
script = Array.from({ length: 30 }, () => ({ type: 'silent' }));
seen = [];
{
  const { message, ms } = await run();
  check('假死时同一轮确实重试了多次(不是 1 次就放弃)', seen.length > 1, `请求 ${seen.length} 次`);
  check('总耗时被重试总预算钉住(不会因为静默超时更长而无限等)', ms <= BUDGET * 2, `${ms}ms`);
  check('放弃时说明是重试总预算用尽', /预算已用尽/.test(message) && /已自动重试/.test(message), message);
}

// 2) 流一直有数据但永不结束:静默看门狗等不到,必须由 deadline 兜底
script = [{ type: 'trickle' }, { type: 'ok' }];
seen = [];
{
  const { message, ms } = await run();
  check('慢响应不再「永远生成中」:预算到点即掐断', seen.length === 1 && ms <= BUDGET * 2, `请求 ${seen.length} 次 / ${ms}ms`);
  check('掐断原因是重试预算用尽', /预算/.test(message) && /已用尽/.test(message), message);
}

// 3) 空响应(正文/思考/工具调用全空):正是用户遇到的那种失败,同样要继续重试
script = Array.from({ length: 30 }, () => ({ type: 'empty' }));
seen = [];
{
  const { message, ms } = await run();
  check('空响应会重试多次', seen.length > 1, `请求 ${seen.length} 次`);
  check('空响应的失败原因保留在文案里', /空响应/.test(message), message);
  check('总耗时被预算钉住', ms <= BUDGET * 2, `${ms}ms`);
}

console.warn = realWarn;
server.close();
console.log(`\n== 结果:${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
