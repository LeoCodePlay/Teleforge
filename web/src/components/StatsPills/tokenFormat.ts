// 统计栏的数值格式化(算法逐条移植 deepseek-harness 的
// packages/client/ui-chat/src/client/chat/token-format.ts 与 message-chrome.ts)。
//
// 为什么逐条照搬而不是"自己写个差不多的":这几条规则都是被真实显示问题打磨出来的
// (最典型的是缓存命中率绝不能被四舍五入成 100%),重写一遍就会把这些结论丢掉。

/**
 * 紧凑 token 数:517 / 12.2K / 517K / 1.2M
 * 阈值按**原始值**判断,缩放后 ≥100 取整、否则保留一位小数。
 */
export function formatTokens(value: number): string {
  const scaled = (candidate: number): string =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
  if (!Number.isFinite(value) || value < 1_000) return String(Math.max(0, Math.round(value || 0)));
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`;
  return `${scaled(value / 1_000_000)}M`;
}

/** 精确 token 数:三位一组加千分位,不四舍五入 */
export function formatExactTokens(value: number): string {
  const digits = String(Math.max(0, Math.round(value || 0)));
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  }
  return groups.join(',');
}

/**
 * 解码吞吐:≥10 取整,<10 保留一位小数。
 * @param tps 每秒 token 数
 */
export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, Number.isFinite(tps) ? tps : 0);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

/** 时长:不足一分钟 `45.2s`,超过 `2m42s` */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Number.isFinite(ms) ? ms : 0) / 1_000;
  if (s < 60) return `${Math.round(s * 10) / 10}s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

/**
 * 把缓存读取比例四舍五入到指定的"百分比单位"数(0 位小数 = 1 单位/%,1 位 = 10 单位/%)。
 * **纯整数二分搜索**:正数平局向上,且全程不使用浮点。
 *
 * 为什么不能用 `Math.round(ratio * 1000)` 这类浮点写法:比较与排名会受浮点误差影响
 * (例如 toFixed/乘法结果可能是 5.000000000000001),而这里要做的是"精确判定是否已达到 100%"。
 */
function roundedPercentUnits(cacheReadTokens: number, denominator: number, decimalPlaces: 0 | 1): number {
  const unitsPerPercent = decimalPlaces === 0 ? 1 : 10;
  const scale = unitsPerPercent * 100;
  const doubledScale = scale * 2;
  const denominatorQuotient = Math.floor(denominator / doubledScale);
  const denominatorRemainder = denominator % doubledScale;
  let lower = 0;
  let upper = scale;
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2);
    const factor = candidate * 2 - 1;
    const threshold = factor * denominatorQuotient
      + Math.ceil(factor * denominatorRemainder / doubledScale);
    if (cacheReadTokens >= threshold) lower = candidate;
    else upper = candidate - 1;
  }
  return lower;
}

function displayPercentUnits(units: number, decimalPlaces: 0 | 1): string {
  if (decimalPlaces === 0) return String(units);
  const whole = Math.floor(units / 10);
  const tenths = units % 10;
  return tenths === 0 ? String(whole) : `${whole}.${tenths}`;
}

/**
 * 缓存命中率的显示文本 —— **绝不把部分命中四舍五入成 100%**。
 *
 * 规则(对齐 dsh):
 *  - 分母为 0 → null(UI 不显示这一项,而不是显示 0%);
 *  - 未命中为 0 → 精确的 `'100'`(这是唯一产出 100 的路径);
 *  - 否则按 decimalPlaces 位四舍五入;结果仍 <100 就直接用;
 *  - 一旦会舍入成 100,就**逐位提升精度**,直到出现一个"严格小于 100"的表示,
 *    最终形如 `99.9…`(位数由误差本身决定)。
 *
 * 为什么要这么麻烦:98.6% 显示成 100% 会让用户以为"缓存完全没丢",从而漏掉真实的性能问题。
 *
 * ⚠ 防御(原实现没有,是本次移植补上的):若 `cacheReadTokens > promptTokens`
 * (第三方网关完全可能报这种脏数据),则"未命中数"为负,精度提升的 while 循环**永不终止**。
 * 因此入口先夹住:缓存读不得超过分母,分母非正直接返回 null。
 *
 * @param cacheReadTokens 命中缓存读取的 token
 * @param promptTokens 计费输入(三个输入桶之和)
 * @param decimalPlaces 普通比例的精度
 * @returns 百分比文本,或 null(没有输入可计)
 */
export function formatCacheHitPercent(
  cacheReadTokens: number,
  promptTokens: number,
  decimalPlaces: 0 | 1 = 0
): string | null {
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return null;
  // 夹住:负数未命中会让下面的精度提升循环死循环(见函数注释的防御说明)
  const read = Math.min(Math.max(0, Number.isFinite(cacheReadTokens) ? cacheReadTokens : 0), promptTokens);
  const missedInputTokens = promptTokens - read;
  if (missedInputTokens === 0) return '100';

  const roundedUnits = roundedPercentUnits(read, promptTokens, decimalPlaces);
  const fullHitUnits = decimalPlaces === 0 ? 100 : 1_000;
  if (roundedUnits < fullHitUnits) return displayPercentUnits(roundedUnits, decimalPlaces);

  let distinguishingPlaces = 1;
  let scaledDoubleGap = missedInputTokens * 200;
  const denominatorTens = Math.floor(promptTokens / 10);
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10;
    distinguishingPlaces += 1;
  }
  const denominatorOnes = promptTokens % 10;
  let roundedLoss = 5;
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1;
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10);
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss;
      break;
    }
  }
  return `99.${'9'.repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`;
}
