// 对话历史持久化:Agent 跨轮记忆落盘到 server/data/chat-history.json
// - 零依赖(Node 内置 fs),原子写(临时文件 + rename)防损坏
// - 数据量受 AGENT.HISTORY_BUDGET_CHARS 约束,量小,整文件覆盖即可
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'chat-history.json');

// 确保数据目录存在(避免首写时因目录缺失而失败)
fs.mkdirSync(DATA_DIR, { recursive: true });

// 兜底上限:防止磁盘文件被外部改大(如手动编辑),加载时只取尾部
const MAX_TURNS = 2000;

function read() {
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch { return []; }
  try {
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.turns)) return [];
    return j.turns.length <= MAX_TURNS ? j.turns : j.turns.slice(-MAX_TURNS);
  } catch { return []; }
}

function write(turns) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const body = JSON.stringify({ version: 1, ts: Date.now(), turns });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, FILE);
}

/** 加载历史(失败静默返回空,避免磁盘异常拖垮启动) */
export function loadHistory() {
  return read();
}

/** 保存整份历史(agent 每次收尾调用) */
export function saveHistory(turns) {
  try {
    write(Array.isArray(turns) ? turns : []);
  } catch (e) {
    console.error('[history] 保存失败:', e.message);
  }
}

/** 清空历史 */
export function clearHistoryStore() {
  try {
    write([]);
  } catch (e) {
    console.error('[history] 清空失败:', e.message);
  }
}