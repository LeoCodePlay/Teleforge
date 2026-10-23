// 「生图模型商」配置持久化(独立于对话所用的 AI 提供商):
// - 用户可以像「AI 配置 → 我的提供商」那样添加多条图像端点,并点选其中一条为「使用中」;
//   generate_image 工具与生图端点解析只走 active 的那一条。
// - 每个模型商可配多个 API Key(首位为主 Key,apiKey 镜像首项),某个 Key 被上游判为
//   余额不足 / 鉴权失败时自动轮换到下一个,并把判定写回这里(界面可展示、可重置)。
// - 旧版本只有 settings.json 里的一条 imageTool:首次加载本文件时自动迁移为列表第一条
//   并设为使用中,原 settings.json 保留不删(降级回旧版本时仍可用)。
// - 落盘 data/image-providers.json(测试可注入 DATA_DIR 隔离目录),原子写防损坏。
import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_PROVIDERS_FILE } from '../config.ts';
import { writeFileAtomic } from './atomic-write.ts';
import {
  IMAGE_DIALECTS,
  getImageToolConfig,
  IMAGE_QUALITIES,
  IMAGE_SIZES,
  type ImageDialect,
  type ImageQuality,
  type ImageToolConfig
} from './settings-store.ts';
import { normalizeKeys, type KeyState } from './ai-providers-store.ts';

/** 一条生图模型商配置:在单条 imageTool 配置之上补 id/名称与多 Key 状态 */
export interface ImageProvider extends ImageToolConfig {
  id: string;
  name: string;
  /** 完整 Key 列表(权威);apiKey 始终镜像 apiKeys[0] */
  apiKeys: string[];
  /** 每个 Key 的运行状态(余额不足 / 鉴权失败),key = API Key 本身 */
  keyStates?: Record<string, KeyState>;
}

interface ImageProvidersFile {
  version: 1;
  /** 当前「使用中」的模型商 id;列表为空或 id 失效时,读取方回落到第一条 */
  activeId: string;
  providers: ImageProvider[];
}

let state: ImageProvidersFile | null = null; // 懒加载缓存

function newId(): string {
  return 'img_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 迁移时的默认名称:用端点域名,避免卡片上一片「未命名」 */
function providerName(baseUrl: string): string {
  try { return new URL(baseUrl).host; } catch { return '默认生图模型商'; }
}

function sanitizeQuality(v: unknown): ImageQuality {
  const s = String(v ?? '');
  return IMAGE_QUALITIES.includes(s) ? s as ImageQuality : 'auto';
}

function sanitizeSize(v: unknown): string {
  const s = String(v ?? '');
  return IMAGE_SIZES.includes(s) ? s : 'auto';
}

function sanitizeDialect(v: unknown): ImageDialect {
  const s = String(v ?? '');
  return IMAGE_DIALECTS.includes(s) ? s as ImageDialect : 'auto';
}

/** 只保留仍存在的 Key 的状态,防「删掉又加回来」时旧的「无余额」标记复活 */
function cleanKeyStates(raw: unknown, keys: string[]): Record<string, KeyState> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, KeyState> = {};
  for (const k of keys) {
    const v = (raw as Record<string, any>)[k];
    if (!v || typeof v !== 'object') continue;
    const e: KeyState = {};
    if (v.exhausted === true) e.exhausted = true;
    if (v.invalid === true) e.invalid = true;
    if (typeof v.reason === 'string' && v.reason) e.reason = v.reason.slice(0, 300);
    if (Number.isFinite(Number(v.at)) && Number(v.at) > 0) e.at = Math.floor(Number(v.at));
    if (Object.keys(e).length) out[k] = e;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 解析一条模型商(文件回读与新增/更新共用);缺必备字段返回 null */
function readProvider(raw: unknown): ImageProvider | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, any>;
  const baseUrl = String(r.baseUrl ?? '').trim().replace(/\/+$/, '');
  const model = String(r.model ?? '').trim();
  // 端点与模型名缺一不可:没有它们的条目无法工作,按"未配置"处理
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl) || !model) return null;
  const keys = normalizeKeys(
    String(r.apiKey ?? ''),
    Array.isArray(r.apiKeys) ? r.apiKeys.map((k) => String(k ?? '')) : undefined
  );
  const keyStates = cleanKeyStates(r.keyStates, keys);
  return {
    id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : newId(),
    name: String(r.name ?? '').trim() || providerName(baseUrl),
    baseUrl,
    apiKey: keys[0] || '',
    apiKeys: keys,
    ...(keyStates ? { keyStates } : {}),
    model,
    quality: sanitizeQuality(r.quality),
    size: sanitizeSize(r.size),
    dialect: sanitizeDialect(r.dialect)
  };
}

