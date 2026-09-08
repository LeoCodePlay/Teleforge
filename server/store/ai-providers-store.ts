// 「我的 AI 模型提供商」持久化:用户手动添加/删除的提供商保存在独立的配置文件里。
// 全新安装/首次启动时配置文件不存在 → 初始为空列表,不自动导入任何第三方配置,
// 由用户在界面「AI 配置」里自行添加提供商。
import fs from 'node:fs';
import path from 'node:path';
import { AI_PROVIDERS_FILE as CONFIG_FILE } from '../config.ts';
export { CONFIG_FILE };

export interface AiProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
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

export const aiProviders = {
  list(): AiProvider[] { return load().slice(); },
  add(entry: AiProvider): AiProvider {
    load().push(entry);
    persist();
    return entry;
  },
  update(id: string, patch: Partial<AiProvider>): boolean {
    const p = load().find((x) => x.id === id);
    if (!p) return false;
    Object.assign(p, patch);
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
  }
};
