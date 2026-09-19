// 会话存储:多会话事件日志持久化到磁盘
// - 索引 data/sessions.json:{ version, active, sessions:[{id,title,createdAt,updatedAt,msgCount}] }
// - 每个会话一个文件 data/sessions/<id>.json:
//     v2:{ version: 2, ts, events:[SessionEvent...] }  事件溯源日志(现行格式,见 agent/session.js)
//     v1:{ version: 1, ts, turns:[...] }               旧消息数组,读取时自动迁移为事件
// - 零依赖(Node 内置 fs),原子写(临时文件 + rename)防损坏,见 store/atomic-write.ts
import fs from 'node:fs';
import path from 'node:path';
import { eventsFromTurns } from '../agent/session.ts';
import { DATA_DIR, SESSIONS_FILE as INDEX_FILE, SESSIONS_DIR } from '../config.ts';
import { writeFileAtomic } from './atomic-write.ts';

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const ID_RE = /^s_[0-9a-z]+$/;
const MAX_EVENTS = 50_000; // 单会话安全上限(防外部改大;超限只保留尾部事件)

// 落盘 I/O 失败(磁盘被占用、写满)只告警不抛出:会话文件每次事件都会重写,一次抖动
// 不该打断正在跑的 agent 回合,下一次落盘会把这批事件一并写全。同类告警限流 10s 一条。
let lastIoWarnAt = 0;
function warnIoFailure(what: string, err: unknown): void {
  const now = Date.now();
  if (now - lastIoWarnAt < 10_000) return;
  lastIoWarnAt = now;
  console.warn(`[session-store] ${what}落盘失败(本次跳过,后续落盘会重试): ${(err as Error)?.message ?? err}`);
}

export interface SessionMeta {
  id: string;
  title: string;
  connKey: string | null;
  createdAt: number;
  updatedAt: number;
  msgCount: number;
  /**
   * 会话最后一次"用户发消息"的时间(事件日志里最后一条 source='user' 的 user/message)。
   * 任务列表的活跃排序以它为准:AI 回复只推进 updatedAt,不改 lastUserAt,否则每轮回复
   * 都会把会话顶到最前,列表顺序一直变。缺省(旧索引 / 尚无用户消息)时回退 updatedAt。
   */
  lastUserAt?: number;
  /**
   * 会话绑定的远程工作区(连接服务器时执行目录)。
   * 三种取值:目录路径 / NO_WORKSPACE(「不在工作区对话」,边界=整台服务器)
   * / null·缺失(未绑定,执行时回落连接级工作区)
   */
  workspace?: string | null;
  /** 会话绑定的本地工作区;同样可为 NO_WORKSPACE(边界=整台电脑)或 null·缺失(回落全局值) */
  localWorkspace?: string | null;
}

export interface SessionIndex {
  version: number;
  active: string | null;
  sessions: SessionMeta[];
}

function newId(): string {
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function readIndex(): SessionIndex {
  let j: any;
  try { j = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { j = null; }
  if (!j || !Array.isArray(j.sessions)) return { version: 1, active: null, sessions: [] };
  return j;
}

function writeIndex(idx: SessionIndex) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const body = JSON.stringify({ version: 1, active: idx.active || null, sessions: idx.sessions }, null, 0);
  writeFileAtomic(INDEX_FILE, body);
}

function fileFor(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`非法会话 id: ${id}`);
  return path.join(SESSIONS_DIR, id + '.json');
}

// 读取会话文件,统一返回事件数组:
// v2 直接读 events;v1(旧 turns 消息数组)经 eventsFromTurns 迁移为事件
function readEvents(id: string): any[] {
  let j: any;
  try { j = JSON.parse(fs.readFileSync(fileFor(id), 'utf8')); } catch { return []; }
  if (Array.isArray(j?.events)) {
    return j.events.length <= MAX_EVENTS ? j.events : j.events.slice(-MAX_EVENTS);
  }
  if (Array.isArray(j?.turns)) return eventsFromTurns(j.turns);
  return [];
}