export function imageKeys(p: ImageProvider): string[] {
  return normalizeKeys(p.apiKey, p.apiKeys);
}

/** 当前可轮询的 Key:排除已标记不可用(余额不足 / 鉴权失败)的。
 *  全部被标记时返回空数组,调用方据此给出「全部 Key 都不可用」的可操作提示。 */
export function usableImageKeys(p: ImageProvider): string[] {
  return imageKeys(p).filter((k) => {
    const st = p.keyStates?.[k];
    return st?.exhausted !== true && st?.invalid !== true;
  });
}

function normalizeFile(raw: any): ImageProvidersFile {
  const providers: ImageProvider[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw?.providers) ? raw.providers : []) {
    const p = readProvider(item);
    if (!p) continue;
    // 手工改坏文件导致 id 重复时补一个新 id,避免切换/删除命中错条目
    if (seen.has(p.id)) p.id = newId();
    seen.add(p.id);
    providers.push(p);
  }
  const wanted = typeof raw?.activeId === 'string' ? raw.activeId : '';
  const activeId = providers.some((p) => p.id === wanted) ? wanted : (providers[0]?.id || '');
  return { version: 1, activeId, providers };
}

/** 旧版单条 imageTool → 列表第一条(使用中) */
function migrateLegacy(): ImageProvidersFile {
  const legacy = getImageToolConfig();
  if (!legacy) return { version: 1, activeId: '', providers: [] };
  const keys = normalizeKeys(legacy.apiKey);
  const p: ImageProvider = {
    id: newId(),
    name: providerName(legacy.baseUrl),
    baseUrl: legacy.baseUrl,
    apiKey: keys[0] || '',
    apiKeys: keys,
    model: legacy.model,
    quality: legacy.quality,
    size: legacy.size,
    dialect: legacy.dialect
  };
  return { version: 1, activeId: p.id, providers: [p] };
}

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(IMAGE_PROVIDERS_FILE), { recursive: true });
    writeFileAtomic(IMAGE_PROVIDERS_FILE, JSON.stringify(state, null, 2));
  } catch (e: any) {
    console.error('保存生图模型商配置失败:', e?.message || e);
  }
}

function load(): ImageProvidersFile {
  if (state) return state;
  if (fs.existsSync(IMAGE_PROVIDERS_FILE)) {
    try {
      state = normalizeFile(JSON.parse(fs.readFileSync(IMAGE_PROVIDERS_FILE, 'utf8')));
    } catch {
      state = { version: 1, activeId: '', providers: [] };
    }
    return state;
  }
  // 首次运行 / 从旧版本升级:迁移 settings.json 里的单条生图配置。
  // 即使没有旧配置也落一份空文件 —— 否则用户删空列表后,下次启动又会把旧配置迁回来。
  state = migrateLegacy();
  persist();
  return state;
}

/** 生效的使用中 id:stored 失效时回落到第一条,保证界面高亮与服务端实际使用一致 */
function effectiveActiveId(s: ImageProvidersFile): string {
  return s.providers.some((p) => p.id === s.activeId) ? s.activeId : (s.providers[0]?.id || '');
}

