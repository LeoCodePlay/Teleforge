// 自动化任务的前端类型:与 dsh(`packages/schedule/schedule/src/types.ts`)以及本项目的
// RPC 面(server/api/rpc/schedule.ts / schedule-preview.ts)一一对应。
//
// 前端**不重写**任何时间逻辑:下次运行、规则预览都问服务端(用同一份 domain.ts 算),
// 这里只放格式化(频率文案/绝对时间/相对时间)与请求载荷的组装。
export type ScheduleKind = 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron';

interface RecordBase {
  id: string;
  title: string;
  prompt: string;
  /** 已提交的下一次触发瞬间(RFC3339 UTC) */
  scheduledAt: string;
}

export type ScheduleRecord = RecordBase & (
  | { kind: 'after'; afterSeconds: number }
  | { kind: 'at' }
  | { kind: 'every'; everySeconds: number }
  | { kind: 'daily'; time: string; timeZone: string }
  | { kind: 'weekly'; time: string; timeZone: string; weekdays: number[] }
  | { kind: 'cron'; expression: string; timeZone: string }
);

export interface DeliveryReceipt {
  scheduledAt: string;
  deliveredAt: string;
  messageId: string;
}

export interface DeliveryRecord extends DeliveryReceipt {
  prompt?: string;
}

/** 目录条目:含已结束(status='inactive')的任务 */
export type ScheduleCatalogEntry = ScheduleRecord & {
  sessionId: string;
  status: 'active' | 'inactive';
  lastDelivery?: DeliveryReceipt;
};

export interface RetentionBounds { days: number; records: number }

export type ScheduleHistoryResult =
  | { id: string; code: 'delivery_cursor_not_found' | 'schedule_not_found' }
  | {
    id: string;
    records: DeliveryRecord[];
    earlierRecordsUnavailable: boolean;
    earlierRecordsPruned: boolean;
    retention: RetentionBounds;
    nextBefore?: string;
  };

export type ScheduleUpdateResult =
  | { id: string; updated: true; record: ScheduleRecord }
  | { id: string; updated: false; code: 'schedule_not_found' | 'schedule_ended' | 'schedule_conflict' };

export type ScheduleDeleteResult =
  | { id: string; deleted: true }
  | { id: string; deleted: false; code: 'schedule_not_found' };

/** 预览入参 = dsh 的创建选择器(一次只给一个);与真实创建逐字同一口径 */
export interface ScheduleRule {
  after_seconds?: number;
  at?: string | { date: string; time: string; time_zone: string };
  every_seconds?: number;
  daily?: { time: string; time_zone: string };
  weekly?: { time: string; time_zone: string; weekdays: number[] };
  cron?: { expression: string; time_zone: string };
}

/** 改时间用的选择器(dsh 的 ScheduleTimingChange:换规则种类也允许;**没有** after) */
export type TimingChange =
  | { kind: 'at'; at: ScheduleRule['at'] }
  | { kind: 'every'; every_seconds: number }
  | { kind: 'daily'; daily: { time: string; time_zone: string } }
  | { kind: 'weekly'; weekly: { time: string; time_zone: string; weekdays: number[] } }
  | { kind: 'cron'; cron: { expression: string; time_zone: string } };

export interface SchedulePreview {
  kind: ScheduleKind;
  scheduledAt: string;
  next: string[];
}

/** 从目录条目里剥出**纯粹的记录**:schedule_update 的 expected 必须逐字段等于存储的那条 */
export function recordOf(entry: ScheduleCatalogEntry): ScheduleRecord {
  if (entry.kind === 'after') return { id: entry.id, kind: 'after', title: entry.title, prompt: entry.prompt, afterSeconds: entry.afterSeconds, scheduledAt: entry.scheduledAt };
  if (entry.kind === 'at') return { id: entry.id, kind: 'at', title: entry.title, prompt: entry.prompt, scheduledAt: entry.scheduledAt };
  if (entry.kind === 'every') return { id: entry.id, kind: 'every', title: entry.title, prompt: entry.prompt, everySeconds: entry.everySeconds, scheduledAt: entry.scheduledAt };
  if (entry.kind === 'daily') return { id: entry.id, kind: 'daily', title: entry.title, prompt: entry.prompt, time: entry.time, timeZone: entry.timeZone, scheduledAt: entry.scheduledAt };
  if (entry.kind === 'weekly') return { id: entry.id, kind: 'weekly', title: entry.title, prompt: entry.prompt, time: entry.time, timeZone: entry.timeZone, weekdays: [...entry.weekdays], scheduledAt: entry.scheduledAt };
  return { id: entry.id, kind: 'cron', title: entry.title, prompt: entry.prompt, expression: entry.expression, timeZone: entry.timeZone, scheduledAt: entry.scheduledAt };
}