function writeEventsFile(id: string, events: any[]) {
  const body = JSON.stringify({ version: 2, ts: Date.now(), events }, null, 0);
  writeFileAtomic(fileFor(id), body);
}

/**
 * 任务列表活跃排序键:以"用户最后发消息的时间"(lastUserAt)为准,而不是最后一次事件
 * 落盘时间(updatedAt)——AI 回复会不断推进 updatedAt,若用它排序,列表会随每轮回复重排。
 * 无用户消息(刚创建的空会话)或旧索引缺该字段时回退 updatedAt/createdAt,保证顺序稳定。
 */
export function activeAt(s: SessionMeta): number {
  return s.lastUserAt || s.updatedAt || s.createdAt || 0;
}

/**
 * 会话元数据列表(按用户最近发消息倒序)。
 * 作用域键:服务器 = `username@host:port`,本地模式 = 'local'。
 * 传入时只返回该作用域的会话;缺省返回全部(旧调用兼容)。
 * 无归属(connKey 缺失)的存量会话不算进任何作用域,待首次连接服务器时由 migrateLegacy 归属。
 */
export function list(connKey?: string | null): SessionMeta[] {
  const idx = readIndex();
  const rows = connKey == null ? idx.sessions : idx.sessions.filter((s) => s.connKey === connKey);
  return [...rows].sort((a, b) => activeAt(b) - activeAt(a));
}

/**
 * 把无归属的存量会话(connKey 缺失,该功能上线前的旧会话)一次性归属到指定服务器键。
 * 可重复调用:没有无归属会话时是空操作。本地模式(local)不触发迁移。
 * @returns 本次迁移的会话数
 */
export function migrateLegacy(connKey: string): number {
  if (!connKey || connKey === 'local') return 0;
  const idx = readIndex();
  let n = 0;
  for (const s of idx.sessions) {
    if (!s.connKey) { s.connKey = connKey; n++; }
  }
  if (n) writeIndex(idx);
  return n;
}

export function getActive(): string | null {
  const idx = readIndex();
  return idx.active && idx.sessions.some((s) => s.id === idx.active) ? idx.active : null;
}

export function setActive(id: string | null): void {
  const idx = readIndex();
  if (id && !idx.sessions.some((s) => s.id === id)) throw new Error(`会话不存在: ${id}`);
  idx.active = id;
  writeIndex(idx);
}

/** 创建新会话并设为活跃,返回元数据。connKey = 归属作用域(服务器键或 'local')。
    opts.workspace / opts.localWorkspace = 会话绑定的执行工作区(新建时捕获当前连接工作区) */
export function create(title: string, connKey?: string | null, opts: { workspace?: string | null; localWorkspace?: string | null } = {}): SessionMeta {
  const id = newId();
  const now = Date.now();
  const sess: SessionMeta = {
    id, title: title || '新会话', connKey: connKey || null, createdAt: now, updatedAt: now, msgCount: 0,
    workspace: opts.workspace != null ? opts.workspace : null,
    localWorkspace: opts.localWorkspace != null ? opts.localWorkspace : null
  };
  const idx = readIndex();
  idx.sessions.push(sess);
  idx.active = id;
  writeIndex(idx);
  writeEventsFile(id, []);
  return sess;
}

export function exists(id: string): boolean {
  return readIndex().sessions.some((s) => s.id === id);
}

/** 加载会话事件日志(v1 旧格式自动迁移) */
export function loadEvents(id: string): any[] {
  return exists(id) ? readEvents(id) : [];
}

/** 事件日志里最后一次用户发消息的时间(source='user');没有用户消息时返回 0 */
function lastUserMessageTime(events: any[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'user/message' && e?.data?.source === 'user') return Number(e.time) || 0;
  }
  return 0;
}

// ---------------- 首条用户提问(任务列表悬停提示) ----------------
// 前端侧栏会话行的标题只是首条提问的前 24 字(见 agent.ts 的自动命名),悬停时展示更多内容:
// 这里从事件日志取第一条 user/message(source='user')的正文,压平空白后按 TIP_PROMPT_MAX 截断。
// 因此按会话 id 缓存,避免每次会话列表推送都重读全部会话文件;保存会话时按实际首条提问
// 与缓存的差异失效(首次落盘、回退删掉首条都会变),删除会话时直接清理。
const TIP_PROMPT_MAX = 300;
const firstPromptCache = new Map<string, string>();

