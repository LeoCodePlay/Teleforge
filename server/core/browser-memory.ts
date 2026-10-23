// 站点经验(learnings):把"这个站该怎么点"沉淀下来,下次不用重新摸索。
//
// 为什么要它:每次 browser_open 都要重新快照、重新找按钮,模型每次都在同一个页面上花同样的
// token 做同样的推理。ego(lite) 用 learnings/ 目录解决这个;这里做最小可用版 ——
// 按域名存一条短笔记(可带 loc/选择器),下次打开该域名时作为提示回给模型。
//
// 只做提示,不做自动重放:选择器失效是常态,自动照搬比重找更危险。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.ts';

const FILE = path.join(DATA_DIR, 'browser-learnings.json');
const MAX_PER_HOST = 12;
const MAX_NOTE = 300;

export interface Learning {
  host: string;
  note: string;
  /** 稳定选择器(可选):快照里的 loc= 或用户给的 CSS */
  selector?: string;
  createdAt: number;
}

type Store = Record<string, Learning[]>;
let cache: Store | null = null;

function load(): Store {
  if (cache) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = j && typeof j === 'object' ? (j as Store) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cache || {}, null, 2));
  } catch (e: any) {
    console.error('保存站点经验失败:', e.message);
  }
}

/** 从 URL 取站点键(域名;同域名不同端口视为同一站) */
export function hostOf(url: unknown): string {
  try {
    const u = new URL(String(url || ''));
    return u.hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 记一条经验(同域名同内容去重,只保留最近 MAX_PER_HOST 条) */
export function rememberLearning(url: string, note: string, selector?: string): Learning {
  const host = hostOf(url);
  if (!host) throw new Error('记经验需要有效的 URL(用来取域名)');
  const text = String(note || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
  if (!text) throw new Error('note 不能为空');
  const store = load();
  const list = store[host] || (store[host] = []);
  const sel = selector ? String(selector).trim().slice(0, 200) : '';
  const dup = list.find((x) => x.note === text && (x.selector || '') === sel);
  if (dup) return dup;
  const item: Learning = { host, note: text, selector: sel || undefined, createdAt: Date.now() };
  list.push(item);
  while (list.length > MAX_PER_HOST) list.shift();
  persist();
  return item;
}

export function listLearnings(url: string): Learning[] {
  const host = hostOf(url);
  if (!host) return [];
  return [...(load()[host] || [])];
}

export function forgetLearning(url: string, notePart: string): number {
  const host = hostOf(url);
  const store = load();
  const list = store[host] || [];
  const before = list.length;
  const needle = String(notePart || '').trim();
  store[host] = needle ? list.filter((x) => !x.note.includes(needle)) : [];
  persist();
  return before - store[host].length;
}

/**
 * 给模型的提示块:最多 3 条、每条一行。
 * 只提示"这个站上曾经这样做成过",并明确告诉模型选择器可能过期 —— 否则模型会盲信旧选择器。
 */
export function learningHint(url: string, limit = 3): string {
  const list = listLearnings(url).slice(-limit);
  if (!list.length) return '';
  const lines = list.map((x) => `- ${x.note}${x.selector ? `(选择器 ${x.selector})` : ''}`);
  return `\n\n本站经验(可能过期,操作前先确认元素还在):\n${lines.join('\n')}`;
}
