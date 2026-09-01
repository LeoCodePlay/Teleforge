// 本地文件系统适配层:与 ssh-manager 的 SFTP 方法签名对齐,底层用 Node fs/path。
// 供 Agent 本地工具、WS 本地浏览/读写、双向传输共用;持有 localWorkspace 状态。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FILE } from './config.js';

export class LocalFs {
  constructor() { this.workspace = null; } // 用户选择的本地工作区绝对路径(可空)
  get home() { return os.homedir(); }

  async listDir(p) {
    const abs = path.resolve(p || this.workspace || this.home || '.');
    const dirents = await fsp.readdir(abs, { withFileTypes: true });
    const entries = [];
    for (const d of dirents) {
      const full = path.join(abs, d.name);
      let st; try { st = await fsp.lstat(full); } catch { continue; }
      const type = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file';
      entries.push({ name: d.name, type, size: st.size || 0, mtime: st.mtimeMs || 0 });
    }
    return entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
  }

  async stat(p) {
    try { return await fsp.stat(path.resolve(p)); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }

  async readFileChunk(p, { maxBytes = FILE.READ_MAX_BYTES, offset = 0 } = {}) {
    const abs = path.resolve(p);
    const st = await this.stat(abs);
    if (!st) throw new Error(`文件不存在: ${abs}`);
    if (st.isDirectory()) throw new Error(`是目录: ${abs}`);
    const fh = await fsp.open(abs, 'r');
    try {
      const want = Math.min(maxBytes, Math.max(0, st.size - offset));
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, offset);
      return { buffer: buf.subarray(0, bytesRead), size: st.size, truncated: offset + bytesRead < st.size };
    } finally { await fh.close(); }
  }

  async writeFile(p, content, { maxBytes = FILE.WRITE_MAX_BYTES, mkdir = true } = {}) {
    const abs = path.resolve(p);
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (maxBytes && buf.length > maxBytes) throw new Error(`文件过大(>${Math.round(maxBytes / 1024 / 1024)}MB): ${abs}`);
    if (mkdir) await this.mkdirp(path.dirname(abs));
    await fsp.writeFile(abs, buf);
    return buf.length;
  }

  async mkdirp(p) { await fsp.mkdir(path.resolve(p), { recursive: true }); }

  async rmdirRecursive(p, onProgress) {
    p = path.resolve(p);
    const type = await this.atype(p);
    if (!type) return;
    if (type === 'file' || type === 'link') { await fsp.rm(p, { force: true }); onProgress?.(p); return; }
    const entries = await fsp.readdir(p, { withFileTypes: true });
    for (const e of entries) await this.rmdirRecursive(path.join(p, e.name), onProgress);
    await fsp.rmdir(p);
    onProgress?.(p);
  }

  async copyPath(src, dst, { overwrite = false } = {}) {
    src = path.resolve(src); dst = path.resolve(dst);
    if (src === dst) throw new Error('源与目标相同');
    if (dst.startsWith(src + path.sep)) throw new Error('不能复制到自身内部');
    const type = await this.atype(src);
    if (!type) throw new Error(`源不存在: ${src}`);
    const dstType = await this.atype(dst);
    if (dstType) {
      if (!overwrite) throw new Error(`目标已存在: ${dst}`);
      await this.rmdirRecursive(dst);
    }
    if (type === 'dir') { await fsp.mkdir(dst, { recursive: true }); await this._copyDir(src, dst); }
    else { await fsp.mkdir(path.dirname(dst), { recursive: true }); await fsp.copyFile(src, dst); }
    return { src, dst };
  }
  async _copyDir(src, dst) {
    for (const e of await this.listDir(src)) {
      const sp = path.join(src, e.name), dp = path.join(dst, e.name);
      if (e.type === 'dir') { await fsp.mkdir(dp, { recursive: true }); await this._copyDir(sp, dp); }
      else await fsp.copyFile(sp, dp);
    }
  }

  async atype(p) {
    try {
      const a = await fsp.lstat(path.resolve(p));
      return a.isDirectory() ? 'dir' : a.isSymbolicLink() ? 'link' : 'file';
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }

  isProbablyBinary(buf) {
    if (!buf) return false;
    const n = Math.min(buf.length, FILE.DISCARD_BYTES);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  }
}

export const localFs = new LocalFs();

// 把路径解析到本地工作区内;越界/未设工作区报错(与远程 resolveInWorkspace 对称)
export function resolveInLocalWorkspace(p, { allowRoot = true } = {}) {
  const ws = localFs.workspace;
  if (!ws) throw new Error('尚未选择本地工作区,请先在界面中选择本地目录作为本地工作区');
  const wsAbs = path.resolve(ws);
  const raw = String(p || '.').trim();
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(wsAbs, raw);
  if (abs === wsAbs) return wsAbs;
  if (abs.startsWith(wsAbs + path.sep)) return abs;
  throw new Error(`路径超出本地工作区,被拒绝: ${p}`);
}