/** 从事件日志提取首条用户提问(压平空白后按上限截断);没有用户消息时返回空串 */
function extractFirstPrompt(events: any[]): string {
  for (const e of events) {
    if (e?.type === 'user/message' && e?.data?.source === 'user') {
      // display = 用户原文(技能注入只改 content,见 agent.ts 的 user/message 落盘),
      // 优先用它,否则 /技能 会话会把整段注入指令当成用户的提问。
      const raw = e.data.display;
      const text = String(raw != null && raw !== '' ? raw : e.data.content || '').replace(/\s+/g, ' ').trim();
      return text.length > TIP_PROMPT_MAX ? text.slice(0, TIP_PROMPT_MAX) + '…' : text;
    }
  }
  return '';
}

export function firstPrompt(id: string): string {
  const cached = firstPromptCache.get(id);
  if (cached !== undefined) return cached;
  const text = extractFirstPrompt(readEvents(id));
  // 只缓存非空结果:会话刚创建时首条用户消息还没落盘,若把空串也缓存住,
  // 之后消息写入也不会重算,悬停提示永远回退成 24 字标题(只有一行)。
  if (text) firstPromptCache.set(id, text);
  return text;
}

/** 保存会话事件日志并更新索引元数据 */
export function saveEvents(id: string, events: any[]): void {
  const idx = readIndex();
  const s = idx.sessions.find((x) => x.id === id);
  if (!s) throw new Error(`会话不存在: ${id}`);
  const clean = Array.isArray(events) ? events : [];
  try {
    writeEventsFile(id, clean);
  } catch (e) {
    warnIoFailure(`会话 ${id}`, e);
    return; // 事件日志都没落盘,索引里的 msgCount/updatedAt 也不必更新
  }
  s.updatedAt = Date.now();
  // 活跃排序看的是"用户最后发消息的时间",不是事件最后落盘时间:AI 回复(assistant/tool
  // 事件)只推进 updatedAt,不改 lastUserAt,任务列表因此不会随每轮回复重排。
  const lastUserAt = lastUserMessageTime(clean);
  if (lastUserAt > (s.lastUserAt || 0)) s.lastUserAt = lastUserAt;
  // 有内容的消息数(user 消息 + 压缩检查点)。非破坏压缩下早期 user 消息仍完整保留在
  // 日志里,msgCount 真实反映历史体量;压缩检查点(compaction/done)也计入,保证压缩后
  // 会话不被前端"空会话"过滤规则隐藏。
  s.msgCount = clean.filter((e: any) =>
    (e?.type === 'user/message' && e.data?.source === 'user') || e?.type === 'compaction/done').length;
  try {
    writeIndex(idx);
  } catch (e) {
    warnIoFailure('会话索引', e);
  }
  // 首条提问可能随本次保存变化(会话首次落盘用户消息、回退删掉首条提问、/技能 会话修正
  // display),与缓存不一致就失效重算,否则悬停提示会一直停在空串或旧提问上。
  if (firstPromptCache.get(id) !== extractFirstPrompt(clean)) firstPromptCache.delete(id);
}

export function rename(id: string, title: string): void {
  const idx = readIndex();
  const s = idx.sessions.find((x) => x.id === id);
  if (!s) throw new Error(`会话不存在: ${id}`);
  s.title = String(title || '').slice(0, 80) || '新会话';
  writeIndex(idx);
}

// 更新会话绑定的执行工作区(远程/本地)。只改绑定字段,不动 updatedAt——
// 工作区切换属于"视图状态"而非对话活动,不应打乱列表按最近更新的排序。
export function setWorkspace(id: string, ws: string | null): void {
  const idx = readIndex();
  const s = idx.sessions.find((x) => x.id === id);
  if (!s) throw new Error(`会话不存在: ${id}`);
  s.workspace = ws;
  writeIndex(idx);
}

