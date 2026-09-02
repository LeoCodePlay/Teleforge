// 「我的 AI 模型提供商」持久化:用户手动添加/删除的提供商保存在独立的配置文件里。
// 首次启动若配置文件不存在,自动把本机 openclaw(~/.openclaw/openclaw.json)里已配置的
// 模型提供商作为种子写入,之后用户可在此基础上手动增删,不再依赖 openclaw 导入按钮。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 默认存 server/data/ (已被 .gitignore 忽略,含 API Key,不做版本入库);可用环境变量覆盖路径
export const CONFIG_FILE = process.env.AI_PROVIDERS_FILE || path.join(__dirname, 'data', 'ai-providers.json');

export interface AiProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  note: string;
}

// 读取 openclaw 配置里的模型提供商,作为首次启动的种子数据
function seedFromOpenclaw(): AiProvider[] {
  const p = path.join(os.homedir(), '.openclaw', 'openclaw.json');
  let j: any;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
  const providersRaw: Record<string, any> = j.models?.providers || {};
  return Object.entries(providersRaw)
    .filter(([, v]) => v && v.baseUrl && v.apiKey && Array.isArray(v.models) && v.models.length)
    .map(([id, v]) => ({
      id: 'openclaw-' + id,
      name: `${id}(openclaw)`,
      baseUrl: String(v.baseUrl).replace(/\/+$/, ''),
      apiKey: v.apiKey,
      models: v.models.map((m: any) => m.id).filter(Boolean),
      note: '首次启动已从 openclaw 导入'
    }));
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
    providers = seedFromOpenclaw(); // 首次运行:先把 openclaw 的提供商保存进配置文件
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
