// 真机/预览浏览器操作审计:谁在什么页面做了什么,失败也要记。
//
// 为什么必须有:把用户的登录态浏览器交给 AI,出问题时"它到底点了什么"必须可查。
// 写法上刻意保守:
//   - 只记方法名、目标(ref/选择器)、URL、标签 id、结果;__不记输入的具体文本__,只记长度;
//   - JSONL 追加写,超过 2MB 轮转一份 .1,不会把磁盘写满;
//   - 写失败只打日志,绝不影响浏览器操作本身(审计不该成为可用性单点)。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.ts';

const FILE = path.join(DATA_DIR, 'browser-audit.log');
const MAX_BYTES = 2 * 1024 * 1024;

export interface AuditEntry {
  backend: 'native' | 'preview';
  /** 工具名,如 browser_click / browser_batch */
  tool: string;
  tabId?: number | null;
  url?: string;
  target?: string;
  ok: boolean;
  ms?: number;
  /** 失败原因(截断) */
  error?: string;
  /** 输入文本长度(不记内容) */
  textLen?: number;
  steps?: number;
}

function rotateIfNeeded(): void {
  try {
    const st = fs.statSync(FILE);
    if (st.size > MAX_BYTES) fs.renameSync(FILE, FILE + '.1');
  } catch { /* 文件不存在或没权限:下一次写会重建 */ }
}

export function auditBrowser(entry: AuditEntry): void {
  try {
    rotateIfNeeded();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
  } catch (e: any) {
    console.error('写浏览器审计日志失败:', e?.message || e);
  }
}

/** 读最近 N 条(前端/排错用;不暴露给模型工具,避免把日志塞进上下文) */
export function readAudit(limit = 100): AuditEntry[] {
  const n = Math.max(1, Math.min(Number(limit) || 100, 1000));
  try {
    const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n');
    return lines.slice(-n).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean) as AuditEntry[];
  } catch {
    return [];
  }
}
