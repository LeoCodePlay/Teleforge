// 工具插件启用/禁用持久化(设置 → 工具插件):
// 参照 deepseek-harness 的插件可配置启停(cordis 插件禁用配置)——被禁用的工具
// 不进入 schemas() 投影,模型看不到也无法调用;执行管线同样拒绝,双保险。
// 存储格式:data/agent-tools.json { "disabled": ["write_file", ...] }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = process.env.AGENT_TOOLS_FILE || path.join(__dirname, '..', 'data', 'agent-tools.json');

let state = null; // 懒加载缓存 { disabled: Set<string> }

function persist() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ disabled: [...state.disabled] }, null, 2));
  } catch (e) {
    console.error('保存工具插件配置失败:', e.message);
  }
}

function load() {
  if (state) return state;
  let j = null;
  try { j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* 首次启动无文件 */ }
  const disabled = new Set(
    Array.isArray(j?.disabled) ? j.disabled.map(String).filter(Boolean) : []
  );
  state = { disabled };
  return state;
}

export const toolSettings = {
  /** 工具是否启用(未记录 = 默认启用) */
  isEnabled(name) { return !load().disabled.has(name); },
  /** 已禁用的工具名列表 */
  disabledList() { return [...load().disabled].sort(); },
  /** 启用/禁用一个工具并落盘 */
  setEnabled(name, on) {
    const s = load();
    if (on) s.disabled.delete(name);
    else s.disabled.add(name);
    persist();
    return this.isEnabled(name);
  }
};
