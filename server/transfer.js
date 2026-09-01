// 本地↔远程双向传输:复用 local-fs 与 ssh-manager,带逐项进度回调。
import path from 'node:path';
import { localFs } from './local-fs.js';
import { sshManager as ssh, normalizeRemote, joinRemote } from './ssh-manager.js';

// 递归枚举本地路径 -> [{rel, abs, type, size}]
async function collectLocalPaths(roots, baseDir) {
  const out = [];
  const walk = async (dir, rel) => {
    for (const e of await localFs.listDir(dir)) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.type === 'dir') { out.push({ rel: relPath + '/', abs, type: 'dir', size: 0 }); await walk(abs, relPath); }
      else out.push({ rel: relPath, abs, type: 'file', size: e.size || 0 });
    }
  };
  for (const root of roots) {
    const abs = path.resolve(root);
    const type = await localFs.atype(abs);
    if (!type) continue;
    const rel = path.basename(abs);
    if (type === 'dir') { out.push({ rel: rel + '/', abs, type: 'dir', size: 0 }); await walk(abs, rel); }
    else out.push({ rel, abs, type: 'file', size: (await localFs.stat(abs))?.size || 0 });
  }
  return out;
}

// 本地 -> 远程
export async function localToRemote(paths, remoteDir, { onProgress } = {}) {
  const base = normalizeRemote(remoteDir || ssh.workspace || '');
  if (!base) throw new Error('请先选择远程工作区或指定目标目录');
  const entries = await collectLocalPaths(paths);
  // 为每个文件预建其远程父目录(去重后按深度从小到大排,避免逐文件重复探测)
  const parentDirs = new Set();
  for (const e of entries) {
    if (e.type === 'file') {
      const target = joinRemote(base, e.rel);
      parentDirs.add(target.slice(0, target.lastIndexOf('/')) || '/');
    }
  }
  for (const d of [...parentDirs].sort((a, b) => a.split('/').length - b.split('/').length)) await ssh.mkdirp(d);
  let uploaded = 0, bytes = 0; const errors = [];
  const total = entries.filter((e) => e.type === 'file').length;
  for (const e of entries) {
    if (e.type === 'dir') continue;
    const target = joinRemote(base, e.rel);
    try {
      const buf = (await localFs.readFileChunk(e.abs, { maxBytes: 0 })).buffer;
      await ssh.writeRemoteFile(target, buf, { maxBytes: 0, mkdir: false });
      uploaded++; bytes += buf.length;
    } catch (err) { errors.push(`${e.rel}: ${err.message}`); }
    onProgress?.({ done: uploaded, total, current: e.rel });
  }
  return { uploaded, failed: errors.length, bytes, errors: errors.slice(0, 20) };
}

// 远程 -> 本地
export async function remoteToLocal(paths, localDir, { onProgress } = {}) {
  const base = path.resolve(localDir || localFs.workspace || '.');
  await localFs.mkdirp(base);
  let downloaded = 0, bytes = 0; const errors = [];
  const walkRemote = async (remotePath, rel) => {
    const type = await ssh.atype(remotePath);
    if (!type) { errors.push(`${remotePath}: 不存在`); return; }
    try {
      if (type === 'dir') {
        const target = path.join(base, rel);
        await localFs.mkdirp(target);
        const list = await ssh.listDir(remotePath);
        for (const e of list) await walkRemote(joinRemote(remotePath, e.name), path.join(rel, e.name));
      } else {
        const { buffer } = await ssh.readFileChunk(remotePath, { maxBytes: 0 });
        const target = path.join(base, rel);
        await localFs.writeFile(target, buffer, { maxBytes: 0 });
        downloaded++; bytes += buffer.length;
        onProgress?.({ done: downloaded, total: 1, current: rel });
      }
    } catch (err) {
      // 单个条目失败(如非法 NTFS 文件名)不中断整体传输:记录错误后继续
      errors.push(`${rel}: ${err.message}`);
    }
  };
  for (const p of paths) {
    const name = normalizeRemote(p).split('/').filter(Boolean).pop() || 'item';
    await walkRemote(normalizeRemote(p), name);
  }
  return { downloaded, failed: errors.length, bytes, errors: errors.slice(0, 20) };
}