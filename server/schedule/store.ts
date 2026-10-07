/**
 * 任务存储:整份 JSON 文档的直接读写。
 *
 * dsh 用 storage-domain 的 KV 抽象(JSON 后端把它落成**单个** `schedule.json` 文档),本项目没有那套装配,
 * 于是这里**照抄同一份落盘形状**并保留它的持久层不变量 —— 文件内容与 dsh 可以逐字段对照:
 *
 *   { "unit": { "name": "schedule", "version": 1 }, "global": null, "tables": { "tasks": { "<id>": task } } }
 *
 * 三条不变量(违反即拒绝打开,不静默放过 —— 与 dsh "坏记录拒绝打开 domain" 同一取向):
 *   1. `unit.name` 必须是 `schedule`、`unit.version` 必须是 1;
 *   2. 表键必须等于 `record.id`;
 *   3. 每一行都要过 `dsh/storage.ts` 的 zod schema(多余键拒绝、messageId 唯一、
 *      `lastDelivery` 必须等于投递历史最后一条)。
 *
 * 写入用项目的原子写(临时文件 + rename;见 store/atomic-write.ts),格式与 dsh 的 JSON 序列化一致:
 * 2 空格缩进 + 末尾换行。`put`/`delete` 立即落盘;`entries()`/`tasks()`/`get()` 读内存态。
 */
import fs from 'node:fs';
import path from 'node:path';
import { SCHEDULES_FILE } from '../config.ts';
import { writeFileAtomic } from '../store/atomic-write.ts';
import { parseScheduleTask, type ScheduleTask } from './dsh/storage.ts';
import { MIN_EVERY_INTERVAL_SECONDS, ScheduleLogError, canonicalizeCronExpression, canonicalizeTimeZone } from './dsh/domain.ts';

const UNIT_NAME = 'schedule';
const UNIT_VERSION = 1;

export interface ScheduleTable {
  get(id: string): ScheduleTask | undefined;
  put(id: string, task: ScheduleTask): Promise<void>;
  delete(id: string): Promise<void>;
  entries(): [string, ScheduleTask][];
}

export interface ScheduleStore {
  readonly file: string;
  readonly table: ScheduleTable;
  /** runtime 要**同步**取任务表(见 dsh runtime.ts 的 `tasks()` 依赖) */
  tasks(): ScheduleTask[];
  close(): Promise<void>;
}

interface Document {
  unit: { name: string; version: number };
  global: null;
  tables: { tasks: Record<string, unknown> };
}

function emptyDocument(): Document {
  return { unit: { name: UNIT_NAME, version: UNIT_VERSION }, global: null, tables: { tasks: {} } };
}

/* ---------------- 上一版(自写实现)形状的一次性迁移 ---------------- */

/**
 * 上一版的落盘形状是 `{ version, tasks: [...], records: [...] }`(任务里带 `enabled/completed/createdAt/
 * scopeKey/anchorAt`,运行记录是 `success|failure|skipped|missed` 四态)。dsh 的形状完全不同
 * (`unit/global/tables.tasks`,任务只有 `status: active|inactive` + 投递回执),所以这里做**一次性搬运**:
 *
 *   - 保留 id / title / prompt / scheduledAt 与规则字段(`HH:mm` → `HH:mm:ss.000`、cron 规范化);
 *   - `enabled === false` 或 `completed === true` → `status: 'inactive'`,其余 `'active'`;
 *   - 旧运行记录里**只搬 `result === 'success'` 的**那些(与 dsh"只记成功投递"一致),
 *     映射成投递回执:`scheduledAt = startedAt`、`deliveredAt = endedAt`、`messageId = legacy_<记录id>`;
 *   - 旧形状独有的 `scopeKey` / `createdAt` / `anchorAt` / 非成功记录**丢弃**(dsh 模型里没有这些)。
 *
 * 单条不合规(时区非法、时间格式怪)只丢那一条并记 warn,不让整份文件打不开 —— 用户的任务比"形状洁癖"重要。
 */
