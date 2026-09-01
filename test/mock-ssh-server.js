// mock SSH 服务器:供本地全链路 E2E 测试使用(无需真实远程服务器)
// 基于 ssh2 Server 模式:
//   - 密码认证 tester / pass
//   - SFTP 子系统实现:把远程路径映射到本机 rootDir(local fs)
//   - exec:在 Windows 上用 cmd.exe 执行命令(命令需为 cmd 语法)
import ssh2 from 'ssh2';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const { Server } = ssh2;
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 1024,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

// 以 rootDir 为虚拟根,把远程 posix 路径解析成本机路径(禁止越权)
function toLocal(rootDir, rp) {
  const parts = String(rp).split('/').filter(Boolean);
  const abs = path.join(rootDir, ...parts);
  const root = path.resolve(rootDir);
  const res = path.resolve(abs);
  if (res !== root && !res.startsWith(root + path.sep)) throw Object.assign(new Error('越界'), { code: 'EACCES' });
  return res;
}

// 一键构造 SFTP attrs
function attrs(st) {
  const m = st.isDirectory() ? (0o040755 | st.mode) : (0o100644 | (st.mode & 0o777));
  return {
    mode: m, uid: 0, gid: 0, size: st.size,
    atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000)
  };
}

let handleSeq = 1;
const handles = new Map(); // handleId -> {kind:'file', fd} | {kind:'dir', path, entries, idx}

function setupSftp(sftp, rootDir) {
  sftp.on('OPEN', (reqid, filename, flags) => {
    try {
      const lp = toLocal(rootDir, filename);
      const wantWrite = (flags & 0x2) !== 0;
      let fd;
      if (wantWrite) {
        if (!fs.existsSync(lp)) fs.closeSync(fs.openSync(lp, 'w', 0o644)); // 创建占位
        fd = fs.openSync(lp, 'r+');
        if (flags & 0x10) fs.ftruncateSync(fd, 0); // TRUNC
      } else {
        fd = fs.openSync(lp, 'r');
      }
      const id = handleSeq++;
      handles.set(id, { kind: 'file', fd });
      sftp.handle(reqid, Buffer.from(String(id)));
    } catch (e) { sftp.status(reqid, e.code === 'ENOENT' ? 2 : 4); }
  });
  sftp.on('READ', (reqid, handle, offset, length) => {
    const h = handles.get(Number(handle.toString()));
    if (!h) return sftp.status(reqid, 4);
    const buf = Buffer.alloc(length);
    const n = fs.readSync(h.fd, buf, 0, length, offset);
    sftp.data(reqid, buf.slice(0, n));
  });
  sftp.on('STAT', (reqid, p) => statResp(sftp, reqid, p));
  sftp.on('LSTAT', (reqid, p) => statResp(sftp, reqid, p));
  sftp.on('FSTAT', (reqid, handle) => {
    const h = handles.get(Number(handle.toString()));
    if (!h) return sftp.status(reqid, 4);
    try { sftp.attrs(reqid, attrs(fs.fstatSync(h.fd))); }
    catch { sftp.status(reqid, 4); }
  });
  sftp.on('CLOSE', (reqid, handle) => {
    const h = handles.get(Number(handle.toString()));
    if (h) { if (h.kind === 'file') fs.closeSync(h.fd); handles.delete(Number(handle.toString())); }
    sftp.status(reqid, 0);
  });
  sftp.on('OPENDIR', (reqid, p) => {
    try {
      const lp = toLocal(rootDir, p);
      const entries = fs.readdirSync(lp, { withFileTypes: true });
      const id = handleSeq++;
      handles.set(id, { kind: 'dir', path: lp, entries, idx: 0 });
      sftp.handle(reqid, Buffer.from(String(id)));
    } catch (e) { sftp.status(reqid, e.code === 'ENOENT' ? 2 : 4); }
  });
  sftp.on('READDIR', (reqid, handle) => {
    const h = handles.get(Number(handle.toString()));
    if (!h || h.kind !== 'dir') return sftp.status(reqid, 4);
    const names = [];
    while (h.idx < h.entries.length) {
      const e = h.entries[h.idx++];
      let st;
      try { st = fs.statSync(path.join(h.path, e.name)); } catch { continue; }
      names.push({ filename: e.name, longname: '', attrs: attrs(st) });
    }
    if (names.length === 0) { handles.delete(Number(handle.toString())); sftp.status(reqid, 1); }
    else sftp.name(reqid, names);
  });
  sftp.on('MKDIR', (reqid, p) => {
    try { fs.mkdirSync(toLocal(rootDir, p)); sftp.status(reqid, 0); }
    catch (e) { sftp.status(reqid, e.code === 'EEXIST' ? 4 : e.code === 'EACCES' ? 3 : 4); }
  });
  sftp.on('RMDIR', (reqid, p) => {
    try { fs.rmdirSync(toLocal(rootDir, p)); sftp.status(reqid, 0); }
    catch { sftp.status(reqid, 4); }
  });
  sftp.on('REMOVE', (reqid, p) => { // 删文件:ssh2 服务端事件名是 REMOVE,不是 UNLINK
    try { fs.unlinkSync(toLocal(rootDir, p)); sftp.status(reqid, 0); }
    catch { sftp.status(reqid, 4); }
  });
  sftp.on('RENAME', (reqid, op, np) => {
    try { fs.renameSync(toLocal(rootDir, op), toLocal(rootDir, np)); sftp.status(reqid, 0); }
    catch { sftp.status(reqid, 4); }
  });
  sftp.on('SETSTAT', (reqid) => sftp.status(reqid, 0));
  sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, 0));
  sftp.on('REALPATH', (reqid, p) => {
    sftp.name(reqid, [{ filename: normalize(p), longname: '', attrs: {} }]);
  });
  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const h = handles.get(Number(handle.toString()));
    if (!h) return sftp.status(reqid, 4);
    try { fs.writeSync(h.fd, data, 0, data.length, offset); sftp.status(reqid, 0); }
    catch { sftp.status(reqid, 4); }
  });

  function statResp(sftp, reqid, p) {
    try { sftp.attrs(reqid, attrs(fs.statSync(toLocal(rootDir, p)))); }
    catch (e) { sftp.status(reqid, e.code === 'ENOENT' ? 2 : 4); }
  }
}
function normalize(p) {
  let s = String(p).replace(/\\/g, '/');
  return s.startsWith('/') ? s : '/' + s;
}

