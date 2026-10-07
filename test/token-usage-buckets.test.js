// 用量四桶(含缓存字段)归一 + 会话累计 fold 的测试
//
// 背景:此前只解析 prompt_tokens / completion_tokens,提供方报的缓存命中字段被整个丢掉,
// 于是"缓存命中率"根本算不出来(审计差距 #3)。
//
// 本测试锁死三件事:
//   1. 方言归一:OpenAI 兼容 与 Anthropic Messages 两种字段名都映射到同一组四桶;
//   2. 兜底规则:脏数据不得产出负数或 >100% 的假命中;
//   3. fold 语义:同一步的重复样本**替换**(不重复计费),重试**累加**(各计一次),
//      没有用量的步不参与(不被当成 0 命中样本)。
// 运行:node test/token-usage-buckets.test.js
import assert from 'node:assert';

const { normalizeTokenUsage, billedInputTokens } = await import('../server/agent/llm.ts');
const { foldTokenUsage } = await import('../server/agent/session.ts');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);

// ============ 一、方言归一 ============
console.log('\n[一] 方言归一');

// OpenAI 兼容:prompt_tokens_details.cached_tokens
eq('OpenAI 兼容:cached_tokens 归一',
  normalizeTokenUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 900 } }),
  { uncachedInputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 50 });

// DeepSeek 原生方言:prompt_cache_hit_tokens(没有 details 时用)
eq('DeepSeek:prompt_cache_hit_tokens 归一',
  normalizeTokenUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 800 }),
  { uncachedInputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 50 });

// ⚠ 优先级:显式的 cached_tokens: 0 必须**胜过** prompt_cache_hit_tokens(用 ?? 不用 ||)
eq('显式 cached_tokens:0 胜过 prompt_cache_hit_tokens',
  normalizeTokenUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 90, prompt_tokens_details: { cached_tokens: 0 } }),
  { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 });

// OpenRouter 兼容:cache_write_tokens
eq('OpenRouter:cache_write_tokens 参与减法',
  normalizeTokenUsage({ prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 } }),
  { uncachedInputTokens: 500, cacheReadTokens: 400, cacheWriteTokens: 100, outputTokens: 5 });

// Anthropic:input_tokens 本身就是未命中输入,不做减法
eq('Anthropic:cache_read/creation 归一',
  normalizeTokenUsage({ input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 700, cache_creation_input_tokens: 50 }),
  { uncachedInputTokens: 300, cacheReadTokens: 700, cacheWriteTokens: 50, outputTokens: 40 });

// 无任何缓存字段 → 全部算未命中(而不是留空/NaN)
eq('无缓存字段:全部计入未命中',
  normalizeTokenUsage({ prompt_tokens: 500, completion_tokens: 20 }),
  { uncachedInputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 });

// 没有用量 → null(不是零值对象)
check('空对象 → null', normalizeTokenUsage({}) === null);
check('null → null', normalizeTokenUsage(null) === null);
check('只有 output 没有 prompt → null', normalizeTokenUsage({ completion_tokens: 9 }) === null);

// ============ 二、兜底规则 ============
console.log('\n[二] 兜底规则');

// 单个缓存字段非法 → 忽略该字段,不丢弃整条用量
eq('cached_tokens 非整数 → 忽略该字段(不丢整条)',
  normalizeTokenUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: -3 } }),
  { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 });

eq('cached_tokens 是字符串 → 忽略该字段',
  normalizeTokenUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: '80' } }),
  { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 });

// 缓存量 > prompt → 脏数据:丢掉缓存分项,退化为全未命中(不报 >100% 假命中)
eq('cacheRead > prompt → 丢弃缓存分项',
  normalizeTokenUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 500 }),
  { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 });

eq('cacheRead+cacheWrite > prompt → 丢弃缓存分项',
  normalizeTokenUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 90, cache_write_tokens: 90 } }),
  { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 });

