// 「重试次数」账目测试(用户反馈:连接超时/未响应 600s 就直接停止,明明还有重试额度)。
// 现行语义:不再有总时长预算(BUDGET_MS 已移除),唯一的放弃条件是重试次数用尽(MAX_ATTEMPTS)。
// 用可控的假网关验证三件事:
//   1) 网关假死(接了连接一个字节都不发)时,单次尝试被静默看门狗掐断并继续重试,
//      一直重试到次数用尽才停 —— 而不是一次假死就让整轮失败;
//   2) 流一直有数据却永不结束时,由「单次尝试总时长上限」(ATTEMPT_MS)兜底掐断并继续重试
//      (这种情形静默看门狗每收到数据就被重置,永远等不到);
//   3) 空响应(正文/思考/工具调用全空)同样要重试多次,且失败原因保留在文案里。
process.env.LLM_RETRY_BASE_DELAY_MS = '20';
process.env.LLM_RETRY_MAX_DELAY_MS = '60';
process.env.LLM_RETRY_MAX_ATTEMPTS = '5';
// 静默看门狗压到 200ms、单次尝试总时长上限压到 1000ms(生产默认都是 300s):
// 毫秒级跑完与生产同一套时序
process.env.LLM_STREAM_IDLE_MS = '200';
process.env.LLM_ATTEMPT_MS = '1000';

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
      }, 40);
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

console.log('== 重试次数账目 ==');
const MAX = LLM_RETRY.MAX_ATTEMPTS;

// 1) 网关假死:必须一直重试到次数用尽(旧行为:总预算一到就停)
script = Array.from({ length: 30 }, () => ({ type: 'silent' }));
seen = [];
{
  const { message } = await run();
  check('假死时重试到次数用尽(共发起 MAX_ATTEMPTS 次请求)', seen.length === MAX, `请求 ${seen.length} 次 / 上限 ${MAX}`);
  check('放弃时说明是重试次数用尽', /重试次数已用尽/.test(message) && /已自动重试/.test(message), message);
}

// 2) 流一直有数据但永不结束:静默看门狗等不到,必须由单次尝试总时长上限兜底
script = Array.from({ length: 30 }, () => ({ type: 'trickle' }));
seen = [];
{
  const { message } = await run();
  check('慢响应不会「永远生成中」:单次尝试超时后继续重试', seen.length > 1, `请求 ${seen.length} 次`);
  check('掐断原因是单次尝试超时', /单次尝试超过/.test(message), message);
}

// 3) 空响应(正文/思考/工具调用全空):正是用户遇到的那种失败,同样要继续重试
script = Array.from({ length: 30 }, () => ({ type: 'empty' }));
seen = [];
{
  const { message } = await run();
  check('空响应会重试多次', seen.length > 1, `请求 ${seen.length} 次`);
  check('空响应的失败原因保留在文案里', /空响应/.test(message), message);
}

console.warn = realWarn;
server.close();
console.log(`\n== 结果:${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
