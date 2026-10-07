// 对话统计(foldSessionStats)+ 统计栏格式化 的测试
//
// 背景:统计栏要显示「轮/步 · tok/s」与「总 token · 缓存命中率」。两条链都必须可靠:
//   - 服务端 fold 整个会话事件日志(不能只统计当前窗口:窗口分页 + 压缩会改写它);
//   - 前端格式化,其中缓存命中率**绝不能把部分命中四舍五入成 100%**。
// 运行:node test/session-stats.test.js
import assert from 'node:assert';

process.env.DATA_DIR = process.env.DATA_DIR || (await import('node:fs')).mkdtempSync(
  (await import('node:path')).join((await import('node:os')).tmpdir(), 'sshai-stats-')
);

const { foldSessionStats } = await import('../server/agent/session.ts');
const fmt = await import('../web/src/components/StatsPills/tokenFormat.ts');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);

// 事件构造器:t = 事件时刻(ms)
const ev = (t, type, data) => ({ seq: 0, time: t, type, data });
const msg = (t, turn, step, opts = {}) => ev(t, 'assistant/message', {
  turn, step, message: {},
  ...(opts.firstTokenTime !== undefined ? { firstTokenTime: opts.firstTokenTime } : {}),
  ...(opts.usage !== undefined ? { usage: opts.usage } : {})
});

console.log('\n[一] 轮/步计数');
{
  // steps 用 step/end 计数(不是 assistant/message:一步可能不产出消息)
  const s = foldSessionStats([
    ev(0, 'turn/start', { turn: 1 }),
    ev(1, 'step/start', { turn: 1, step: 1 }),
    msg(2, 1, 1),
    ev(3, 'step/end', { turn: 1, step: 1 }),
    ev(4, 'step/start', { turn: 1, step: 2 }),   // 这一步没有 assistant/message
    ev(5, 'step/end', { turn: 1, step: 2 }),     // 但仍应计入 steps
    ev(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ev(7, 'turn/start', { turn: 2 }),
    ev(8, 'step/start', { turn: 2, step: 1 }),
    msg(9, 2, 1),
    ev(10, 'step/end', { turn: 2, step: 1 })
  ]);
  check('steps 计 step/end(含无消息的步)', s.steps === 3, `steps=${s.steps}`);
  check('turns 计轮号变化', s.turns === 2, `turns=${s.turns}`);
}

console.log('\n[二] 模型耗时 llmMs');
{
  const s = foldSessionStats([
    ev(1000, 'step/start', { turn: 1, step: 1 }),
    msg(1300, 1, 1),
    ev(1300, 'step/end', { turn: 1, step: 1 })
  ]);
  check('llmMs = step/start → assistant/message', s.llmMs === 300, `llmMs=${s.llmMs}`);
}
{
  // 被中止的步没有 assistant/message:它的部分时长不该计入
  const s = foldSessionStats([
    ev(1000, 'step/start', { turn: 1, step: 1 }),
    ev(2000, 'step/end', { turn: 1, step: 1 })
  ]);
  check('无消息的步不计 llmMs', s.llmMs === 0, `llmMs=${s.llmMs}`);
}

console.log('\n[三] 工具耗时 toolMs(按 callId 配对)');
{
  const s = foldSessionStats([
    ev(1000, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'x' }),
    ev(1250, 'tool/result', { turn: 1, step: 1, callId: 'c1', name: 'x' }),
    ev(2000, 'tool/call', { turn: 1, step: 1, callId: 'c2', name: 'y' }),
    ev(2100, 'tool/result', { turn: 1, step: 1, callId: 'c2', name: 'y' })
  ]);
  check('toolMs 累加配对耗时', s.toolMs === 350, `toolMs=${s.toolMs}`);
}
{
  // 未配对的结果不计;turn/end 丢弃悬挂调用
  const s = foldSessionStats([
    ev(1000, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'x' }),
    ev(1500, 'tool/result', { turn: 1, step: 1, callId: 'nope', name: 'z' })
  ]);
  check('未配对的 tool/result 不计入', s.toolMs === 0, `toolMs=${s.toolMs}`);
}
{
  // 原型链污染:callId='constructor' 必须被当成"未配对",而不是取到继承的函数(否则 NaN)
  const s = foldSessionStats([
    ev(1000, 'tool/result', { turn: 1, step: 1, callId: 'constructor', name: 'x' }),
    ev(1000, 'tool/result', { turn: 1, step: 1, callId: 'toString', name: 'x' })
  ]);
  check('callId=constructor/toString 不污染 toolMs', s.toolMs === 0 && Number.isFinite(s.toolMs), `toolMs=${s.toolMs}`);
}

