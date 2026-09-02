// @ts-nocheck
// 远程目录打包 tar.gz(node 内置 zlib,不依赖远程 zip;逐文件流式读取,不整目录进内存)
import { sshManager as ssh, normalizeRemote } from '../ssh-manager.ts';

function tarOctal(n) {
  const s = Math.floor(n).toString(8);
  return '0000000'.slice(s.length) + s + '\0'; // 7 位八进制 + NUL
}
function tarHeader(relPath, { mode, size, mtimeSec, type, linkname = '' }) {
  const buf = Buffer.alloc(512);
  let name = relPath, prefix = '';
  if (Buffer.byteLength(relPath, 'utf8') > 100) { // ustar prefix 拆分
    const parts = relPath.split('/');
    let p = '', rest = relPath;
    while (Buffer.byteLength(rest, 'utf8') > 100 && parts.length > 1) {
      p = p ? p + '/' + parts[0] : parts[0];
      parts.shift();
      rest = parts.join('/');
    }
    if (Buffer.byteLength(rest, 'utf8') > 100 || Buffer.byteLength(p, 'utf8') > 155) {
      throw new Error(`路径过长,无法打包: ${relPath}`);
    }
    name = rest; prefix = p;
  }
  buf.write(name, 0, 100, 'utf8');
  buf.write(tarOctal(mode), 100, 8, 'ascii');
  buf.write(tarOctal(0), 108, 8, 'ascii');
  buf.write(tarOctal(0), 116, 8, 'ascii');
  buf.write(tarOctal(size), 124, 8, 'ascii');
  buf.write(tarOctal(mtimeSec), 136, 8, 'ascii');
  buf.fill(0x20, 148, 156); // checksum 先置空格
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  buf[156] = type.charCodeAt(0); // '0' 文件 '5' 目录 '2' 符号链接
  buf.write(linkname, 157, 100, 'utf8');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  buf.write(prefix, 345, 155, 'utf8');
  return buf;
}
// 递归收集一组远程路径(文件/目录)为 tar 条目;每个根路径映射到给定相对路径(rel)
async function collectRemotePaths(roots) {
  const out = [];
  const walk = async (dir, rel) => {
    const list = await ssh.listDir(dir);
    for (const e of list) {
      const relPath = rel + '/' + e.name;
      const abs = normalizeRemote(dir === '/' ? '/' + e.name : dir + '/' + e.name);
      const mtimeSec = Math.floor((e.mtime || 0) / 1000);
      if (e.type === 'dir') {
        out.push({ relPath: relPath + '/', type: 'dir', size: 0, mtimeSec, abs });
        await walk(abs, relPath);
      } else if (e.type === 'link') {
        let link = null;
        try { link = await new Promise((res, rej) => ssh.sftp.readlink(abs, (err, t) => (err ? rej(err) : res(t)))); } catch {}
        out.push({ relPath, type: 'link', size: 0, mtimeSec, link });
      } else {
        out.push({ relPath, type: 'file', size: e.size || 0, mtimeSec, abs });
      }
    }
  };
  for (const { abs, rel } of roots) {
    const type = await ssh.atype(abs);
    const mtimeSec = Math.floor(Date.now() / 1000);
    if (type === 'dir') {
      out.push({ relPath: rel + '/', type: 'dir', size: 0, mtimeSec, abs });
      await walk(abs, rel);
    } else if (type === 'link') {
      let link = null;
      try { link = await new Promise((res, rej) => ssh.sftp.readlink(abs, (err, t) => (err ? rej(err) : res(t)))); } catch {}
      out.push({ relPath: rel, type: 'link', size: 0, mtimeSec, link });
    } else {
      const st = await ssh.stat(abs);
      out.push({ relPath: rel, type: 'file', size: st?.size || 0, mtimeSec, abs });
    }
  }
  return out;
}
// 把一个远程文件分块读入 tar 流(512 对齐填充)
async function streamRemoteFileToTar(abs, size, write) {
  if (size <= 0) return;
  const handle = await new Promise((res, rej) => ssh.sftp.open(abs, 'r', (e, h) => (e ? rej(e) : res(h))));
  try {
    const buf = Buffer.alloc(256 * 1024);
    let off = 0, remaining = size;
    while (remaining > 0) {
      const n = Math.min(buf.length, remaining);
      const got = await new Promise((res, rej) => ssh.sftp.read(handle, buf, 0, n, off, (e, b) => (e ? rej(e) : res(b))));
      if (got <= 0) break;
      await write(buf.subarray(0, got));
      off += got; remaining -= got;
    }
    const pad = (512 - (size % 512)) % 512;
    if (pad) await write(Buffer.alloc(pad));
  } finally {
    try { await new Promise((res) => ssh.sftp.close(handle, () => res())); } catch {}
  }
}

// 把一组 root 条目流式写入 gzip:写 tar 头 + 文件内容 + 1024 结束块,最后 end
// write 须为 (buf) => Promise<void>(尊重背压的写函数);gzip 为 zlib.Gzip 实例
export async function streamTarToGzip(gzip, roots, write) {
  const entries = await collectRemotePaths(roots);
  for (const e of entries) {
    if (e.type === 'dir') {
      await write(tarHeader(e.relPath, { mode: 0o755, size: 0, mtimeSec: e.mtimeSec, type: '5' }));
    } else if (e.type === 'link' && e.link) {
      await write(tarHeader(e.relPath, { mode: 0o777, size: 0, mtimeSec: e.mtimeSec, type: '2', linkname: e.link }));
    } else {
      await write(tarHeader(e.relPath, { mode: 0o644, size: e.size, mtimeSec: e.mtimeSec, type: '0' }));
      await streamRemoteFileToTar(e.abs, e.size, write);
    }
  }
  await write(Buffer.alloc(1024)); // tar 结束标记:两个 512 零块
  gzip.end();
}