export function startMockSsh({ port = 2222, rootDir }) {
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'pass') ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        let target = null; // { proc, stream }:当前 exec 通道,供 signal 终止
        session.on('sftp', (saccept, sreject) => {
          setupSftp(saccept(), rootDir);
        });
        session.on('exec', (eaccept, ereject, info) => {
          const stream = eaccept();
          target = { proc: null, stream };
          const proc = runCmd(info.command, stream, rootDir);
          if (proc) target.proc = proc;
        });
        // 收到远端信号(模拟 Ctrl+C):终止进程树并关闭通道,让客户端看到命令结束
        session.on('signal', (saccept, sreject, data) => {
          const t = target;
          killTree(t && t.proc);
          try { if (t && t.stream && t.stream.writable) { t.stream.exit(130); t.stream.end(); } } catch {}
          saccept && saccept();
        });
        session.on('pty', (ptyAccept) => { ptyAccept && ptyAccept(); });
        // 交互式 shell(供 /ws/term 终端链路测试):管道接 cmd.exe / sh。
        // 无真实 PTY(不回显、不处理 resize),但足以验证通道的 start/输入/输出/exit 收发。
        session.on('shell', (saccept, sreject) => {
          const stream = saccept();
          const proc = process.platform === 'win32'
            ? spawn('cmd.exe', [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
            : spawn('/bin/sh', [], { stdio: ['pipe', 'pipe', 'pipe'] });
          target = { proc, stream };
          stream.on('data', (d) => { try { proc.stdin.write(d); } catch {} });
          proc.stdout.on('data', (d) => { try { stream.write(d); } catch {} });
          proc.stderr.on('data', (d) => { try { stream.stderr.write(d); } catch {} });
          stream.on('close', () => killTree(proc));
          proc.on('exit', (code) => { try { stream.exit(code ?? 0); stream.end(); } catch {} });
          proc.on('error', () => { try { stream.exit(1); stream.end(); } catch {} });
        });
      });
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

// 终止进程树(Windows 用 taskkill /T,避免杀掉 cmd 后子进程变孤儿)
function killTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      proc.kill('SIGKILL');
    }
  } catch {}
}

function runCmd(cmd, stream, rootDir) {
  // 远程工作区路径 /x -> 本机 rootDir\x(mock 特有:exec 运行在宿主机上)
  const translated = translateRemoteCds(cmd);
  // cmd.exe 在 Windows 上执行;输出写回 stream,stderr 写 stream.stderr
  // windowsVerbatimArguments 避免 cmd /c 对待含空格/引号命令时的解析 bug
  const proc = spawn('cmd.exe', ['/c', translated], { windowsHide: true, windowsVerbatimArguments: true });
  // 通道关闭(正常结束/断开/服务关闭)时清理仍在运行的进程树,避免孤儿进程
  stream.on('close', () => killTree(proc));
  proc.stdout.on('data', (d) => stream.write(d));
  proc.stderr.on('data', (d) => { try { stream.stderr.write(d); } catch {} });
  proc.on('close', (code) => {
    try { stream.exit(code ?? 1); } catch {}
    try { stream.end(); } catch {}
  });
  proc.on('error', (e) => {
    try { stream.stderr.write(`\n[spawn错误: ${e.message}]\n`); } catch {}
    try { stream.exit(1); stream.end(); } catch {}
  });
  return proc;

  function translateRemoteCds(c) {
    // 把开头形如 cd "/src" && 的远程路径替换成本机映射路径
    return String(c).replace(/^cd\s+"(\/[^"]*)"\s*&&/i, (_, rp) => `cd "${toLocal(rootDir, rp)}" &&`);
  }
}

export function makeFixture(rootDir) {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# 示例项目\n\n这是一个用于 E2E 测试的远程示例项目。\n');
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ name: 'sample', version: '1.0.0', scripts: { start: 'node index.js' } }, null, 2));
  fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'src', 'README.md'), '# src 模块\n\nsrc 目录的说明文件。\n');
  fs.writeFileSync(path.join(rootDir, 'src', 'main.js'), 'const greeting = "hello";\nconsole.log(greeting);\n');
}  