export const imageProviders = {
  list(): ImageProvider[] { return load().providers.slice(); },

  /** 当前使用中的 id(已校正:失效 id 回落第一条;空列表 = '') */
  activeId(): string { return effectiveActiveId(load()); },

  find(id: string): ImageProvider | undefined {
    return load().providers.find((p) => p.id === id);
  },

  /** 当前使用中的模型商(列表为空 = null) */
  active(): ImageProvider | null {
    const s = load();
    return s.providers.find((p) => p.id === effectiveActiveId(s)) || null;
  },

  /** 新增一条。默认切换为使用中(「保存并使用」);activate=false 用于「复制」这种不抢焦点的场景。
   *  列表原本为空时无论如何都会成为使用中。 */
  add(raw: unknown, opts: { activate?: boolean } = {}): ImageProvider {
    const cfg = readProvider(raw);
    if (!cfg) throw new Error('生图模型商配置不完整:Base URL(需 http(s):// 开头)与模型名均为必填');
    const s = load();
    const hadActive = !!effectiveActiveId(s);
    const p: ImageProvider = { ...cfg, id: newId() };
    // 新条目不继承任何外观状态(复制配置时前端只带 Key,不带 keyStates)
    delete p.keyStates;
    s.providers.push(p);
    if (opts.activate !== false || !hadActive) s.activeId = p.id;
    persist();
    return p;
  },

  /** 更新一条;返回更新后的条目,不存在返回 null。非法字段抛错(由调用方转成 HTTP 400) */
  update(id: string, patch: Record<string, unknown>): ImageProvider | null {
    const s = load();
    const p = s.providers.find((x) => x.id === id);
    if (!p) return null;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('没有可更新的字段');
    const before = JSON.stringify(p);

    if (patch.name !== undefined) {
      const n = String(patch.name ?? '').trim();
      if (!n) throw new Error('模型商名称不能为空');
      p.name = n;
    }
    if (patch.baseUrl !== undefined) {
      const b = String(patch.baseUrl ?? '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(b)) throw new Error('Base URL 需以 http:// 或 https:// 开头');
      p.baseUrl = b;
    }
    if (patch.model !== undefined) {
      const m = String(patch.model ?? '').trim();
      if (!m) throw new Error('生图模型名不能为空');
      p.model = m;
    }
    if (patch.quality !== undefined) p.quality = sanitizeQuality(patch.quality);
    if (patch.size !== undefined) p.size = sanitizeSize(patch.size);
    if (patch.dialect !== undefined) p.dialect = sanitizeDialect(patch.dialect);
    // apiKeys 是权威列表:给了它就完全以它为准,apiKey 由它派生(不把旧 apiKey 拼回去)
    if (Array.isArray(patch.apiKeys)) {
      const keys = normalizeKeys('', patch.apiKeys.map((k) => String(k ?? '')));
      p.apiKeys = keys;
      p.apiKey = keys[0] || '';
    } else if (typeof patch.apiKey === 'string') {
      // 只给 apiKey(旧调用形态):语义是「单 Key 覆盖」,清掉多 Key 列表
      const keys = normalizeKeys(patch.apiKey);
      p.apiKeys = keys;
      p.apiKey = keys[0] || '';
    }
    const keys = normalizeKeys(p.apiKey, p.apiKeys);
    p.keyStates = cleanKeyStates(p.keyStates, keys);
    if (!p.keyStates) delete p.keyStates;

    // 脏检查后才落盘:persist 是同步写文件,内容没变就只回包
    if (JSON.stringify(p) !== before) persist();
    return p;
  },

  remove(id: string): boolean {
    const s = load();
    const idx = s.providers.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    s.providers.splice(idx, 1);
    // 删掉使用中的那条时自动落到第一条,避免生图突然变成「未配置」
    s.activeId = effectiveActiveId(s);
    persist();
    return true;
  },

  /** 切换使用中;id 不存在返回 false */
  setActive(id: string): boolean {
    const s = load();
    if (!s.providers.some((p) => p.id === id)) return false;
    if (s.activeId !== id) {
      s.activeId = id;
      persist();
    }
    return true;
  },

  /** 标记某 Key 不可用:轮询从此跳过它,直到用户点「重置」。
   *  kind:'balance' = 余额不足(充值后重置),'auth' = 鉴权失败(换掉/修好这个 Key 后重置)。 */
  markKeyExhausted(id: string, key: string, reason?: string, kind: 'balance' | 'auth' = 'balance'): boolean {
    const p = load().providers.find((x) => x.id === id);
    if (!p) return false;
    const k = String(key || '').trim();
    if (!k || !imageKeys(p).includes(k)) return false;
    p.keyStates = { ...(p.keyStates || {}) };
    p.keyStates[k] = kind === 'auth'
      ? { invalid: true, reason: String(reason || '').slice(0, 300), at: Date.now() }
      : { exhausted: true, reason: String(reason || '').slice(0, 300), at: Date.now() };
    persist();
    return true;
  },

  /** 清除某 Key 的不可用标记:充值/换好 Key 后点重置,下次轮询会再次尝试它 */
  resetKey(id: string, key: string): boolean {
    const p = load().providers.find((x) => x.id === id);
    if (!p) return false;
    const k = String(key || '').trim();
    if (p.keyStates?.[k]) {
      delete p.keyStates[k];
      if (Object.keys(p.keyStates).length === 0) delete p.keyStates;
      persist();
    }
    return true;
  },

  /** 清除该模型商全部 Key 的标记 */
  resetAllKeys(id: string): boolean {
    const p = load().providers.find((x) => x.id === id);
    if (!p) return false;
    if (p.keyStates && Object.keys(p.keyStates).length > 0) {
      delete p.keyStates;
      persist();
    }
    return true;
  }
};
