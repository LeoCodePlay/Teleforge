// 摘要请求参数契约测试(server/agent/compact.ts + llm.ts 的 ChatOptions.maxTokens):
//
// 起因:COMPACT.SUMMARY_MAX_TOKENS(=8192)此前是死代码——常量声明了但没有任何调用方
// 使用,摘要请求因此一直用模型配置的 maxTokens(可能远大于 8k),摘要自己就更容易超窗。
// harness 的摘要调用是显式带 maxTokens 的(compaction-basic 的 summarizer.ts),
// 这里补齐并锁死该契约。
//
// 说明:**独立**验证的是 summarizeWithLlm → LlmClient.chat 的参数(SSH 侧契约);
// "该值最终写进请求体 max_tokens"由 llm.ts 的正文逻辑保证(见 chat() 内 body.max_tokens)。
// 本机 sandbox 会拦截回环 HTTP(fetch 到 127.0.0.1 得 UND_ERR_SOCKET),
// 所以这里不依赖真实 socket,只验证契约本身——需要链路级验证时在可联网环境跑 e2e。
// 运行:node test/compact-summary-request.test.js
import assert from 'node:assert';

const { summarizeWithLlm, COMPACT } = await import('../server/agent/compact.ts');

// ---- 1. 常量本身:8192,与 harness compaction maxTokens 默认值一致 ----
assert.equal(COMPACT.SUMMARY_MAX_TOKENS, 8192, 'SUMMARY_MAX_TOKENS 应为 8192');

// ---- 2. summarizeWithLlm 必须把 SUMMARY_MAX_TOKENS 传进 chat() ----
function fakeClient() {
  const calls = [];
  return {
    calls,
    isMock: false,
    async chat(opts) {
      calls.push(opts);
      return { content: '  【checkpoint】要点  ', toolCalls: [], reasoning: '' };
    }
  };
}

{
  const llm = fakeClient();
  const out = await summarizeWithLlm({
    llm, system: 'SYS-PREFIX',
    dropMsgs: [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }]
  });
  assert.equal(llm.calls.length, 1, '应只发一次摘要请求');
  const c = llm.calls[0];
  assert.equal(c.maxTokens, COMPACT.SUMMARY_MAX_TOKENS, '摘要请求必须显式带 SUMMARY_MAX_TOKENS');
  assert.deepEqual(c.tools, [], '摘要请求不带工具(模型被明确要求不得调用工具)');
  assert.equal(c.messages[0].role, 'system', '首条为 system:沿用原始前缀以便复用提供方前缀缓存');
  assert.equal(c.messages[0].content, 'SYS-PREFIX');
  assert.equal(c.messages.at(-1).role, 'user', '末条为摘要指令');
  assert.match(c.messages.at(-1).content, /## 主要请求与意图/, '末条应含结构化 checkpoint 模板');
  assert.match(c.messages.at(-1).content, /不要调用任何工具/, '必须明确禁止调用工具');
  assert.equal(out, '【checkpoint】要点', '返回值应去除首尾空白');
}

// ---- 3. 调用方可覆盖(留给将来按模型调整的余地) ----
{
  const llm = fakeClient();
  await summarizeWithLlm({ llm, system: 'S', dropMsgs: [{ role: 'user', content: 'x' }], maxTokens: 2048 });
  assert.equal(llm.calls[0].maxTokens, 2048, '显式传入的 maxTokens 应生效');
}

// ---- 4. 无 system 时不塞空 system 消息 ----
{
  const llm = fakeClient();
  await summarizeWithLlm({ llm, dropMsgs: [{ role: 'user', content: 'x' }] });
  assert.equal(llm.calls[0].messages[0].role, 'user', '未提供 system 时不应插入空 system 消息');
}

// ---- 5. 摘要解析失败(空输出)不应抛错,交由上层 shrink 校验决定降级 ----
{
  const llm = { isMock: false, async chat() { return { content: '', toolCalls: [], reasoning: '' }; } };
  const out = await summarizeWithLlm({ llm, system: 'S', dropMsgs: [{ role: 'user', content: 'x' }] });
  assert.equal(out, '', '空摘要应原样返回空串(由 compactHistory 的 shrink 校验降级处理)');
}

// ---- 6. compactHistory 自动路径确实用同一个常量(禁止调用点各自硬编码) ----
{
  const llm = fakeClient();
  const { compactHistory } = await import('../server/agent/compact.ts');
  // 造一段必然超过 80% 水位的历史(窗口取小值,便于触发)
  const big = '请分析这个模块的实现细节并给出改造方案。'.repeat(400);
  const messages = [
    { role: 'user', content: `问题1:${big}` },
    { role: 'assistant', content: `回答1:${big}` },
    { role: 'user', content: `问题2:${big}` },
    { role: 'assistant', content: `回答2:${big}` },
    { role: 'user', content: `问题3:${big}` },
    { role: 'assistant', content: `回答3:${big}` }
  ];
  const r = await compactHistory({
    messages, system: 'SYS', llm, contextWindow: 20000, maxTokens: 4096, signal: new AbortController().signal
  });
  assert.equal(r.compacted, true, '超水位应触发压缩');
  assert.ok(llm.calls.length >= 1, '应调用一次摘要请求');
  assert.equal(llm.calls[0].maxTokens, COMPACT.SUMMARY_MAX_TOKENS, '自动压缩的摘要请求同样带 SUMMARY_MAX_TOKENS');
}

console.log('compact-summary-request.test.js 全部通过');
process.exit(0);
