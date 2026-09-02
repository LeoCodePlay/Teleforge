// 「SSH 服务器配置」持久化:保存在后端的配置文件里,切换浏览器/刷新页面都能读到同一份配置。
// 与 ai-providers.json 同级存放在 server/data/(已被 .gitignore 忽略,含密码/私钥,不做版本入库)。
// 安全约定:完整字段(含密码/私钥)只存服务端;下发前端时用 toPublic() 剥离密码/私钥,
// 前端仅能看到「是否有密码 / 是否有私钥」的布尔标记。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SSH_PROFILES_FILE = process.env.SSH_PROFILES_FILE || path.join(__dirname, 'data', 'ssh-profiles.json');

let profiles = null; // 懒加载缓存

function persist() {
  try {
    fs.mkdirSync(path.dirname(SSH_PROFILES_FILE), { recursive: true });
    fs.writeFileSync(SSH_PROFILES_FILE, JSON.stringify(profiles, null, 2));
  } catch (e) {
    console.error('保存 SSH 服务器配置失败:', e.message);
  }
}

function load() {
  if (profiles) return profiles;
  if (fs.existsSync(SSH_PROFILES_FILE)) {
    try { profiles = JSON.parse(fs.readFileSync(SSH_PROFILES_FILE, 'utf8')); }
    catch { profiles = []; }
  } else {
    profiles = [];
  }
  if (!Array.isArray(profiles)) profiles = [];
  return profiles;
}

function newId() {
  return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 规范化一条配置(trim 字段,补默认值);非法配置返回 null
export function sanitizeProfile(p = {}) {
  const host = String(p.host || '').trim();
  const username = String(p.username || p.user || '').trim();
  if (!host || !username) return null;
  const authType = p.authType === 'key' ? 'key' : 'password';
  return {
    id: String(p.id || '').trim() || newId(),
    name: String(p.name || '').trim() || `${username}@${host}`,
    host,
    port: String(p.port || '').trim() || '22',
    username,
    authType,
    password: authType === 'password' ? String(p.password || '') : '',
    keyText: authType === 'key' ? String(p.keyText || '') : '',
    keyPath: authType === 'key' ? String(p.keyPath || '').trim() : '',
    passphrase: authType === 'key' ? String(p.passphrase || '') : '',
    autoReconnect: p.autoReconnect !== false,
    updatedAt: Date.now()
  };
}

// 下发给前端的公开视图:剥掉密码/私钥内容,只留标记
export function toPublic(p) {
  return {
    id: p.id,
    name: p.name,
    host: p.host,
    port: p.port,
    username: p.username,
    authType: p.authType,
    keyPath: p.keyPath,
    autoReconnect: p.autoReconnect,
    hasPassword: !!p.password,
    hasKey: !!p.keyText
  };
}

export const sshProfiles = {
  list() {
    return load().map(toPublic);
  },
  // 服务端内部使用(连接时取完整认证信息)
  get(id) {
    return load().find((x) => x.id === id) || null;
  },
  upsert(entry) {
    const list = load();
    const idx = list.findIndex((x) => x.id === entry.id);
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    persist();
    return entry;
  },
  remove(id) {
    const list = load();
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    persist();
    return true;
  }
};