export function setLocalWorkspace(id: string, lws: string | null): void {
  const idx = readIndex();
  const s = idx.sessions.find((x) => x.id === id);
  if (!s) throw new Error(`会话不存在: ${id}`);
  s.localWorkspace = lws;
  writeIndex(idx);
}

// 重新归属会话作用域(如空会话补选远程工作区后,从本地翻转为当前服务器作用域)
export function setConnKey(id: string, connKey: string | null): void {
  const idx = readIndex();
  const s = idx.sessions.find((x) => x.id === id);
  if (!s) throw new Error(`会话不存在: ${id}`);
  s.connKey = connKey || null;
  writeIndex(idx);
}

export function remove(id: string): void {
  const idx = readIndex();
  const i = idx.sessions.findIndex((x) => x.id === id);
  if (i < 0) return; // 不存在则视为已删除
  idx.sessions.splice(i, 1);
  if (idx.active === id) idx.active = null;
  firstPromptCache.delete(id);
  writeIndex(idx);
  try { fs.unlinkSync(fileFor(id)); } catch {}
}

// ---------------- 旧版单历史迁移 ----------------
// 首次启动且尚无任何会话时,把旧 data/chat-history.json 里的对话导入为一个会话(名为「历史会话」),
// 保证升级前已有的对话不丢失。之后不再触发。
let migrated = false;
function ensureMigrated() {
  if (migrated) return;
  migrated = true;
  try {
    const idx = readIndex();
    if (idx.sessions.length > 0) return;
    let j: any;
    try { j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'chat-history.json'), 'utf8')); } catch { return; }
    const turns = (Array.isArray(j.turns) ? j.turns : []).filter((m: any) => m && m.role);
    if (turns.length === 0) return;
    const events = eventsFromTurns(turns);
    const id = newId();
    const now = Date.now();
    idx.sessions.push({ id, title: '历史会话', connKey: null, createdAt: now, updatedAt: now, msgCount: turns.filter((m: any) => m.role === 'user').length });
    idx.active = id;
    writeIndex(idx);
    writeEventsFile(id, events);
  } catch { /* 迁移失败不影响使用 */ }
}
ensureMigrated();

// ---------------- 存量索引修复 ----------------
// 老版本破坏式压缩(squash 直接把早期 user 消息从日志删除)落盘时,msgCount 可能被计为 0
// (深工具会话唯一 user 也被压掉),前端会话列表据此把有内容的会话当"空会话"隐藏——
// 会话数据文件仍在,只是索引里 msgCount 失真。启动时对 msgCount=0 但有事件内容的会话
// 按现行口径(user 消息 + 压缩检查点)重算并写回索引,让这类会话重新出现在侧栏。
function repairStaleMsgCounts(): number {
  let idx = readIndex();
  let n = 0;
  for (const s of idx.sessions) {
    if ((s.msgCount ?? 0) > 0) continue;
    const events = readEvents(s.id);
    if (!events.length) continue;
    const count = events.filter((e: any) =>
      (e?.type === 'user/message' && e.data?.source === 'user') || e?.type === 'compaction/done').length;
    if (count > 0) { s.msgCount = count; n++; }
  }
  if (n) writeIndex(idx);
  return n;
}
repairStaleMsgCounts();

// ---------------- 存量索引回填 ----------------
// lastUserAt 是后加字段:旧索引没有它,首次升级时从事件日志补上,否则这些会话的活跃排序
// 会回退到 updatedAt(=最后一次事件落盘时间,含 AI 回复),与新版排序口径不一致。
function backfillLastUserAt(): number {
  const idx = readIndex();
  let n = 0;
  for (const s of idx.sessions) {
    if (s.lastUserAt || (s.msgCount ?? 0) <= 0) continue; // 无用户消息的会话(含空会话)无需回填,少读一批文件
    const t = lastUserMessageTime(readEvents(s.id));
    if (t > 0) { s.lastUserAt = t; n++; }
  }
  if (n) writeIndex(idx);
  return n;
}
backfillLastUserAt();
