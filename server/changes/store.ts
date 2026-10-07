// 每轮文件变更记录 + 单文件 hunk 级对比。
// 对齐 deepseek-harness 的 packages/deliverables/workspace-changes,但按 Teleforge 的形态做了两处改造:
//   - dsh 用 git write-tree 拍轮快照(工作区必须是 git 仓库、要跑若干次 git);
//     Teleforge 的典型工作区是远程服务器上的任意目录,所以改为「**写盘前捕获原内容**」——
//     文件写工具本来就知道自己要写哪个路径,抓住旧内容存起来即可,对非 git 目录同样有效;
//   - dsh 的轮记录只放内存(刷新即失),这里持久化到 data/changes/,因为 Teleforge 的会话
//     本来就是长期回看的,历史轮的 diff 不该因为一次刷新就没了。
//
// 为什么需要它:文件写工具的 tool/result meta 里只有「增删行数」,没有改动前后的内容,
// 前端因此画不出真正的 diff —— 只能把 old_string/new_string 假装成两侧(见 toolviews/DiffRow)。
//
// 三条硬约束(改前先读):
//   1. **绝不能影响写操作本身**:记录动作都在写盘成功之后,且整段包在 try/catch;
//      记录失败最多是没有对比数据,永远不能让一次文件写入失败(或明显变慢);
//   2. **只记文本且有上限**:>2MiB、或前 8KB 含 NUL(二进制)的文件只保留行数,
//      内容不存 —— 与 dsh 的 oversized/binary 降级口径一致;
//   3. **同一个文件同一轮只留最后一条**:一轮里被改多次时,对比的是「本轮开始 vs 最后一次」,
//      与 dsh 的「后一条记录替代前一条」同语义。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { structuredPatch } from 'diff';
import { DATA_DIR } from '../config.ts';
import { writeFileAtomic } from '../store/atomic-write.ts';

/** 单个文件的内容上限(超过只记行数):与 edit_file 工具自身的 2MB 上限一致 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 二进制嗅探窗口(dsh 同款:只嗅前 8KB) */
const NUL_SNIFF_BYTES = 8000;
/** 每个会话保留多少轮:超出丢最旧的(blob 引用计数随之清理) */
const KEEP_TURNS = 30;
/** 行级比较的超时(毫秒):超时退化为「全删 + 全加」并标 coarse */
const DIFF_TIMEOUT_MS = 100;
/** hunk 上下文行数(dsh 同款 3 行) */
const CONTEXT_LINES = 3;

export type ChangeKind = 'create' | 'write' | 'edit' | 'delete';

/** 落盘的单个文件条目(内容以 blob 的 sha1 引用,避免索引文件膨胀) */
interface StoredEntry {
  path: string;
  kind: ChangeKind;
  /** 新增行数(来自写工具自己的口径,与既有「N 个文件已更改」卡一致) */
  added: number;
  /** 删除行数 */
  deleted: number;
  /** 改动前内容的 blob sha1;缺省 = 此前文件不存在(新建) */
  before?: string;
  /** 改动后内容的 blob sha1;缺省 = 文件被删除 */
  after?: string;
  /** 二进制:不存内容,只记行数 */
  binary?: boolean;
  /** 超过 MAX_FILE_BYTES:不存内容,只记行数 */
  oversized?: boolean;
  /** 该改动来自本机侧(本地工作区)还是远程侧:决定「打开整个文件」走哪条通道 */
  local?: boolean;
}

export interface ChangeFileBrief {
  /** 本轮内的序号(前端用它请求单文件对比) */
  index: number;
  path: string;
  kind: ChangeKind;
  added: number;
  deleted: number;
  binary: boolean;
  oversized: boolean;
  /** true = 本机文件(前端据此选本地/远程的打开通道) */
  local: boolean;
}

export interface ChangesSummary {
  turn: number;
  files: ChangeFileBrief[];
  added: number;
  deleted: number;
  total: number;
}

