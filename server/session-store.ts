// @ts-nocheck
// 会话存储:多会话事件日志持久化到磁盘
// - 索引 data/sessions.json:{ version, active, sessions:[{id,title,createdAt,updatedAt,msgCount}] }
// - 每个会话一个文件 data/sessions/<id>.json:
//     v2:{ version: 2, ts, events:[SessionEvent...] }  事件溯源日志(现行格式,见 agent/session.js)
//     v1:{ version: 1, ts, turns:[...] }               旧消息数组,读取时自动迁移为事件
// - 零依赖(Node 内置 fs),原子写(临时文件 + rename)防损坏
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventsFromTurns } from './agent/session.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data'); // 项目根 data/(测试可注入隔离目录)
const INDEX_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const ID_RE = /^s_[0-9a-z]+$/;
const MAX_EVENTS = 50_000; // 单会话安全上限(防外部改大;超限只保留尾部事件)

function newId() {
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function readIndex() {
  let j;
  try { j = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { j = null; }
  if (!j || !Array.isArray(j.sessions)) return { version: 1, active: null, sessions: [] };
  return j;
}

function writeIndex(idx) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const body = JSON.stringify({ version: 1, active: idx.active || null, sessions: idx.sessions }, null, 0);
  const tmp = INDEX_FILE + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, INDEX_FILE);
}

function fileFor(id) {
  if (!ID_RE.test(id)) throw new Error(`非法会话 id: ${id}`);
  return path.join(SESSIONS_DIR, id + '.json');
}

// 读取会话文件,统一返回事件数组:
// v2 直接读 events;v1(旧 turns 消息数组)经 eventsFromTurns 迁移为事件
function readEvents(id) {
  let j;
  try { j = JSON.parse(fs.readFileSync(fileFor(id), 'utf8')); } catch { return []; }
  if (Array.isArray(j?.events)) {
    return j.events.length <= MAX_EVENTS ? j.events : j.events.slice(-MAX_EVENTS);
  }
  if (Array.isArray(j?.turns)) return eventsFromTurns(j.turns);
  return [];
}

function writeEventsFile(id, events) {
  const body = JSON.stringify({ version: 2, ts: Date.now(), events }, null, 0);
  const tmp = fileFor(id) + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, fileFor(id));
}

/**
 * 会话元数据列表(按最近更新倒序)。
 * @param {string} [connKey] 作用域键:服务器 = `username@host:port`,本地模式 = 'local'。
 *   传入时只返回该作用域的会话;缺省返回全部(旧调用兼容)。
 *   无归属(connKey 缺失)的存量会话不算进任何作用域,待首次连接服务器时由 migrateLegacy 归属。
 */
export function list(connKey) {
  const idx = readIndex();
  const rows = connKey == null ? idx.sessions : idx.sessions.filter((s) => s.connKey === connKey);
  return [...rows].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * 把无归属的存量会话(connKey 缺失,该功能上线前的旧会话)一次性归属到指定服务器键。
 * 可重复调用:没有无归属会话时是空操作。本地模式(local)不触发迁移。
 * @returns {number} 本次迁移的会话数
 */
export function migrateLegacy(connKey) {
  if (!connKey || connKey === 'local') return 0;
  const idx = readIndex();
  let n = 0;
  for (const s of idx.sessions) {
    if (!s.connKey) { s.connKey = connKey; n++; }
  }
  if (n) writeIndex(idx);
  return n;
}

export function getActive() {
  const idx = readIndex();
  return idx.active && idx.sessions.some((s) => s.id === idx.active) ? idx.active : null;
}

export function setActive(id) {
  const idx = readIndex();
  if (id && !idx.sessions.some((s) => s.id === id)) throw new Error(`会话不存在: ${id}`);
  idx.active = id;
  writeIndex(idx);
}

/** 创建新会话并设为活跃,返回元数据。connKey = 归属作用域(服务器键或 'local') */
export function create(title, connKey) {
  const id = newId();
  const now = Date.now();
  const sess = { id, title: title || '新会话', connKey: connKey || null, createdAt: now, updatedAt: now, msgCount: 0 };
  const idx = readIndex();
  idx.sessions.push(sess);
  idx.active = id;
  writeIndex(idx);
  writeEventsFile(id, []);
  return sess;
}

export function exists(id) {
  return readIndex().sessions.some((s) => s.id === id);
}

/** 加载会话事件日志(v1 旧格式自动迁移) */
export function loadEvents(id) {
  return exists(id) ? readEvents(id) : [];
}

/** 保存会话事件日志并更新索引元数据 */
export function saveEvents(id, events) {
  const idx = readIndex();
  const s = idx.sessions.find((x) => x.id === id);
  if (!s) throw new Error(`会话不存在: ${id}`);
  const clean = Array.isArray(events) ? events : [];
  writeEventsFile(id, clean);
  s.updatedAt = Date.now();
  s.msgCount = clean.filter((e) => e?.type === 'user/message' && e.data?.source === 'user').length;
  writeIndex(idx);
}

export function rename(id, title) {
  const idx = readIndex();
  const s = idx.sessions.find((x) => x.id === id);
  if (!s) throw new Error(`会话不存在: ${id}`);
  s.title = String(title || '').slice(0, 80) || '新会话';
  writeIndex(idx);
}

export function remove(id) {
  const idx = readIndex();
  const i = idx.sessions.findIndex((x) => x.id === id);
  if (i < 0) return; // 不存在则视为已删除
  idx.sessions.splice(i, 1);
  if (idx.active === id) idx.active = null;
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
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'chat-history.json'), 'utf8')); } catch { return; }
    const turns = (Array.isArray(j.turns) ? j.turns : []).filter((m) => m && m.role);
    if (turns.length === 0) return;
    const events = eventsFromTurns(turns);
    const id = newId();
    const now = Date.now();
    idx.sessions.push({ id, title: '历史会话', createdAt: now, updatedAt: now, msgCount: turns.filter((m) => m.role === 'user').length });
    idx.active = id;
    writeIndex(idx);
    writeEventsFile(id, events);
  } catch { /* 迁移失败不影响使用 */ }
}
ensureMigrated();