// 减法结果永不为负
{
  const u = normalizeTokenUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 100 } });
  check('恰好全命中:未命中为 0 而非负数', u.uncachedInputTokens === 0 && u.cacheReadTokens === 100, JSON.stringify(u));
}

// completion_tokens 缺失 → 输出按 0,其余仍可用
eq('completion_tokens 缺失 → 输出 0',
  normalizeTokenUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 60 } }),
  { uncachedInputTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 0, outputTokens: 0 });

// ============ 三、计费输入 ============
console.log('\n[三] 计费输入 = 三输入桶之和');
check('billedInputTokens 三桶相加',
  billedInputTokens({ uncachedInputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 5, outputTokens: 999 }) === 105);

// ============ 四、fold 语义 ============
console.log('\n[四] fold 语义');

const msg = (turn, step, usage) => ({ seq: 0, time: 0, type: 'assistant/message', data: { turn, step, message: {}, usage } });

// 4.1 普通的跨步累加
{
  const t = foldTokenUsage([
    msg(1, 1, { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 }),
    msg(1, 2, { uncachedInputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 0, outputTokens: 5 })
  ]);
  eq('跨步累加', t, { uncachedInputTokens: 110, outputTokens: 15, cacheReadTokens: 90, cacheWriteTokens: 0, samples: 2 });
}

// 4.2 同一步的重复样本 → 替换(不重复计费)
{
  const t = foldTokenUsage([
    msg(1, 1, { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }), // 流式中间样本
    msg(1, 1, { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 42 }) // 最终样本
  ]);
  eq('同一步重复样本替换而非累加', t, { uncachedInputTokens: 100, outputTokens: 42, cacheReadTokens: 0, cacheWriteTokens: 0, samples: 1 });
}

// 4.3 重试:同一步的多次"尝试"各计一次(上一条被压平,净效果为累加)
{
  const t = foldTokenUsage([
    msg(1, 1, { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }),
    msg(1, 1, { uncachedInputTokens: 214, cacheReadTokens: 11, cacheWriteTokens: 1, outputTokens: 1 })
  ]);
  check('重试后计费为新尝试的值(替换语义,不叠加双份)',
    t.uncachedInputTokens === 214 && t.cacheReadTokens === 11 && t.cacheWriteTokens === 1 && t.samples === 1,
    JSON.stringify(t));
}

// 4.4 没有 usages 的步不参与(不污染命中率样本)
{
  const t = foldTokenUsage([
    { seq: 0, time: 0, type: 'assistant/message', data: { turn: 1, step: 1, message: {} } }, // 无 usage
    msg(1, 2, { uncachedInputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 0, outputTokens: 5 })
  ]);
  check('无 usage 的步不进样本', t.samples === 1 && t.uncachedInputTokens === 10, JSON.stringify(t));
  check('空日志 → 全 0', foldTokenUsage([]).samples === 0);
}

// 4.5 脏数据夹住:负数桶不得让总量为负
{
  const t = foldTokenUsage([msg(1, 1, { uncachedInputTokens: -50, cacheReadTokens: -3, cacheWriteTokens: 0, outputTokens: -1 })]);
  check('负数桶被夹到 0', t.uncachedInputTokens === 0 && t.cacheReadTokens === 0 && t.outputTokens === 0, JSON.stringify(t));
}

// 4.6 会话级命中率(用 fold 结果算)—— 与 dsh 的口径一致:分母=计费输入
{
  const t = foldTokenUsage([
    msg(1, 1, { uncachedInputTokens: 14_848, cacheReadTokens: 15_000, cacheWriteTokens: 0, outputTokens: 300 })
  ]);
  const billed = billedInputTokens(t);
  const pct = t.cacheReadTokens / billed * 100;
  check('命中率分母 = 计费输入(不含输出)',
    billed === 29_848 && Math.abs(pct - 50.25) < 0.01, `billed=${billed} pct=${pct}`);
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