/** 与 dsh 的 WorkspaceDiffHunk 同构:每行保留 '+'/'-'/' ' 前缀,前端零成本分行编号 */
export interface WorkspaceDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export type WorkspaceFileDiff =
  | { kind: 'text'; path: string; display: string; before: boolean; after: boolean; hunks: WorkspaceDiffHunk[]; coarse: boolean }
  | { kind: 'binary' }
  | { kind: 'oversized' };

/* ---------------- 内存态 + 落盘 ---------------- */

/** sid → (turn → 该轮的文件条目,按记录顺序) */
const turns = new Map<string, Map<number, StoredEntry[]>>();
/** 已从磁盘载入过的会话(避免每次查询都读盘) */
const loaded = new Set<string>();

const changesDir = () => path.join(DATA_DIR, 'changes');
const indexFile = (sid: string) => path.join(changesDir(), `${sid}.json`);
const blobDir = (sid: string) => path.join(changesDir(), sid);

/** 会话 id 直接进文件名:先过一遍白名单,避免路径穿越(会话 id 由服务端生成,这里是防御性的) */
function safeSid(sid: string): string | null {
  return /^[A-Za-z0-9_.-]{1,80}$/.test(sid) ? sid : null;
}

function load(sid: string): Map<number, StoredEntry[]> {
  if (loaded.has(sid)) return turns.get(sid) || new Map();
  loaded.add(sid);
  let map = new Map<number, StoredEntry[]>();
  try {
    const j = JSON.parse(fs.readFileSync(indexFile(sid), 'utf8'));
    if (j && typeof j === 'object' && j.turns && typeof j.turns === 'object') {
      for (const [k, v] of Object.entries(j.turns as Record<string, StoredEntry[]>)) {
        const turn = Number(k);
        if (Number.isInteger(turn) && Array.isArray(v)) map.set(turn, v.filter((e) => e && typeof e.path === 'string'));
      }
    }
  } catch { /* 文件不存在/损坏:从空开始(比抛错好,记录是可再生的观察数据) */ }
  turns.set(sid, map);
  return map;
}

function persist(sid: string, map: Map<number, StoredEntry[]>): void {
  try {
    fs.mkdirSync(changesDir(), { recursive: true });
    const out: Record<string, StoredEntry[]> = {};
    for (const [turn, list] of map) out[String(turn)] = list;
    writeFileAtomic(indexFile(sid), JSON.stringify({ version: 1, turns: out }));
  } catch { /* 只读磁盘/配额满:内存态仍可用,下次查询回落到本轮记录 */ }
}

/** 写 blob(内容寻址,幂等);返回 sha1;内容过大/二进制由调用方先行判定 */
function putBlob(sid: string, text: string): string | null {
  try {
    const sha = createHash('sha1').update(text, 'utf8').digest('hex');
    const dir = blobDir(sid);
    const file = path.join(dir, sha);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, text, 'utf8');
    }
    return sha;
  } catch {
    return null;
  }
}

function getBlob(sid: string, sha: string | undefined): string | null {
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return null;
  try {
    return fs.readFileSync(path.join(blobDir(sid), sha), 'utf8');
  } catch {
    return null;
  }
}

/** 轮数超限:丢最旧的若干轮,并清理不再被引用的 blob */
function prune(sid: string, map: Map<number, StoredEntry[]>): void {
  if (map.size <= KEEP_TURNS) return;
  const keys = [...map.keys()].sort((a, b) => a - b);
  for (const k of keys.slice(0, map.size - KEEP_TURNS)) map.delete(k);
  try {
    const alive = new Set<string>();
    for (const list of map.values()) for (const e of list) { if (e.before) alive.add(e.before); if (e.after) alive.add(e.after); }
    const dir = blobDir(sid);
    for (const name of fs.readdirSync(dir)) if (!alive.has(name)) fs.unlinkSync(path.join(dir, name));
  } catch { /* 清理失败不影响功能,只是多占点磁盘 */ }
}

/* ---------------- 对外:记录 ---------------- */

