// 「LLM 选择级配置」持久化:当前选中的提供方、各提供方上次使用的模型、自定义模型名、
// 各提供方 Key、各模型单轮最大工具迭代次数。与 ai-providers.json(提供方清单)分开存放,
// 避免把「选择状态」和「提供方实体」混在一个文件里。
// 首次运行不存在配置文件时返回默认空态,之后随前端 PATCH 落盘。
// 默认存 server/data/ui-state.json(已被 .gitignore 忽略,含 API Key,不做版本入库);可用环境变量覆盖路径。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UI_STATE_FILE = process.env.UI_STATE_FILE || path.join(__dirname, 'data', 'ui-state.json');

function empty() {
  return { providerId: '', customModel: '', models: {}, keys: {}, maxIters: {} };
}

let state = null; // 懒加载缓存

function persist() {
  try {
    fs.mkdirSync(path.dirname(UI_STATE_FILE), { recursive: true });
    fs.writeFileSync(UI_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('保存 UI 状态失败:', e.message);
  }
}

function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(UI_STATE_FILE, 'utf8'));
  } catch {
    state = null;
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = empty();
  // 归一化字段,防止历史/损坏数据导致前端崩溃
  if (typeof state.providerId !== 'string') state.providerId = '';
  if (typeof state.customModel !== 'string') state.customModel = '';
  if (!state.models || typeof state.models !== 'object' || Array.isArray(state.models)) state.models = {};
  if (!state.keys || typeof state.keys !== 'object' || Array.isArray(state.keys)) state.keys = {};
  if (!state.maxIters || typeof state.maxIters !== 'object' || Array.isArray(state.maxIters)) state.maxIters = {};
  return state;
}

export const uiState = {
  get() { return load(); },
  // 深度浅合并:models/keys/maxIters 按提供方 id 逐层覆盖;空字符串值表示删除该键
  patch(p = {}) {
    const s = load();
    if (typeof p.providerId === 'string') s.providerId = p.providerId;
    if (typeof p.customModel === 'string') s.customModel = p.customModel;
    for (const [pid, model] of Object.entries(p.models || {})) {
      if (model) s.models[pid] = String(model);
      else delete s.models[pid];
    }
    for (const [pid, key] of Object.entries(p.keys || {})) {
      if (key) s.keys[pid] = String(key);
      else delete s.keys[pid];
    }
    for (const [pid, iters] of Object.entries(p.maxIters || {})) {
      if (iters && typeof iters === 'object' && !Array.isArray(iters)) {
        const inner = s.maxIters[pid] && typeof s.maxIters[pid] === 'object' && !Array.isArray(s.maxIters[pid])
          ? s.maxIters[pid]
          : (s.maxIters[pid] = {});
        for (const [model, v] of Object.entries(iters)) {
          if (v) inner[model] = String(v);
          else delete inner[model];
        }
        if (Object.keys(inner).length === 0) delete s.maxIters[pid]; // 内层清空后移除整条
      } else {
        delete s.maxIters[pid];
      }
    }
    persist();
    return s;
  },
  // 删除某个提供方的所有选择状态(供删除提供方时联动清理)
  remove(pid) {
    const s = load();
    delete s.models[pid];
    delete s.keys[pid];
    delete s.maxIters[pid];
    persist();
  }
};