function migrateLegacyDocument(value: any): Document | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Array.isArray(value.tasks)) return null;
  const runs: any[] = Array.isArray(value.records) ? value.records : [];
  const tasks: Record<string, unknown> = {};
  for (const old of value.tasks) {
    try {
      const task = migrateLegacyTask(old, runs);
      if (task) tasks[task.record.id] = task;
    } catch (e: any) {
      console.warn(`[schedule] 迁移旧任务失败,已跳过 ${String(old?.id)}: ${e?.message ?? e}`);
    }
  }
  return { unit: { name: UNIT_NAME, version: UNIT_VERSION }, global: null, tables: { tasks } };
}

/** 规范成 dsh 的 `HH:mm:ss.SSS`(旧数据是 `HH:mm` 或 `HH:mm:ss`) */
function normalizeLegacyTime(value: unknown): string {
  const text = String(value ?? '').trim();
  if (/^\d{2}:\d{2}$/.test(text)) return `${text}:00.000`;
  if (/^\d{2}:\d{2}:\d{2}$/.test(text)) return `${text}.000`;
  if (/^\d{2}:\d{2}:\d{2}\.\d{1,3}$/.test(text)) {
    const [hms, frac] = text.split('.');
    return `${hms}.${frac.padEnd(3, '0')}`;
  }
  throw new Error(`无法识别的 time:${text}`);
}

/** 旧数据里的时间可能不是规范字符串:统一解成 dsh 的毫秒精度 UTC 字符串 */
function decodeInstantValue(value: unknown): string {
  const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) throw new Error(`无法识别的时间:${String(value)}`);
  return new Date(ms).toISOString();
}

function migrateLegacyTask(old: any, runs: any[]): { sessionId: string; record: any; status: 'active' | 'inactive'; lastDelivery?: any; deliveryHistory?: any } | null {
  if (!old || typeof old !== 'object') return null;
  const id = typeof old.id === 'string' && old.id ? old.id : null;
  const sessionId = typeof old.sessionId === 'string' && old.sessionId ? old.sessionId : null;
  if (!id || !sessionId) return null;
  const title = typeof old.title === 'string' ? old.title.trim() : '';
  const prompt = typeof old.prompt === 'string' ? old.prompt : '';
  if (!title || !prompt) return null;
  const scheduledAt = decodeInstantValue(old.scheduledAt);
  const base = { id, title, prompt, scheduledAt };
  const zone = (): string => canonicalizeTimeZone(String(old.timeZone ?? 'UTC'));
  let record: any;
  switch (old.kind) {
    case 'after':
      record = { ...base, kind: 'after', afterSeconds: Math.max(1, Math.round(Number(old.afterSeconds) || 1)) };
      break;
    case 'at':
      record = { ...base, kind: 'at' };
      break;
    case 'every':
      record = { ...base, kind: 'every', everySeconds: Math.max(MIN_EVERY_INTERVAL_SECONDS, Math.round(Number(old.everySeconds) || MIN_EVERY_INTERVAL_SECONDS)) };
      break;
    case 'daily':
      record = { ...base, kind: 'daily', time: normalizeLegacyTime(old.time), timeZone: zone() };
      break;
    case 'weekly': {
      const weekdays = (Array.isArray(old.weekdays) && old.weekdays.length ? old.weekdays.map((d: any) => Number(d)).filter((d: number) => d >= 1 && d <= 7) : [1]) as number[];
      record = { ...base, kind: 'weekly', time: normalizeLegacyTime(old.time), timeZone: zone(), weekdays: [...new Set<number>(weekdays)].sort((a: number, b: number) => a - b) };
      break;
    }
    case 'cron':
      record = { ...base, kind: 'cron', expression: canonicalizeCronExpression(String(old.expression ?? '')), timeZone: zone() };
      break;
    default:
      return null;
  }
  // 只有 dsh 会记的那种事件才搬运:成功的投递
  const deliveries = runs
    .filter((r) => r && r.taskId === id && r.result === 'success')
    .sort((a: any, b: any) => String(a.startedAt).localeCompare(String(b.startedAt)))
    .map((r) => ({
      scheduledAt: decodeInstantValue(r.startedAt),
      deliveredAt: decodeInstantValue(r.endedAt ?? r.startedAt),
      messageId: `legacy_${String(r.id ?? 'run')}`,
      prompt,
    }));
  const status: 'active' | 'inactive' = old.enabled === false || old.completed === true ? 'inactive' : 'active';
  return {
    sessionId,
    record,
    status,
    ...(deliveries.length === 0 ? {} : {
      lastDelivery: (({ prompt: _p, ...receipt }) => receipt)(deliveries[deliveries.length - 1]),
      deliveryHistory: { records: deliveries, earlierRecordsUnavailable: false },
    }),
  };
}