function isBinary(text: string): boolean {
  return text.slice(0, NUL_SNIFF_BYTES).includes('\u0000');
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export interface RecordInput {
  /** 绝对路径(与写工具 meta 里的 path 一致) */
  path: string;
  kind: ChangeKind;
  /** 改动前全文;null/缺省 = 此前不存在或读不到 */
  before?: string | null;
  /** 改动后全文;null/缺省 = 文件被删除 */
  after?: string | null;
  added: number;
  deleted: number;
  /** 展示用相对路径(缺省用 path) */
  display?: string;
  /** true = 本机侧改动(本地工具传入);缺省按远程处理 */
  local?: boolean;
}

/**
 * 记录一次文件变更(写盘成功后调用)。
 * 任何异常都被吞掉 —— 这是「观察」而非「业务」,不允许影响写操作的结果。
 */
export function recordFileChange(sid: string | null | undefined, turn: number | null | undefined, input: RecordInput): void {
  try {
    const id = sid && safeSid(sid);
    const t = Number(turn);
    if (!id || !Number.isInteger(t) || t <= 0 || !input || typeof input.path !== 'string' || !input.path) return;
    const map = load(id);
    const list = map.get(t) || [];
    const before = typeof input.before === 'string' ? input.before : null;
    const after = typeof input.after === 'string' ? input.after : null;
    // 任一侧是二进制/超大 → 整个条目不做内容级对比(只保留行数),与 dsh 的降级一致
    const tooBig = (before !== null && bytesOf(before) > MAX_FILE_BYTES) || (after !== null && bytesOf(after) > MAX_FILE_BYTES);
    const bin = (before !== null && isBinary(before)) || (after !== null && isBinary(after));
    const entry: StoredEntry = {
      path: input.path,
      kind: input.kind,
      added: Math.max(0, Number(input.added) || 0),
      deleted: Math.max(0, Number(input.deleted) || 0),
      ...(input.local ? { local: true } : {})
    };
    if (tooBig) entry.oversized = true;
    else if (bin) entry.binary = true;
    else {
      if (before !== null) { const sha = putBlob(id, before); if (sha) entry.before = sha; }
      if (after !== null) { const sha = putBlob(id, after); if (sha) entry.after = sha; }
    }
    // 同一轮同一路径只留最后一条(本轮开始 vs 最后一次);display 用 path 的末段
    const at = list.findIndex((e) => e.path === input.path);
    if (at >= 0) list[at] = entry; else list.push(entry);
    map.set(t, list);
    prune(id, map);
    persist(id, map);
  } catch { /* 记录失败绝不影响写操作 */ }
}

/* ---------------- 对外:查询 ---------------- */

export function changesSummary(sid: string | null | undefined, turn: number | null | undefined): ChangesSummary | null {
  const id = sid && safeSid(sid);
  const t = Number(turn);
  if (!id || !Number.isInteger(t) || t <= 0) return null;
  const list = load(id).get(t);
  if (!list || list.length === 0) return null;
  const files: ChangeFileBrief[] = list.map((e, index) => ({
    index,
    path: e.path,
    kind: e.kind,
    added: e.added,
    deleted: e.deleted,
    binary: !!e.binary,
    oversized: !!e.oversized,
    local: !!e.local
  }));
  return {
    turn: t,
    files,
    added: files.reduce((n, f) => n + f.added, 0),
    deleted: files.reduce((n, f) => n + f.deleted, 0),
    total: files.length
  };
}

/**
 * 按路径回找「该文件最近一次变更」所在的轮与序号。
 * 用途:从对话里的变更卡点进来时,前端只带路径即可(不依赖工具 meta 里的轮号,旧会话/分支重放也能用)。
 * 给了 turn 就先在那一轮找,找不到再按轮号从大到小回找 —— 分支或重放后轮号可能对不上。
 * @param sid 会话 id
 * @param path 文件绝对路径
 * @param turn 期望的轮号(可选)
 * @returns 命中的 { turn, index };找不到返回 null
 */
export function findChange(sid: string | null | undefined, path: string, turn?: number | null): { turn: number; index: number } | null {
  const id = sid && safeSid(sid);
  if (!id || typeof path !== 'string' || !path) return null;
  const map = load(id);
  const withPath = [...map.entries()]
    .filter(([, list]) => list.some((e) => e.path === path))
    .map(([t]) => t)
    .sort((a, b) => b - a);
  const want = Number(turn);
  const ordered = Number.isInteger(want) && want > 0 ? [want, ...withPath.filter((t) => t !== want)] : withPath;
  for (const t of ordered) {
    const list = map.get(t);
    if (!list) continue;
    const index = list.findIndex((e) => e.path === path);
    if (index >= 0) return { turn: t, index };
  }
  return null;
}

/**
 * 单文件对比。返回 null = 该 (会话, 轮, 序号) 已不可用(被清理/轮号不对)——
 * 前端据此显示「已不可用」而不是空白。
 */
export function changeFileDiff(sid: string | null | undefined, turn: number | null | undefined, index: number | null | undefined): WorkspaceFileDiff | null {
  const id = sid && safeSid(sid);
  const t = Number(turn);
  const i = Number(index);
  if (!id || !Number.isInteger(t) || !Number.isInteger(i) || i < 0) return null;
  const entry = load(id).get(t)?.[i];
  if (!entry) return null;
  if (entry.binary) return { kind: 'binary' };
  if (entry.oversized) return { kind: 'oversized' };
  const beforeText = getBlob(id, entry.before);
  const afterText = getBlob(id, entry.after);
  // 内容丢了(blob 清理/写失败):退化为「只知行数」的纯文本态,由前端给一行说明
  if ((entry.before && beforeText === null) || (entry.after && afterText === null)) return null;
  const oldText = beforeText ?? '';
  const newText = afterText ?? '';
  // 无内容差异(例如同内容重写):给一个空 hunks 的文本态,前端显示「内容未变化」
  const { hunks, coarse } = computeHunks(oldText, newText);
  return {
    kind: 'text',
    path: entry.path,
    display: entry.path,
    before: beforeText !== null,
    after: afterText !== null,
    hunks,
    coarse
  };
}

/* ---------------- 行级对比(纯函数,便于穷举单测) ---------------- */

function countLines(s: string): number {
  if (!s) return 0;
  const n = s.split('\n').length;
  return s.endsWith('\n') ? n - 1 : n;
}

/** 按行切分:与 countLines 同一口径(末尾换行不产生额外空行),避免粗粒度退化时多画一行空行 */
function splitLines(s: string): string[] {
  if (!s) return [];
  return (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');
}

/** 超时/异常时的粗粒度退化:一个「全删 + 全加」的 hunk(与 dsh 的 coarse 同语义) */
export function coarseHunks(oldText: string, newText: string): WorkspaceDiffHunk[] {
  const lines: string[] = [];
  for (const l of splitLines(oldText)) lines.push(`-${l}`);
  for (const l of splitLines(newText)) lines.push(`+${l}`);
  return [{ oldStart: 1, oldLines: countLines(oldText), newStart: 1, newLines: countLines(newText), lines }];
}

/**
 * 计算 hunk。用 jsdiff 的 structuredPatch(与 dsh 同一个库、同一套参数:context 3 + 超时),
 * 超时或异常时退化为粗粒度单 hunk。
 */
export function computeHunks(oldText: string, newText: string): { hunks: WorkspaceDiffHunk[]; coarse: boolean } {
  if (oldText === newText) return { hunks: [], coarse: false };
  try {
    const patch = structuredPatch('', '', oldText, newText, '', '', { context: CONTEXT_LINES, timeout: DIFF_TIMEOUT_MS });
    if (!patch || !Array.isArray(patch.hunks)) return { hunks: coarseHunks(oldText, newText), coarse: true };
    return {
      hunks: patch.hunks.map((h) => ({
        oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: [...h.lines]
      })),
      coarse: false
    };
  } catch {
    return { hunks: coarseHunks(oldText, newText), coarse: true };
  }
}

/** 测试用:清掉内存态(磁盘由测试自己的 DATA_DIR 隔离) */
export function _resetChangesForTest(): void {
  turns.clear();
  loaded.clear();
}
