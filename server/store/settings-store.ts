// 全局设置持久化(与会话存储分开,作用域为整台服务器/工作区,而非单个会话):
// - 目前只有一项:默认访问权限模式(defaultPermissionMode)。用户任意会话里
//   permission_set 的档位会同步到这里,新会话继承该默认值(见 agent.ts 的
//   getPermissionMode / permission.ts 的 foldPermissionMode fallback)。
// - 落盘 data/settings.json(测试可注入 DATA_DIR 隔离目录),原子写防损坏。
import fs from 'node:fs';
import { DATA_DIR, SETTINGS_FILE } from '../config.ts';

// 与 permission.ts 的 PERMISSION_MODES 保持一致(此处不复用 import,避免
// permission.ts -> settings-store.ts 的循环依赖)
const VALID_MODES = new Set(['confirm', 'auto-edit', 'plan', 'full-access']);

function readSettings(): any {
  let j: any;
  try { j = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { j = null; }
  return j && typeof j === 'object' ? j : {};
}

function writeSettings(s: { defaultPermissionMode: string }) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const body = JSON.stringify({ version: 1, defaultPermissionMode: s.defaultPermissionMode }, null, 0);
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
}

/** 全局默认访问权限模式(新会话继承;未设置/脏数据回落 'confirm') */
export function getDefaultPermissionMode(): string {
  const m = readSettings().defaultPermissionMode;
  return VALID_MODES.has(m) ? m : 'confirm';
}

/** 持久化全局默认访问权限模式(调用方已校验模式值) */
export function setDefaultPermissionMode(mode: string): void {
  writeSettings({ defaultPermissionMode: VALID_MODES.has(mode) ? mode : 'confirm' });
}
