// 重试链路测试:验证「瞬态报错一律重试、不因一次报错就中断对话」的语义。
// 用本机假网关(可控地返回 5xx/429/402、掐断连接、无结束标记关闭、流中途输出后掐断),
// 断言:LlmClient 会重试、尊重网关给的等待时长、带 discard 回滚半成品、永久错误不空等。
// 退避/预算等常量在这里压到毫秒级(走环境变量),测试总耗时 < 5s。
process.env.LLM_RETRY_BASE_DELAY_MS = '20';
process.env.LLM_RETRY_MAX_DELAY_MS = '60';
process.env.LLM_RETRY_BUDGET_MS = '6000';
process.env.LLM_RETRY_MAX_ATTEMPTS = '10';
// 静默看门狗压到 250ms:验证「网关接了连接却一个字节都不发」不再永远卡住
process.env.LLM_STREAM_IDLE_MS = '250';

import http from 'node:http';
const { LlmClient, LLM_RETRY, isRetryableLlmError, LlmRequestError } = await import('../server/agent/llm.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

// ---- 假网关:按脚本逐次响应,记录每次收到的请求体 ----
const sseChunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

let script = [];
let seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push(JSON.parse(body || '{}'));
    const step = script.shift() || { type: 'ok', text: '默认回复' };
    if (step.type === 'hang') return; // 不响应:用于验证「等待期间用户停止」
    if (step.type === 'silent') { // 已建立连接(头部已发)却一个字节都不发:网关假死
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return;
    }
    if (step.type === 'json200') { // 200 但不是 SSE(网关把错误包成 JSON 返回)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(step.body ?? '{"error":{"message":"upstream busy"}}');
      return;
    }
    if (step.type === 'status') {
      res.writeHead(step.code, { 'Content-Type': 'application/json', ...(step.headers || {}) });
      res.end(step.body ?? '{}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (step.text) res.write(sseChunk({ content: step.text }));
    if (step.type === 'destroy') { setTimeout(() => res.destroy(), 5); return; } // 连接被掐断(无输出)
    if (step.type === 'partial') { setTimeout(() => res.destroy(), 5); return; } // 已输出一部分后被掐断
    if (step.type === 'eof') { res.end(); return; } // 没有 finish_reason / [DONE] 就关闭
    res.write(sseChunk({}, 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const mkClient = () => new LlmClient({ baseUrl, apiKey: 'test', model: 'deepseek-chat', maxTokens: 64 });
const run = (client, opts = {}) => {
  const retries = [];
  const texts = [];
  const p = client.chat({
    messages: [{ role: 'user', content: 'hi' }],
    onDelta: (d) => { if (d.kind === 'text') texts.push(d.text); },
    onRetry: (r) => retries.push(r),
    ...opts
  }).then((res) => ({ res, retries, texts }));
  // 失败分支也要能读到重试记录(挂到 promise 上,不随 catch 的返回值丢失)
  return Object.assign(p, { retries, texts });
};

// 静音重试日志(测试输出只保留断言结果),同时记录日志条数用于断言
const warns = [];
const realWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(' ')); };

console.log('== 重试语义 ==');

// 1) 5xx 连续两次后成功:重试到成功,不算「对话中断」
script = [{ type: 'status', code: 500, body: '<html>500 Internal Server Error</html>' }, { type: 'status', code: 500, body: 'boom' }, { type: 'ok', text: '最终回答' }];
seen = [];
{
  const { res, retries, texts } = await run(mkClient());
  check('500×2 后重试成功', res.content === '最终回答', JSON.stringify(res.content));
  check('一共发了 3 次请求', seen.length === 3, String(seen.length));
  check('重试次数从 1 起、上限 10', retries.length === 2 && retries[0].retry === 1 && retries[0].maxRetries === 10, JSON.stringify(retries.map((r) => [r.retry, r.maxRetries])));
  check('无内容可回滚时不带 discard', retries.every((r) => r.discard !== true));
  check('正文只流了一次、不重复', texts.join('') === '最终回答', texts.join(''));
}

// 2) 流已吐出一部分后被网关掐断:必须重试,并带 discard 让上层回滚半成品
script = [{ type: 'partial', text: '已经开始回答了' }, { type: 'ok', text: '完整回答' }];
seen = [];
{
  const { res, retries, texts } = await run(mkClient());
  check('流中断(已吐内容)会重试并最终成功', res.content === '完整回答', JSON.stringify(res.content));
  check('重试信息带 discard=true', retries.length === 1 && retries[0].discard === true, JSON.stringify(retries));
  check('第二次尝试是完整重发(前半段不再拼接)', res.content === '完整回答', JSON.stringify(res.content));
  check('已流出的半成品确实到过前端(证明回滚确有必要)', texts.includes('已经开始回答了'), JSON.stringify(texts));
}

// 3) 流已建立但没吐任何内容就被掐断:同样重试
script = [{ type: 'destroy' }, { type: 'ok', text: '恢复后的回答' }];
seen = [];
{
  const { res, retries } = await run(mkClient());
  check('空流被掐断也会重试', res.content === '恢复后的回答' && seen.length === 2, String(seen.length));
  check('空流失败不带 discard', retries[0] && retries[0].discard !== true);
}

// 4) 无结束标记([DONE]/finish_reason)就关闭:当作截断重试一次,第二次仍如此则接受
//    但必须带 truncated 标记 —— 上层据此在对话里留下"回复可能不完整"的可见记录,
//    绝不能再像从前那样静默当成正常完成。
script = [{ type: 'eof', text: '被截断的回答' }, { type: 'eof', text: '第二次仍无结束标记' }];
seen = [];
{
  const { res, retries } = await run(mkClient());
  check('无结束标记的截断先重试一次', seen.length === 2, String(seen.length));
  check('重试后仍无结束标记则接受结果(不无限重试)', res.content === '第二次仍无结束标记', JSON.stringify(res.content));
  check('截断重试也带 discard', retries.length === 1 && retries[0].discard === true, JSON.stringify(retries));
  check('接受的结果带 truncated 标记(上层必须向用户披露)', res.truncated === true, JSON.stringify(res.truncated));
}

// 4b) 正常收到 [DONE] + finish_reason:不带 truncated 标记(不能被误报成截断)
script = [{ type: 'ok', text: '完整回答' }];
{
  const { res } = await run(mkClient());
  check('正常收尾的结果不带 truncated 标记', res.truncated !== true && res.content === '完整回答', JSON.stringify(res));
}

// 4c) 200 但不是 SSE(网关把错误包成 JSON):必须重试,且错误里带原始报文片段
script = [{ type: 'json200', body: '{"error":{"message":"upstream busy"}}' }, { type: 'ok', text: '恢复后的回答' }];
seen = [];
{
  const { res, retries } = await run(mkClient());
  check('非 SSE 的 200 响应会重试', res.content === '恢复后的回答' && seen.length === 2, String(seen.length));
  check('错误里带上原始报文片段(可排查)', /不是 SSE/.test(String(retries[0]?.error || '')) && /upstream busy/.test(String(retries[0]?.error || '')), String(retries[0]?.error));
}

// 4d) 空响应(正文/思考/工具调用全空):不再被当成「模型没话说」静默收尾
script = Array.from({ length: 12 }, () => ({ type: 'ok' })); // 只有 finish_reason + [DONE],没有任何内容
seen = [];
{
  let err = null;
  await run(mkClient()).catch((e) => { err = e; });
  check('持续空响应最终报错(不静默完成)', /空响应/.test(String(err?.message)), String(err?.message));
  check('空响应确实重试过多次', seen.length > 1, String(seen.length));
}
script = [{ type: 'ok' }, { type: 'ok', text: '补上的回答' }];
seen = [];
{
  const { res } = await run(mkClient());
  check('空响应后重试成功', res.content === '补上的回答', JSON.stringify(res.content));
}

// 5) 429 限流:尊重网关给的 retryAfterSeconds / Retry-After
script = [
  { type: 'status', code: 429, body: JSON.stringify({ code: 'RATE_LIMITED', message: '请求过于频繁', data: { retryAfterSeconds: 1 } }) },
  { type: 'ok', text: '限流后成功' }
];
seen = [];
{
  const { res, retries } = await run(mkClient());
  check('429 会重试并成功', res.content === '限流后成功', JSON.stringify(res.content));
  check('等待时长遵循 retryAfterSeconds(≈1000ms,含 ±10% 抖动)', retries[0].delayMs >= 900 && retries[0].delayMs <= 1200, String(retries[0].delayMs));
}
script = [{ type: 'status', code: 429, body: '{}', headers: { 'Retry-After': '1' } }, { type: 'ok', text: 'ok' }];
{
  const { retries } = await run(mkClient());
  check('也遵循 Retry-After 响应头', retries[0].delayMs >= 900, String(retries[0].delayMs));
}

// 6) 402 余额不足:配置类错误不空等,立即失败并给可操作提示
script = [{ type: 'status', code: 402, body: JSON.stringify({ code: 'INSUFFICIENT_BALANCE', message: '余额不足', data: { retryAfterSeconds: 47 } }) }];
seen = [];
{
  let err = null;
  const p = run(mkClient());
  await p.catch((e) => { err = e; });
  check('402 只发 1 次请求(不白等)', seen.length === 1, String(seen.length));
  check('402 不派发重试事件', p.retries.length === 0, JSON.stringify(p.retries));
  check('402 错误标记为不可重试', err instanceof LlmRequestError && err.retryable === false && isRetryableLlmError(err) === false);
  check('402 给出充值提示', /余额不足/.test(String(err?.message)) && /充值/.test(String(err?.message)), String(err?.message));
}

// 7) 401/400 同样不空等,但会带上可操作指引
script = [{ type: 'status', code: 401, body: '{"error":"invalid api key"}' }];
seen = [];
{
  let err = null;
  await run(mkClient()).catch((e) => { err = e; });
  check('401 只发 1 次请求且提示检查 API Key', seen.length === 1 && /API Key/.test(String(err?.message)), String(err?.message));
}

// 8) 预算/次数耗尽:重试到 MAX_ATTEMPTS 次才放弃,且文案说明「已重试 N 次」
script = Array.from({ length: 12 }, () => ({ type: 'status', code: 503, body: 'upstream unavailable' }));
seen = [];
{
  let err = null;
  const p = run(mkClient());
  await p.catch((e) => { err = e; });
  check('持续 503 时重试到上限次数', seen.length === LLM_RETRY.MAX_ATTEMPTS, String(seen.length));
  check('重试次数 = 上限-1', p.retries.length === LLM_RETRY.MAX_ATTEMPTS - 1, String(p.retries.length));
  check('最终文案说明已重试的次数', /已自动重试 9 次/.test(String(err?.message)), String(err?.message));
  check('最终错误标记为不可重试(避免上层再叠一层)', isRetryableLlmError(err) === false);
}

// 9) 等待重试期间用户停止:立即结束,不再发请求
script = [{ type: 'status', code: 503, body: 'down' }, { type: 'ok', text: '不该到达' }];
seen = [];
{
  const ac = new AbortController();
  const p = run(mkClient(), { signal: ac.signal, onRetry: () => { setTimeout(() => ac.abort(), 1); } })
    .catch((e) => ({ err: e, retries: [], res: null, texts: [] }));
  const { err, res } = await p;
  check('停止后立即抛错(不继续等)', !!err && /已停止/.test(String(err.message)), String(err?.message));
  check('停止后没再发请求', seen.length === 1, String(seen.length));
  check('停止不会产出正常结果', !res);
}

// 10) 用户中止 + 流中断不应被当成「已吐内容需重试」的失败无限循环
script = [{ type: 'hang' }];
seen = [];
{
  const ac = new AbortController();
  const p = mkClient().chat({ messages: [{ role: 'user', content: 'hi' }], signal: ac.signal }).catch((e) => e);
  setTimeout(() => ac.abort(), 30);
  const e = await p;
  check('挂起的请求被停止后立刻返回', /已停止/.test(String(e?.message)), String(e?.message));
}

// 11) 网关假死(接了连接却一个字节都不发):静默看门狗把「永远卡在生成中」变成可重试的中断
script = [{ type: 'silent' }, { type: 'ok', text: '看门狗恢复' }];
seen = [];
{
  const { res, retries } = await run(mkClient());
  check('静默超时后自动重试并成功', res.content === '看门狗恢复' && seen.length === 2, String(seen.length));
  check('看门狗错误说明「没有收到任何数据」', /没有收到任何数据/.test(String(retries[0]?.error || '')), String(retries[0]?.error));
}

console.warn = realWarn;
check('重试过程有可诊断日志', warns.some((w) => /\[llm\]/.test(w)));

server.close();
console.log(`\n== 结果:${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