console.log('\n[四] TTFT 与解码速度(分子分母必须同源)');
{
  const s = foldSessionStats([
    ev(1000, 'step/start', { turn: 1, step: 1 }),
    msg(2500, 1, 1, { firstTokenTime: 1800, usage: { uncachedInputTokens: 0, outputTokens: 40, cacheReadTokens: 100, cacheWriteTokens: 0 } }),
    ev(2500, 'step/end', { turn: 1, step: 1 })
  ]);
  check('ttftMs = 首token − step/start', s.ttftMs === 800, `ttftMs=${s.ttftMs}`);
  check('ttftSteps = 1', s.ttftSteps === 1);
  check('decodeMs = assistant/message − 首token', s.decodeMs === 700, `decodeMs=${s.decodeMs}`);
  check('decodeTokens = 输出 token', s.decodeTokens === 40, `decodeTokens=${s.decodeTokens}`);
  const tps = s.decodeTokens / (s.decodeMs / 1000);
  check('速度 = 40/0.7 ≈ 57.1 tok/s', Math.abs(tps - 57.142) < 0.01, `tps=${tps}`);
}
{
  // 有首 token 但没报输出 token → 两者都不计入(否则会把等待时间算成解码)
  const s = foldSessionStats([
    ev(1000, 'step/start', { turn: 1, step: 1 }),
    msg(2500, 1, 1, { firstTokenTime: 1800 }),
    ev(2500, 'step/end', { turn: 1, step: 1 })
  ]);
  check('无输出 token 时不计 decode', s.decodeMs === 0 && s.decodeTokens === 0);
  check('但仍计 TTFT', s.ttftMs === 800 && s.ttftSteps === 1);
}
{
  // 旧数据:没有 firstTokenTime → TTFT/解码两项都不产生(UI 就不显示这两行),而不是记 0 样本
  const s = foldSessionStats([
    ev(1000, 'step/start', { turn: 1, step: 1 }),
    msg(2500, 1, 1, { usage: { uncachedInputTokens: 10, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
    ev(2500, 'step/end', { turn: 1, step: 1 })
  ]);
  check('缺 firstTokenTime → 不计 TTFT', s.ttftMs === 0 && s.ttftSteps === 0);
  check('缺 firstTokenTime → 不计解码', s.decodeMs === 0 && s.decodeTokens === 0);
  check('但 llmMs 照常', s.llmMs === 1500);
}
{
  // 每步只结算一次:重复 assistant/message 不重复累加
  const s = foldSessionStats([
    ev(1000, 'step/start', { turn: 1, step: 1 }),
    msg(1500, 1, 1),
    msg(1600, 1, 1),
    ev(1600, 'step/end', { turn: 1, step: 1 })
  ]);
  check('同一步重复消息只结算一次', s.llmMs === 500, `llmMs=${s.llmMs}`);
}
check('空日志全 0', JSON.stringify(foldSessionStats([])) === JSON.stringify({
  turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0
}));

console.log('\n[五] 格式化:token 数');
eq('紧凑 517', fmt.formatTokens(517), '517');
eq('紧凑 12.2K', fmt.formatTokens(12_240), '12.2K');
eq('紧凑 517K', fmt.formatTokens(517_000), '517K');
eq('紧凑 1.2M', fmt.formatTokens(1_230_000), '1.2M');
eq('精确千分位', fmt.formatExactTokens(13_200_000), '13,200,000');
eq('精确 0', fmt.formatExactTokens(0), '0');

console.log('\n[六] 格式化:速度与时长');
eq('速度 34.4 → 34', fmt.formatTokensPerSecond(34.4), '34');
eq('速度 9.96 → 10', fmt.formatTokensPerSecond(9.96), '10');
eq('速度 3.14 → 3.1', fmt.formatTokensPerSecond(3.14), '3.1');
eq('速度负数夹到 0', fmt.formatTokensPerSecond(-1), '0');
eq('时长 45.2s', fmt.formatDuration(45_230), '45.2s');
eq('时长 2m42s', fmt.formatDuration(162_000), '2m42s');

console.log('\n[七] 格式化:缓存命中率(精度表照搬 dsh 的用例)');
{
  // dsh 的原始用例表:[命中, 未命中] -> 期望文本
  const cases = [
    [[986, 14], '99'],        // 98.6%
    [[991, 9], '99'],         // 99.1%
    [[9_949, 51], '99'],      // 99.49%
    [[995, 5], '99.5'],       // 99.5% ← 平局向上,且不能变 100
    [[9_994, 6], '99.9'],     // 99.94%
    [[9_995, 5], '99.95'],    // 99.95%
    [[19_991, 9], '99.96'],   // 99.955%
    [[19_997, 3], '99.99'],   // 99.985%
    [[19_999, 1], '99.995'],  // 99.995%
    [[39_999, 1], '99.998'],  // 99.9975%
    [[10_000, 0], '100']      // 真正全命中
  ];
  for (const [[hit, miss], expected] of cases) {
    const got = fmt.formatCacheHitPercent(hit, hit + miss);
    check(`命中率 ${hit}/${hit + miss} → ${expected}`, got === expected, `实际=${got}`);
  }
  check('分母 0 → null(UI 不显示该项)', fmt.formatCacheHitPercent(0, 0) === null);
  check('一位小数时省略多余的 .0', fmt.formatCacheHitPercent(1, 2, 1) === '50');
}

console.log('\n[八] 防御:脏数据不得死循环也不得报 >100%');
{
  // 原实现遇到 cacheRead > prompt 会因"未命中为负"而 while 死循环;本实现先夹住
  let ok = true, value = null;
  try {
    value = fmt.formatCacheHitPercent(500, 100); // 命中数 > 分母
  } catch { ok = false; }
  check('cacheRead > prompt 不死循环', ok, '抛异常或挂起');
  check('cacheRead > prompt 返回 100(夹住后视为全命中)', value === '100', `实际=${value}`);
  check('负命中数不死循环', fmt.formatCacheHitPercent(-5, 100) === '0', `实际=${fmt.formatCacheHitPercent(-5, 100)}`);
  check('分母负数 → null', fmt.formatCacheHitPercent(10, -1) === null);
  check('NaN 输入不崩', fmt.formatCacheHitPercent(Number.NaN, Number.NaN) === null);
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
