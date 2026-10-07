// 时长 / token 的展示格式化 —— 逐函数照搬 deepseek-harness
// packages/client/ui-subagent/src/client/SubagentHeaderLineage.tsx 里的那几个纯函数
// (formatTokens / splitDuration / formatDuration / formatExactDuration / tokenTotal)。
//
// 抽出来单独放:这五个都是纯函数(输入数字,输出字符串),与 React 无关,便于直接对照上游阅读。

import type { SubagentKey } from './locales';

/** dsh 的 t 只需 key 与可选 params。 */
type T = (key: SubagentKey, params?: Record<string, string | number>) => string;

/** Compact token count shared in shape with the conversation stats strip. */
export function formatTokens(value: number, t: T): string {
  const scaled = (next: number): string => next >= 100
    ? String(Math.round(next))
    : String(Math.round(next * 10) / 10);
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return t('tokens.thousand', { value: scaled(value / 1_000) });
  return t('tokens.million', { value: scaled(value / 1_000_000) });
}

interface DurationParts {
  seconds: number;
  minutes: number;
  hours: number;
  days: number;
  totalMinutes: number;
  totalHours: number;
}

function splitDuration(ms: number): DurationParts {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1_000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);
  return {
    seconds: totalSeconds % 60,
    minutes: totalMinutes % 60,
    hours: totalHours % 24,
    days: Math.floor(totalHours / 24),
    totalMinutes,
    totalHours,
  };
}

/** Format a duration with decreasing visual precision at larger scales. */
export function formatDuration(ms: number, t: T): string {
  const { seconds, minutes, hours, days, totalMinutes, totalHours } = splitDuration(ms);
  if (days >= 365) {
    const years = Math.floor(days / 365);
    const months = Math.floor((days % 365) / 30);
    return months === 0
      ? t('duration.years', { years })
      : t('duration.yearsMonths', { years, months });
  }
  if (days >= 30) {
    const months = Math.floor(days / 30);
    const remainingDays = days % 30;
    return remainingDays === 0
      ? t('duration.months', { months })
      : t('duration.monthsDays', { months, days: remainingDays });
  }
  if (days > 0) {
    return hours === 0
      ? t('duration.days', { days })
      : t('duration.daysHours', { days, hours });
  }
  if (totalHours > 0) {
    return t('duration.hours', {
      hours: totalHours,
      minutes: String(minutes).padStart(2, '0'),
      seconds: String(seconds).padStart(2, '0'),
    });
  }
  if (totalMinutes > 0) {
    return t('duration.minutes', {
      minutes: totalMinutes,
      seconds: String(seconds).padStart(2, '0'),
    });
  }
  return t('duration.seconds', { seconds });
}

/** Preserve exact whole seconds for hover and accessible naming. */
export function formatExactDuration(ms: number, t: T): string {
  const { seconds, minutes, hours, days } = splitDuration(ms);
  return days === 0
    ? formatDuration(ms, t)
    : t('duration.exactDays', {
      days,
      hours: String(hours).padStart(2, '0'),
      minutes: String(minutes).padStart(2, '0'),
      seconds: String(seconds).padStart(2, '0'),
    });
}