/** 已到提交点(与 dsh `scheduleView` 同判据):UI 不依赖服务端返回 state,自己按同一个式子算 */
export function isOverdue(entry: { scheduledAt: string }, now = Date.now()): boolean {
  return Date.parse(entry.scheduledAt) <= now;
}

const WEEKDAY_ZH = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `HH:mm:ss.SSS` → `HH:mm`(秒与小数秒为 0 时按 dsh 的 clockLabel 隐掉) */
export function clockLabel(time: string): string {
  const [h = '00', m = '00', s = '00.000'] = String(time).split(':');
  const seconds = Number(s);
  return seconds === 0 ? `${h}:${m}` : `${h}:${m}:${pad(Math.floor(seconds))}`;
}

/** 频率文案(dsh frequency-locales 的中文模板) */
export function frequencyText(record: ScheduleRecord, systemZone: string): string {
  switch (record.kind) {
    case 'after': return '单次';
    case 'at': return '单次';
    case 'every': {
      const s = record.everySeconds;
      if (s % 3600 === 0) return `每 ${s / 3600} 小时`;
      if (s % 60 === 0) return `每 ${s / 60} 分钟`;
      return `每 ${s} 秒`;
    }
    case 'daily': return record.timeZone === systemZone
      ? `每天 ${clockLabel(record.time)}`
      : `每天 ${clockLabel(record.time)}(${record.timeZone})`;
    case 'weekly': {
      const days = record.weekdays.map((d) => WEEKDAY_ZH[d] || `周${d}`).join('、');
      return record.timeZone === systemZone
        ? `每周${days} ${clockLabel(record.time)}`
        : `每周${days} ${clockLabel(record.time)}(${record.timeZone})`;
    }
    case 'cron': return record.timeZone === systemZone
      ? `Cron ${record.expression}`
      : `Cron ${record.expression}(${record.timeZone})`;
    default: return '';
  }
}

/** 绝对时间(dsh `formatScheduleAbsolute`:中文不显示年份,永远按设备时区) */
export function absoluteTime(value: string | number): string {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const now = new Date();
  const year = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${year}${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 相对时间(dsh `formatScheduleRelative`):「3分钟后」/「现在到期」/「已逾期 3分钟」 */
export function relativeTime(value: string | number, now = Date.now()): string {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  const diff = ms - now;
  if (diff === 0) return '现在到期';
  const abs = Math.abs(diff) / 1000;
  const unit = abs >= 86_400 ? ['天', 86_400] : abs >= 3_600 ? ['小时', 3_600] : abs >= 60 ? ['分钟', 60] : ['秒', 1];
  const [label, secs] = unit as [string, number];
  const value2 = Math.max(1, diff > 0 ? Math.ceil(abs / secs) : Math.floor(abs / secs));
  return diff > 0 ? `${value2}${label}后` : `已逾期 ${value2}${label}`;
}

/** 「下次运行」整行(dsh `nextRunParts`):绝对 + 括号里的相对 */
export function nextRunText(value: string, now = Date.now()): string {
  return `${absoluteTime(value)} (${relativeTime(value, now)})`;
}

/** 本地 `<input type="time">`/`<input type="date">` 需要的值 */
export function localTimeValue(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function localDateValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** 时区下拉可选值:常用三个置顶(Intl 支持就全量) */
export function timeZoneOptions(): string[] {
  const head = [browserTimeZone(), 'UTC', 'Asia/Shanghai'].filter((v, i, a) => a.indexOf(v) === i);
  try {
    const all = (Intl as any).supportedValuesOf?.('timeZone');
    if (Array.isArray(all) && all.length) return [...head, ...all.filter((z: string) => !head.includes(z))];
  } catch { /* 老引擎没有 supportedValuesOf */ }
  return head;
}

/** 错误码 → 中文原因(dsh task-manager-locales 的 timing.* 文案) */
export const ERROR_TEXT: Record<string, string> = {
  conflict: '任务在保存前已发生变化。当前显示已保存的规则,请重试',
  notFound: '此任务当前不可用',
  ended: '已结束的任务为只读,无法修改时间',
  internal: '无法确认规则是否已更新。当前显示已保存的规则',
  invalid_prompt: '内容不能为空',
  invalid_selector: '请只选择一种重复方式',
  invalid_rule: '规则不合法',
  invalid_time_zone: '请输入有效的 IANA 时区,例如 Asia/Shanghai',
  not_future: '请选择未来的日期和时间',
  time_out_of_range: '时间超出可表示范围',
  frequency_too_high: '间隔最短 1 分钟',
  subagent_session: '此会话属于子 agent,永远不会收到投递的提醒',
};

export function errorText(code: string | undefined, fallback: string, message?: string): string {
  if (message && code === 'invalid_rule') return message;
  return (code && ERROR_TEXT[code]) || message || fallback;
}
