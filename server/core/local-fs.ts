// 本地文件系统适配层:与 ssh-manager 的 SFTP 方法签名对齐,底层用 Node fs/path。
// 供 Agent 本地工具、WS 本地浏览/读写、双向传输共用;持有 localWorkspace 状态。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FILE } from '../config.ts';

export interface FsEntry {
  name: string;
  type: 'dir' | 'file' | 'link';
  size: number;
  mtime: number;
}

export interface ChunkReadResult {
  buffer: Buffer;
  size: number;
  truncated: boolean;
}

export class LocalFs {
  workspace: string | null = null; // 用户选择的本地工作区绝对路径(可空)
  get home() { return os.homedir(); }

  async listDir(p: string): Promise<FsEntry[]> {
    // 空串/root: 表示"我的电脑"根视图(Windows 列出盘符,POSIX 列出根)
    let raw = String(p ?? '');
    if (raw === '' || raw === 'root:') return listRoots();
    // Windows 盘符根归一:'C:'(无尾斜杠)在 path.resolve 时表示该盘"当前工作目录",
    // 而不是盘根——比如服务 cwd 在 F:\...\server 时,path.resolve('F:') 会解析成它。
    // 统一补成 'C:\' 形式,保证盘符双击/输入都落到盘根。
    const drive = /^([A-Za-z]):[\\/]?$/.exec(raw);
    if (drive) raw = drive[1] + ':\\';
    const abs = path.resolve(raw || this.workspace || this.home || '.');
    const dirents = await fsp.readdir(abs, { withFileTypes: true });
    const entries: FsEntry[] = [];
    for (const d of dirents) {
      const full = path.join(abs, d.name);
      let st; try { st = await fsp.lstat(full); } catch { continue; }
      const type = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file';
      entries.push({ name: d.name, type, size: st.size || 0, mtime: st.mtimeMs || 0 });
    }
    return entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
  }

  async stat(p: string): Promise<fs.Stats | null> {
    // 与 listDir 一致:Windows 裸盘符 'C:' 归一为 'C:\',避免解析成该盘当前工作目录
    const dm = /^([A-Za-z]):[\\/]?$/.exec(String(p ?? ''));
    const resolved = dm ? dm[1] + ':\\' : p;
    try { return await fsp.stat(path.resolve(resolved)); }
    catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
  }

  async readFileChunk(p: string, { maxBytes = FILE.READ_MAX_BYTES, offset = 0 }: { maxBytes?: number; offset?: number } = {}): Promise<ChunkReadResult> {
    const abs = path.resolve(p);
    const st = await this.stat(abs);
    if (!st) throw new Error(`文件不存在: ${abs}`);
    if (st.isDirectory()) throw new Error(`是目录: ${abs}`);
    const fh = await fsp.open(abs, 'r');
    try {
      // maxBytes 0 表示不限制(整文件读取,供批量传输用),否则按上限截取
      const want = maxBytes > 0 ? Math.min(maxBytes, Math.max(0, st.size - offset)) : Math.max(0, st.size - offset);
      const buf = Buffer.alloc(want);
      // 部分读不保证单次读满,循环直到读完 want 字节(与 ssh-manager.readFileChunk 对齐)
      let got = 0;
      while (got < want) {
        const { bytesRead } = await fh.read(buf, got, want - got, offset + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return { buffer: buf.subarray(0, got), size: st.size, truncated: offset + got < st.size };
    } finally { await fh.close(); }
  }

  async writeFile(p: string, content: string | Buffer, { maxBytes = FILE.WRITE_MAX_BYTES, mkdir = true }: { maxBytes?: number; mkdir?: boolean } = {}): Promise<number> {
    const abs = path.resolve(p);
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (maxBytes && buf.length > maxBytes) throw new Error(`文件过大(>${Math.round(maxBytes / 1024 / 1024)}MB): ${abs}`);
    if (mkdir) await this.mkdirp(path.dirname(abs));
    await fsp.writeFile(abs, buf);
    return buf.length;
  }

  async mkdirp(p: string): Promise<void> { await fsp.mkdir(path.resolve(p), { recursive: true }); }

  async rmdirRecursive(p: string, onProgress?: (cur: string) => void): Promise<void> {
    p = path.resolve(p);
    const type = await this.atype(p);
    if (!type) return;
    if (type === 'file' || type === 'link') { await fsp.rm(p, { force: true }); onProgress?.(p); return; }
    const entries = await fsp.readdir(p, { withFileTypes: true });
    for (const e of entries) await this.rmdirRecursive(path.join(p, e.name), onProgress);
    await fsp.rmdir(p);
    onProgress?.(p);
  }

  async copyPath(src: string, dst: string, { overwrite = false }: { overwrite?: boolean } = {}): Promise<{ src: string; dst: string }> {
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
  async _copyDir(src: string, dst: string): Promise<void> {
    for (const e of await this.listDir(src)) {
      const sp = path.join(src, e.name), dp = path.join(dst, e.name);
      if (e.type === 'dir') { await fsp.mkdir(dp, { recursive: true }); await this._copyDir(sp, dp); }
      else await fsp.copyFile(sp, dp);
    }
  }

  // 重命名(原子 rename);目标已存在时报错,不静默覆盖
  async renamePath(src: string, dst: string): Promise<{ src: string; dst: string }> {
    src = path.resolve(src); dst = path.resolve(dst);
    if (src === dst) throw new Error('新名称与旧名称相同');
    if (!(await this.atype(src))) throw new Error(`源不存在: ${src}`);
    if (await this.atype(dst)) throw new Error(`目标已存在: ${dst}`);
    await fsp.rename(src, dst);
    return { src, dst };
  }

  async atype(p: string): Promise<'dir' | 'file' | 'link' | null> {
    try {
      const a = await fsp.lstat(path.resolve(p));
      return a.isDirectory() ? 'dir' : a.isSymbolicLink() ? 'link' : 'file';
    } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
  }

  isProbablyBinary(buf: Buffer | null): boolean {
    if (!buf) return false;
    const n = Math.min(buf.length, FILE.DISCARD_BYTES);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  }
}

export const localFs = new LocalFs();

// "我的电脑"根视图:Windows 枚举所有存在的盘符(如 C:\) ,POSIX 返回根 /
export async function listRoots(): Promise<FsEntry[]> {
  if (process.platform === 'win32') {
    const drives: FsEntry[] = [];
    for (let c = 65; c <= 90; c++) {
      const d = String.fromCharCode(c) + ':\\';
      try { if (fs.existsSync(d)) drives.push({ name: d, type: 'dir', size: 0, mtime: 0 }); } catch {}
    }
    return drives;
  }
  return [{ name: '/', type: 'dir', size: 0, mtime: 0 }];
}

// 把路径解析到本地工作区内;越界/未设工作区报错(与远程 resolveInWorkspace 对称)
export function resolveInLocalWorkspace(p: string, { allowRoot = true }: { allowRoot?: boolean } = {}): string {
  const ws = localFs.workspace;
  if (!ws) throw new Error('尚未选择本地工作区,请先在界面中选择本地目录作为本地工作区');
  const wsAbs = path.resolve(ws);
  const raw = String(p || '.').trim();
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(wsAbs, raw);
  if (abs === wsAbs) return wsAbs;
  if (abs.startsWith(wsAbs + path.sep)) return abs;
  throw new Error(`路径超出本地工作区,被拒绝: ${p}`);
}