/** 读盘 + 校验:任何不变量被破坏都抛 ScheduleLogError(调用方据此明确报错,不带着坏数据跑) */
function readDocument(file: string): { doc: Document; migrated: boolean } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { doc: emptyDocument(), migrated: false }; // 首次运行:还没有文件
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new ScheduleLogError(`schedule store ${file} is not valid JSON: ${String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ScheduleLogError(`schedule store ${file} must be a JSON object`);
  }
  // 上一版(自写实现)形状 → dsh 形状:搬到内存后立刻按新形状写回,旧文件不会被再读第二次
  const migrated = migrateLegacyDocument(parsed);
  if (migrated) return { doc: migrated, migrated: true };
  const doc = parsed as Partial<Document>;
  if (doc.unit?.name !== UNIT_NAME) throw new ScheduleLogError(`schedule store unit name must be "${UNIT_NAME}"`);
  if (doc.unit?.version !== UNIT_VERSION) {
    throw new ScheduleLogError(`schedule store version ${String(doc.unit?.version)} is not supported (expected ${UNIT_VERSION})`);
  }
  if (doc.global !== null && doc.global !== undefined) throw new ScheduleLogError('schedule store global slot must be null');
  const tasks = doc.tables?.tasks;
  if (tasks === undefined) return { doc: emptyDocument(), migrated: false };
  if (typeof tasks !== 'object' || tasks === null || Array.isArray(tasks)) {
    throw new ScheduleLogError('schedule store tables.tasks must be an object');
  }
  return {
    doc: { unit: { name: UNIT_NAME, version: UNIT_VERSION }, global: null, tables: { tasks: tasks as Record<string, unknown> } },
    migrated: false,
  };
}

export function openScheduleStore(file: string = SCHEDULES_FILE): ScheduleStore {
  const target = file;
  const { doc, migrated } = readDocument(target);
  /** 内存态:键 -> 已校验的任务行 */
  const rows = new Map<string, ScheduleTask>();

  // 打开即校验每一行(与 dsh 打开 domain 时逐行解码同义):坏行 / 键不符 → 抛错
  for (const [key, value] of Object.entries(doc.tables.tasks)) {
    const task = parseScheduleTask(value); // zod strict:多余键/不变量不符在这里抛
    if (task.record.id !== key) {
      throw new ScheduleLogError(`schedule store key ${JSON.stringify(key)} does not match record id ${JSON.stringify(task.record.id)}`);
    }
    rows.set(key, task);
  }

  const serialize = (): string => {
    const doc: Document = { unit: { name: UNIT_NAME, version: UNIT_VERSION }, global: null, tables: { tasks: {} } };
    for (const [key, task] of rows) doc.tables.tasks[key] = task;
    return `${JSON.stringify(doc, null, 2)}\n`;
  };

  const publish = (): void => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomic(target, serialize());
  };

  // 旧形状已经搬进内存:立刻按 dsh 形状写回(一次性迁移),下次直接读新形状
  if (migrated) {
    console.warn('[schedule] 检测到上一版任务库形状,已迁移为 dsh 形状并写回');
    publish();
  }

  const table: ScheduleTable = {
    get: (id) => rows.get(String(id)),
    put: async (id, task) => {
      const key = String(id);
      if (task.record.id !== key) {
        throw new ScheduleLogError(`schedule store key ${JSON.stringify(key)} does not match record id ${JSON.stringify(task.record.id)}`);
      }
      // 写前校验:坏记录绝不能进库(与 dsh 的 domain 写路径同一取向)
      const validated = parseScheduleTask(task);
      rows.set(key, validated);
      publish();
    },
    delete: async (id) => {
      const key = String(id);
      if (!rows.has(key)) return;
      rows.delete(key);
      publish();
    },
    entries: () => [...rows.entries()],
  };
  return {
    file: target,
    table,
    tasks: () => [...rows.values()],
    close: async () => { /* 每次写都立即落盘,关闭无需额外动作 */ },
  };
}
