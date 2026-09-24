// 「我的 AI 模型提供商」持久化:用户手动添加/删除的提供商保存在独立的配置文件里。
// 全新安装/首次启动时配置文件不存在 → 初始为空列表,不自动导入任何第三方配置,
// 由用户在界面「AI 配置」里自行添加提供商。
import fs from 'node:fs';
import path from 'node:path';
import { AI_PROVIDERS_FILE as CONFIG_FILE } from '../config.ts';
export { CONFIG_FILE };

/** 单个 API Key 的运行状态(按 Key 字符串索引) */
export interface KeyState {
  /** true = 已判定「余额不足」,自动轮询会跳过它;用户在界面点「重置」后清除 */
  exhausted?: boolean;
  /** 判定原因(网关原文摘要),便于界面展示与排查 */
  reason?: string;
  /** 判定时间(毫秒时间戳) */
  at?: number;
}

export interface AiProvider {
  id: string;
  name: string;
  baseUrl: string;
  /** 主 Key(兼容字段):始终镜像 apiKeys[0];只配一个 Key 时就只有它 */
  apiKey: string;
  /** 同一提供商的多个 API Key(轮询用):某个 Key 余额不足时按此顺序切换到下一个 */
  apiKeys?: string[];
  /** 每个 Key 的状态(余额不足标记等),key = API Key 本身 */
  keyStates?: Record<string, KeyState>;
  models: string[];
  note: string;
  /** 每个模型的能力/参数声明(可选),key = 模型名:
   *  contextWindow 输入窗口、maxTokens 输出上限、multimodal 是否支持图片输入、
   *  imageGen 是否为生图模型(对话改走 /images/generations 与 /images/edits) */
  modelConfig?: Record<string, { contextWindow?: number; maxTokens?: number; multimodal?: boolean; imageGen?: boolean }>;
}

let providers: AiProvider[] | null = null; // 懒加载缓存

function persist() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(providers, null, 2));
  } catch (e: any) {
    console.error('保存 AI 提供商配置失败:', e.message);
  }
}

function load(): AiProvider[] {
  if (providers) return providers;
  if (fs.existsSync(CONFIG_FILE)) {
    try { providers = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch { providers = []; }
  } else {
    providers = []; // 首次运行:无任何预置提供商,等待用户自行添加
    persist();
  }
  if (!Array.isArray(providers)) providers = [];
  return providers;
}

/** 归一化 Key 列表:去空白、去重;主 Key(apiKey)保证在首位且不丢。
 *  旧配置只有单个 apiKey,新配置可能给出 apiKeys —— 两种形态都要能用。 */
export function normalizeKeys(apiKey: string, apiKeys?: string[]): string[] {
  const out: string[] = [];
  const push = (k: unknown) => {
    const s = String(k ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  push(apiKey);
  if (Array.isArray(apiKeys)) apiKeys.forEach(push);
  return out;
}

/** 该提供商当前「可用」的 Key:排除已标记余额不足的。
 *  全部都被标记时返回空数组,调用方据此判定「所有 Key 都没余额了」并停止重试。 */
export function usableKeys(p: AiProvider): string[] {
  return normalizeKeys(p.apiKey, p.apiKeys).filter((k) => p.keyStates?.[k]?.exhausted !== true);
}

/** 用一份权威 Key 列表覆盖 p:apiKey 镜像首项,并清掉已从列表中删除的 Key 残留的状态
 *  (避免「删掉又加回来」时旧的「无余额」标记复活)。 */
function applyKeys(p: AiProvider, keys: string[]): string[] {
  p.apiKeys = keys;
  p.apiKey = keys[0] || '';
  if (p.keyStates) {
    for (const k of Object.keys(p.keyStates)) if (!keys.includes(k)) delete p.keyStates[k];
  }
  return keys;
}

/** 把 apiKeys / apiKey 两个字段对齐:apiKeys 是权威列表,apiKey 镜像首项。
 *  这里把 apiKey 当作「输入」,因此只用于新增/单 Key 覆盖这类没有权威列表的场景。 */
function alignKeys(p: AiProvider): string[] {
  return applyKeys(p, normalizeKeys(p.apiKey, p.apiKeys));
}

export const aiProviders = {
  list(): AiProvider[] { return load().slice(); },
  find(id: string): AiProvider | undefined { return load().find((x) => x.id === id); },
  add(entry: AiProvider): AiProvider {
    alignKeys(entry); // 入库前统一 Key 形态,避免 apiKey 与 apiKeys 不一致
    load().push(entry);
    persist();
    return entry;
  },
  update(id: string, patch: Partial<AiProvider>): boolean {
    const p = load().find((x) => x.id === id);
    if (!p) return false;
    // apiKeys 是权威列表:给了它就完全以它为准,apiKey 由它派生。
    // 这里必须「不把旧 apiKey 拼回去」——否则删掉某个 Key 后,残留的 apiKey 会把它复活。
    if (Array.isArray(patch.apiKeys)) {
      Object.assign(p, patch);
      applyKeys(p, normalizeKeys('', patch.apiKeys));
    } else if (patch.apiKey !== undefined) {
      // 只给 apiKey(旧的单 Key 编辑路径):语义是「单 Key 覆盖」,清掉多 Key 列表
      Object.assign(p, patch);
      p.apiKeys = undefined;
      alignKeys(p);
    } else {
      Object.assign(p, patch);
    }
    persist();
    return true;
  },
  remove(id: string): boolean {
    const list = load();
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    persist();
    return true;
  },
  /** 标记某 Key 余额不足:自动轮询从此跳过它,直到用户点「重置」 */
  markKeyExhausted(id: string, key: string, reason?: string): boolean {
    const p = load().find((x) => x.id === id);
    if (!p) return false;
    const k = String(key || '').trim();
    if (!k) return false;
    p.keyStates = { ...(p.keyStates || {}) };
    p.keyStates[k] = { exhausted: true, reason: String(reason || '').slice(0, 300), at: Date.now() };
    persist();
    return true;
  },
  /** 清除某 Key 的「无余额」标记:充值后点重置,下次轮询会再次尝试它 */
  resetKey(id: string, key: string): boolean {
    const p = load().find((x) => x.id === id);
    if (!p) return false;
    const k = String(key || '').trim();
    if (p.keyStates?.[k]) {
      delete p.keyStates[k];
      persist();
    }
    return true;
  },
  /** 清除该提供商全部 Key 的标记 */
  resetAllKeys(id: string): boolean {
    const p = load().find((x) => x.id === id);
    if (!p) return false;
    p.keyStates = {};
    persist();
    return true;
  }
};
