// @ts-nocheck
// SSH 单连接:建立/保活/自动重连,SFTP 文件操作,exec 命令执行。
// 连接池(文件底部 SshManager)同时持有多个 SshConnection,各自独立保活,
// 同一时刻只有一个是「活动连接」,文件与命令操作都作用在活动连接上。
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client } from 'ssh2';
import { SSH, EXEC, FILE } from './config.ts';

// 连接作用域:agent 会话一轮运行期间被绑定到它所属服务器的连接。
// 用户切走活动连接后,后台会话的工具调用仍走绑定连接,不会误操作新服务器。
const connScope = new AsyncLocalStorage();

// 远程路径归一化(兼容 posix / windows 反斜杠),返回不带尾斜杠的绝对路径
export function normalizeRemote(p) {
  if (!p) return p;
  let s = String(p).trim().replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  while (s.includes('//')) s = s.replace(/\/+/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

export function joinRemote(dir, name) {
  dir = normalizeRemote(dir || '/');
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

function truncateOutput(text, chr, head) {
  if (!text || text.length <= chr) return { text: text || '', truncated: false };
  const keep = head || Math.floor(chr * 0.6);
  const tail = chr - keep;
  const out = text.slice(0, keep) + '\n…[输出过长,已截断,省略 ' + (text.length - chr) + ' 字符]…\n' + text.slice(text.length - tail);
  return { text: out, truncated: true };
}

const call = (fn, ...args) => new Promise((resolve, reject) => {
  fn(...args, (err, res) => (err ? reject(err) : resolve(res)));
});

export class SshConnection extends EventEmitter {
  constructor() {
    super();
    this.client = null;   // ssh2 Client
    this.sftp = null;     // SFTPWrapper
    this.status = 'disconnected'; // disconnected | connecting | connected | reconnecting
    this.desired = false; // 是否期望保持连接(重连依据)
    this.opts = null;     // 最近一次连接参数
    this.retry = 0;
    this.timer = null;    // 重连定时器
    this.platform = null; // 'win32' | 'posix' | null
    this.home = null;     // 远程家目录
    this.workspace = null;// 用户选择的工作区(每台服务器独立保存)
    this.execQueue = Promise.resolve();
    this.bgQueue = Promise.resolve(); // 后台维护任务队列(环境自检/工具安装),与主命令队列隔离
    this.activeRuns = new Map(); // runId -> { stream, done, stopped, killTimer },供 kill/超时终止命令
    this.hostInfo = null; // {host,port,username}
    this.profileId = null;// 由哪个已保存配置发起(连接池用 profileId 做连接 id)
    this.reason = null;   // 最近一次重连原因(供 UI 展示)
    this._readyPromise = null; // 正在进行的连接(连接池复用「连接中」连接时需等待它)
  }

  get connected() { return this.status === 'connected'; }

  // ---------- 连接生命周期 ----------
  // 建立/重建本连接;工作区按服务器独立,连接自身不复位。返回就绪(或失败)的 Promise
  connect(opts) {
    this.desired = true;
    this.opts = opts;
    this.retry = 0;
    this.reason = null;
    this.hostInfo = { host: opts.host, port: opts.port, username: opts.username };
    const p = this._open();
    this._readyPromise = p;
    p.catch(() => {}).finally(() => { if (this._readyPromise === p) this._readyPromise = null; });
    return p;
  }

  _open() {
    return new Promise((resolve, reject) => {
      if (this.status === 'connecting') return resolve();
      this._setStatus('connecting');
      const c = new Client();
      this.client = c;
      const cfg = {
        host: this.opts.host, port: this.opts.port, username: this.opts.username,
        keepaliveInterval: SSH.KEEPALIVE_INTERVAL,
        keepaliveCountMax: SSH.KEEPALIVE_COUNT_MAX,
        readyTimeout: SSH.READY_TIMEOUT
      };
      const auth = this.opts.auth || {};
      if (auth.type === 'privateKey') {
        cfg.privateKey = auth.privateKey;
        if (auth.passphrase) cfg.passphrase = auth.passphrase;
      } else {
        cfg.password = auth.password;
      }
      let settled = false;
      const done = (err) => { if (!settled) { settled = true; err ? reject(err) : resolve(); } };

      c.on('ready', async () => {
        try {
          this.sftp = await call((cb) => c.sftp(cb));
          await this._probe();
          this.retry = 0;
          this._setStatus('connected');
          done();
        } catch (e) {
          this._teardown();
          this.emit('log', 'error', `SFTP 初始化失败: ${e.message}`);
          done(e);
          if (this.desired) this._scheduleReconnect(e.message);
        }
      });
      c.on('error', (e) => {
        this.emit('log', 'error', `SSH 错误: ${e.message}`);
        if (!settled) done(e);
        if (this.status === 'connected') {
          this._teardown();
          if (this.desired) this._scheduleReconnect(e.message);
        }
      });
      c.on('close', () => {
        this.emit('log', 'warn', 'SSH 连接已关闭');
        this._teardown();
        if (this.desired && this.status !== 'connecting') this._scheduleReconnect('连接关闭');
      });
      c.on('end', () => { /* close 会跟随 */ });
      try { c.connect(cfg); } catch (e) { done(e); this._teardown(); }
    });
  }

  async _probe() {
    // 探测远程平台与家目录
    const r = await this._execRaw('uname -s', { timeout: 6000 });
    if (r.code === 0 && r.stdout.trim()) {
      this.platform = 'posix';
      const h = await this._execRaw('echo "$HOME"', { timeout: 6000 });
      this.home = h.code === 0 && h.stdout.trim() ? h.stdout.trim() : null;
    } else {
      this.platform = 'win32';
      const h = await this._execRaw('echo %USERPROFILE%', { timeout: 6000 });
      this.home = h.code === 0 && h.stdout.trim() ? h.stdout.trim().trim() : null;
    }
    this.emit('log', 'info', `远程平台: ${this.platform}${this.home ? `, 家目录: ${this.home}` : ''}`);
  }

  _teardown() {
    if (this.sftp) { try { this.sftp = null; } catch {} }
    if (this.client) {
      const c = this.client; this.client = null;
      try { c.end(); } catch {}
    }
    this._setStatus('disconnected');
    this.emit('connection-lost');
  }

  _scheduleReconnect(reason) {
    if (!this.desired || this.timer) return;
    const delay = Math.min(SSH.RECONNECT_BASE_MS * Math.pow(2, this.retry), SSH.RECONNECT_MAX_MS);
    this.retry += 1;
    this.reason = reason;
    this._setStatus('reconnecting', { reason, retry: this.retry, delay });
    this.emit('log', 'warn', `${delay / 1000}s 后自动重连(${reason})`);
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (!this.desired) return;
      try { await this._open(); }
      catch (e) { this._scheduleReconnect(e.message); } // _open 失败时继续退避
    }, delay);
  }

  async disconnect() {
    this.desired = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.client) {
      const c = this.client; this.client = null;
      try { c.end(); } catch {}
    }
    this._teardown();
  }

  _setStatus(status, extra = {}) {
    this.status = status;
    this.emit('status', { status, ...this.hostInfo, workspace: this.workspace, ...extra });
  }

  // ---------- 命令执行 ----------
  // 返回 { code, signal, stdout, stderr, timedOut, stopped } ;onOut/onErr 实时回调;截断已处理
  exec(cmd, { runId, timeout, onOut, onErr, maxOutput = EXEC.MAX_OUTPUT_CHARS } = {}) {
    // 串行队列,避免并发通道互相干扰
    const run = this.execQueue.then(() => this._execRaw(cmd, { runId, timeout, onOut, onErr, maxOutput }));
    this.execQueue = run.catch(() => {});
    return run;
  }

  // 后台维护任务(环境自检/搜索工具安装)专用队列:与主命令队列隔离,
  // 避免长时间安装(可达 180s)阻塞 agent 的 run_command 等前台命令。
  // 与 exec 一样走 _execRaw,ssh2 支持同连接上多路 exec 通道并行。
  execBackground(cmd, opts = {}) {
    const run = this.bgQueue.then(() => this._execRaw(cmd, opts));
    this.bgQueue = run.catch(() => {});
    return run;
  }

  // 停止运行中的命令:先发 SIGINT(模拟 Ctrl+C),宽限期后仍未结束则 SIGKILL 并关闭通道
  kill(runId, { graceMs = 2000, signal = 'INT' } = {}) {
    const run = this.activeRuns.get(runId);
    if (!run || run.done) return false;
    run.stopped = true;
    if (run.stream) {
      try { run.stream.signal(signal); } catch {}
    }
    if (!run.killTimer) {
      run.killTimer = setTimeout(() => {
        if (run.done) return;
        const s = run.stream;
        try { s?.signal?.('KILL'); } catch {}
        try { s?.close(); } catch {}
        try { s?.end(); } catch {}
      }, graceMs);
    }
    return true;
  }

  _execRaw(cmd, { runId, timeout = EXEC.DEFAULT_TIMEOUT_MS, onOut, onErr, maxOutput = EXEC.MAX_OUTPUT_CHARS } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.client) return reject(new Error('SSH 未连接'));
      const t = Math.min(timeout, EXEC.MAX_TIMEOUT_MS);
      let stdout = '', stderr = '';
      let timedOut = false;
      // 运行记录:kill/超时通过它拿到 channel;agent 等无 runId 调用用内部 id 登记,统一清理
      const run = { id: runId || `exec-${(this._runSeq = (this._runSeq || 0) + 1)}`, stream: null, done: false, stopped: false, killTimer: null };
      this.activeRuns.set(run.id, run);
      const addOut = (s) => { stdout += s; if (stdout.length > maxOutput) stdout = stdout.slice(0, maxOutput); onOut?.(s); };
      const addErr = (s) => { stderr += s; if (stderr.length > maxOutput) stderr = stderr.slice(0, maxOutput); onErr?.(s); };
      let settled = false;
      const finish = (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (run.killTimer) clearTimeout(run.killTimer);
          run.done = true;
          this.activeRuns.delete(run.id);
          resolve({ ...v, stopped: run.stopped });
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        onErr?.('\n[超时: 命令超过 ' + (t / 1000) + 's 仍未结束,已终止]\n');
        try { run.stream?.close(); } catch {}
        try { run.stream?.end(); } catch {}
        // 等待 close 事件再结算
        setTimeout(() => finish({ code: -1, signal: 'TIMEOUT', stdout, stderr, timedOut }), 500);
      }, t);

      this.client.exec(cmd, { pty: false }, (err, stream) => {
        run.stream = stream || null;
        if (err) return finish({ code: -1, signal: null, stdout, stderr, error: err.message });
        // 通道打开前用户已点停止:立即终止
        if (run.stopped) {
          try { stream.signal('KILL'); } catch {}
          try { stream.close(); } catch {}
          try { stream.end(); } catch {}
        }
        stream.on('data', (d) => addOut(d.toString('utf8')));
        stream.stderr.on('data', (d) => addErr(d.toString('utf8')));
        stream.on('close', (code, signal) => {
          clearTimeout(timer);
          finish({ code, signal, stdout: truncateOutput(stdout, maxOutput).text, stderr: truncateOutput(stderr, maxOutput).text, timedOut });
        });
        stream.on('error', (e) => { onErr?.(`\n[命令通道错误: ${e.message}]\n`); });
      });
      // 捕获同步抛错
    }).catch((e) => ({ code: -1, signal: null, stdout: '', stderr: `错误: ${e.message}`, error: true }));
  }

  // ---------- 交互式终端(PTY) ----------
  // 打开远程交互式 shell(xterm-256color PTY),供命令台真实终端使用。
  // 返回 ssh2 的双工 stream:data=输出,write=键盘输入,setWindow=尺寸变化,close=结束
  shell({ cols = 80, rows = 24 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.client) return reject(new Error('SSH 未连接'));
      this.client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) return reject(err);
        resolve(stream);
      });
    });
  }

  // agent/命令台统一入口:按平台给工作区路径加引号后 cd 进去执行
  cdCommand(cmd) {
    if (!this.workspace || !cmd) return cmd;
    const t = String(cmd).trim();
    if (/^cd(\s|$)/.test(t)) return cmd; // 用户/agent 显式 cd 则不注入
    const ws = normalizeRemote(this.workspace);
    if (this.platform === 'win32') return `cd "${ws.replace(/"/g, '""')}" && ${cmd}`;
    return `cd '${ws.replace(/'/g, `'\\''`)}' && ${cmd}`;
  }

  // ---------- SFTP 文件操作 ----------
  async listDir(p) {
    if (!this.sftp) throw new Error('SFTP 未就绪');
    const list = await call((cb) => this.sftp.readdir(p, cb));
    const entries = (list || []).map((it) => ({
      name: it.filename,
      type: it.attrs.isDirectory() ? 'dir' : it.attrs.isSymbolicLink() ? 'link' : 'file',
      size: it.attrs.size || 0,
      mtime: it.attrs.mtime ? it.attrs.mtime * 1000 : 0
    })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return entries;
  }

  async stat(p) {
    if (!this.sftp) throw new Error('SFTP 未就绪');
    try { return await call((cb) => this.sftp.stat(p, cb)); }
    catch (e) { if (e.code === 2 || e.message?.includes('No such file')) return null; throw e; }
  }

  // 分块读取,避免大文件整体拉取;返回 {buffer, size, truncated}
  async readFileChunk(p, { maxBytes = FILE.READ_MAX_BYTES, offset = 0 } = {}) {
    const st = await this.stat(p);
    if (!st) throw new Error(`文件不存在: ${p}`);
    if (st.isDirectory()) throw new Error(`是目录: ${p}`);
    if (!this.sftp) throw new Error('SFTP 未就绪');
    const handle = await call((cb) => this.sftp.open(p, 'r', cb));
    try {
      const size = st.size;
      // maxBytes 0 表示不限制(整文件读取),否则按上限截取
      const want = maxBytes > 0 ? Math.min(maxBytes, Math.max(0, size - offset)) : Math.max(0, size - offset);
      const buf = Buffer.alloc(want);
      let got = 0;
      while (got < want) {
        const n = await new Promise((res, rej) =>
          this.sftp.read(handle, buf, got, want - got, offset + got, (err, bytes) => (err ? rej(err) : res(bytes))));
        if (n === 0) break;
        got += n;
      }
      return { buffer: buf.subarray(0, got), size, truncated: offset + got < size };
    } finally {
      try { await call((cb) => this.sftp.close(handle, cb)); } catch {}
    }
  }

  // 检测文件是否二进制
  isProbablyBinary(buf) {
    if (!buf) return false;
    const n = Math.min(buf.length, FILE.DISCARD_BYTES);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  }

  // 写入远程文件内容(覆盖写);opts.maxBytes 传 0 表示不限制(批量上传用),
  // opts.mkdir=false 表示目录已预先建好,跳过逐级探测
  async writeRemoteFile(p, content, opts = {}) {
    if (!this.sftp) throw new Error('SFTP 未就绪');
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const maxBytes = opts.maxBytes ?? FILE.WRITE_MAX_BYTES;
    if (maxBytes && buf.length > maxBytes) {
      throw new Error(`文件过大(>${Math.round(maxBytes / 1024 / 1024)}MB): ${p}`);
    }
    if (opts.mkdir !== false) await this.mkdirp(remoteDirName(p));
    const handle = await call((cb) => this.sftp.open(p, 'w', cb));
    try {
      const size = buf.length;
      let off = 0;
      while (off < size) {
        const n = await new Promise((res, rej) =>
          this.sftp.write(handle, buf, off, size - off, off, (err) => (err ? rej(err) : res(size - off))));
        off += n;
      }
      return size;
    } finally {
      try { await call((cb) => this.sftp.close(handle, cb)); } catch {}
    }
  }

  async mkdirp(p) {
    const norm = normalizeRemote(p);
    if (norm === '/') return;
    const parts = norm.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      const st = await this.stat(cur);
      if (st) {
        if (!st.isDirectory()) throw new Error(`路径冲突,存在同名非目录: ${cur}`);
      } else {
        await call((cb) => this.sftp.mkdir(cur, cb));
      }
    }
  }

  // 用远程 shell 命令删除目录树(posix: rm -rf / win32: rmdir /s /q),一次往返搞定整棵树,
  // 比 SFTP 逐项删快几个数量级。返回 true 表示已成功删除;失败(权限、命令不可用等)返回 false 交由调用方回退。
  // 路径按平台正确引用,防 shell 元字符注入。
  async _shellDeleteTree(p) {
    if (!this.connected || !this.client) return false;
    const cmd = this.platform === 'win32'
      ? `rmdir /s /q "${p.replace(/"/g, '""')}"`
      : `rm -rf -- '${p.replace(/'/g, `'\\''`)}'`;
    const r = await this._execRaw(cmd, { timeout: EXEC.MAX_TIMEOUT_MS });
    if (r && r.code === 0 && !r.timedOut) return true;
    this.emit('log', 'warn', `shell 删除未生效(code=${r?.code}),回退 SFTP 逐项删除: ${p}${r?.stderr ? ` → ${r.stderr}` : ''}`);
    return false;
  }

  // 递归删除文件/目录;onProgress 每删一项回调一次。
  // 目录优先走远端 shell 命令整树删除(快);失败则回退 SFTP 逐项删。
  // 回退容错:单个子项失败只记录,继续删其余;最后把删不掉的项汇总成错误抛出。
  async rmdirRecursive(p, onProgress, allowShell = true) {
    p = normalizeRemote(p);
    if (!p || p === '/') throw new Error('拒绝删除根目录');
    const st = await this.atype(p);
    if (!st) return; // 竞态:路径已被并发删除
    if (st === 'dir' && allowShell && (await this._shellDeleteTree(p))) {
      onProgress?.(p);
      return;
    }
    if (st === 'file' || st === 'link') {
      await call((cb) => this.sftp.unlink(p, cb));
      onProgress?.(p);
      return;
    }
    const list = await this.listDir(p);
    const failures = [];
    for (const e of list) {
      try {
        // 已进入回退均不再试 shell,避免逐项删除时对每个子目录重复失败并刷日志
        await this.rmdirRecursive(joinRemote(p, e.name), onProgress, false);
      } catch (err) {
        failures.push(`${e.name}: ${err.message}`);
      }
    }
    try {
      await call((cb) => this.sftp.rmdir(p, cb));
      onProgress?.(p);
    } catch (err) {
      if (failures.length) throw new Error(`目录非空,${failures.length} 项未删净(${failures.slice(0, 3).join('; ')})`);
      throw new Error(`目录删除失败: ${err.message}`);
    }
    if (failures.length) throw new Error(`已删除其余内容,但 ${failures.length} 项失败: ${failures.slice(0, 3).join('; ')}`);
  }

  async atype(p) {
    if (!this.sftp) throw new Error('SFTP 未就绪');
    try {
      const a = await call((cb) => this.sftp.lstat(p, cb));
      return a.isDirectory() ? 'dir' : a.isSymbolicLink() ? 'link' : 'file';
    } catch (e) {
      if (e.code === 2 || e.message?.includes('No such file')) return null;
      throw e;
    }
  }

  // ---------- 复制 ----------
  // 递归复制文件/目录(跨平台);目标已存在且未允许覆盖时抛错;防复制到自身内部
  async copyPath(src, dst, { overwrite = false } = {}) {
    src = normalizeRemote(src);
    dst = normalizeRemote(dst);
    if (src === '/') throw new Error('不能复制根目录');
    if (src === dst) throw new Error('源与目标相同');
    if (dst.startsWith(src + '/')) throw new Error('不能复制到自身内部');
    const type = await this.atype(src);
    if (!type) throw new Error(`源不存在: ${src}`);
    const dstType = await this.atype(dst);
    if (dstType) {
      if (!overwrite) throw new Error(`目标已存在: ${dst}`);
      await this.rmdirRecursive(dst); // 文件/目录/链接均可删
    }
    if (type === 'dir') {
      await this.mkdirp(dst);
      await this._copyDir(src, dst);
    } else {
      await this._copyFile(src, dst); // link 按文件复制(跟随链接读取内容)
    }
    return { src, dst };
  }

  async _copyFile(src, dst) {
    if (!this.sftp) throw new Error('SFTP 未就绪');
    await this.mkdirp(remoteDirName(dst));
    const sh = await call((cb) => this.sftp.open(src, 'r', cb));
    let dh = null;
    try {
      dh = await call((cb) => this.sftp.open(dst, 'w', cb));
      const buf = Buffer.alloc(128 * 1024);
      let off = 0;
      for (;;) {
        const n = await new Promise((res, rej) =>
          this.sftp.read(sh, buf, 0, buf.length, off, (e, bytes) => (e ? rej(e) : res(bytes))));
        if (!n) break;
        await new Promise((res, rej) =>
          this.sftp.write(dh, buf, 0, n, off, (e) => (e ? rej(e) : res())));
        off += n;
      }
    } finally {
      if (dh) { try { await call((cb) => this.sftp.close(dh, cb)); } catch {} }
      try { await call((cb) => this.sftp.close(sh, cb)); } catch {}
    }
  }

  async _copyDir(src, dst) {
    const list = await this.listDir(src);
    for (const e of list) {
      const sp = joinRemote(src, e.name);
      const dp = joinRemote(dst, e.name);
      if (e.type === 'dir') {
        await this.mkdirp(dp);
        await this._copyDir(sp, dp);
      } else {
        await this._copyFile(sp, dp);
      }
    }
  }
}

function remoteDirName(p) {
  const n = normalizeRemote(p);
  const i = n.lastIndexOf('/');
  return i <= 0 ? '/' : n.slice(0, i);
}

// ---------- 多连接连接池(对外门面) ----------
// 同时维护 N 个独立保活的 SshConnection;文件/命令操作统一委托给「活动连接」。
// 切换活动连接只改指针、不做任何网络动作,已建立的连接保持不断 => 快速切换。
// 连接 id:由已保存配置发起的用 profileId,直接连接用 "host:port:username"。
export class SshManager extends EventEmitter {
  constructor() {
    super();
    this.conns = new Map(); // id -> SshConnection
    this._activeId = null;  // 当前活动连接 id
    // 以下字段仅用于测试直接赋值(模拟单连接形态),平时保持 undefined 走活动连接
    this._status = undefined; this._platform = undefined; this._home = undefined;
    this._workspace = undefined; this._hostInfo = undefined; this._sftp = undefined;
  }

  get active() {
    // 连接作用域优先:agent 运行期间取绑定连接;作用域外(undefined)才回落活动连接
    const scoped = connScope.getStore();
    if (scoped !== undefined) return scoped || null;
    return (this._activeId && this.conns.get(this._activeId)) || null;
  }
  get activeId() { return this._activeId; }
  // 读取优先活动连接(生产路径);直接赋值(测试 mock)在无活动连接时生效,setter 双向同步
  get status() { return this.active ? this.active.status : (this._status ?? 'disconnected'); }
  set status(v) { this._status = v; if (this.active) this.active.status = v; }
  get platform() { return this.active ? this.active.platform : (this._platform ?? null); }
  set platform(v) { this._platform = v; if (this.active) this.active.platform = v; }
  get home() { return this.active ? this.active.home : (this._home ?? null); }
  set home(v) { this._home = v; if (this.active) this.active.home = v; }
  get workspace() { return this.active ? this.active.workspace : (this._workspace ?? null); }
  set workspace(v) { this._workspace = v; if (this.active) this.active.workspace = v; }
  get hostInfo() { return this.active ? this.active.hostInfo : (this._hostInfo ?? null); }
  set hostInfo(v) { this._hostInfo = v; if (this.active) this.active.hostInfo = v; }
  get sftp() { return this.active ? this.active.sftp : (this._sftp ?? null); }
  set sftp(v) { this._sftp = v; if (this.active) this.active.sftp = v; }
  get connected() { return this.status === 'connected'; }

  // 连接 id:由已保存配置发起用 profileId,直接连接用 "host:port:username"
  static keyOf(opts = {}) {
    if (opts.profileId) return String(opts.profileId);
    const host = String(opts.host || '').trim();
    if (!host || !opts.username) return '';
    return `${host}:${Number(opts.port) || 22}:${opts.username}`;
  }

  // 建立连接;若该服务器已有存活连接,直接切为活动连接,不重新握手
  async connect(opts = {}) {
    const key = SshManager.keyOf(opts);
    if (!key || !/\S/.test(key)) throw new Error('缺少 host/port/username 或 profileId');
    let conn = this.conns.get(key);
    if (!conn && opts.profileId) {
      // 有同服务器的「未绑定配置」连接:改绑到该配置,避免同一台服务器重复建连
      const dupKey = SshManager.keyOf({ host: opts.host, port: opts.port, username: opts.username });
      const dup = dupKey && this.conns.get(dupKey);
      if (dup && !dup.profileId) {
        this.conns.delete(dupKey);
        if (this._activeId === dupKey) this._activeId = key;
        this.conns.set(key, dup);
        conn = dup;
      }
    }
    if (!conn) {
      conn = new SshConnection();
      this.conns.set(key, conn);
      this._hook(key, conn);
    }
    conn.profileId = opts.profileId || null;
    if (conn.connected || conn.status === 'connecting') {
      // 已连接 / 连接中:改为活动连接即可(快速切换,不重连)
      this._activeId = key;
      if (conn.status === 'connecting' && conn._readyPromise) await conn._readyPromise.catch(() => {});
      this.emit('status');
      return key;
    }
    this._activeId = key;
    const p = conn.connect(opts);
    try { await p; } catch (e) { /* 连接失败维持 disconnected,由调用方提示 */ }
    finally { this.emit('status'); }
    return key;
  }

  // 一键切换活动连接(无任何网络动作);连接不存在时返回 false
  switchActive(id) {
    if (!this.conns.has(String(id))) return false;
    if (this._activeId === String(id)) return true;
    this._activeId = String(id);
    this.emit('status');
    return true;
  }

  // 在指定连接的作用域内执行 fn:作用域内 active 解析为该连接。
  // agent 的会话一轮(boundConn)用它绑定到所属服务器,切换活动连接不影响后台运行。
  runWithConn(conn, fn) {
    return connScope.run(conn || null, fn);
  }

  // 断开某连接(缺省 = 活动连接);断开后自动回落到其他存活连接
  async disconnect(id) {
    const key = id || this._activeId;
    const conn = key ? this.conns.get(key) : null;
    if (conn) {
      await conn.disconnect(); // 先断开(desired=false,不会触发全局 connection-lost)
      if (this._activeId === key) this._activeId = null;
    }
    this.conns.delete(key);
    this._fallbackActive();
    this.emit('status');
  }

  async disconnectAll() {
    const list = [...this.conns.values()];
    this.conns.clear();
    this._activeId = null;
    await Promise.all(list.map((c) => c.disconnect().catch(() => {})));
    this.emit('status');
  }

  // 活动连接掉线时自动切到其他存活连接;没有别的连接但本连接在自动重连则保留显示重连状态
  _fallbackActive() {
    const cur = this._activeId ? this.conns.get(this._activeId) : null;
    if (cur && cur.status !== 'disconnected') return;
    for (const [id, c] of this.conns) {
      if (id !== this._activeId && c.status !== 'disconnected') { this._activeId = id; return; }
    }
    if (cur && cur.desired) return; // 自动重连接管,状态随后变 reconnecting
    this._activeId = null;
  }

  // 供前端渲染的连接列表 + 当前活动 id
  snapshot() {
    return {
      activeConn: this._activeId,
      conns: [...this.conns.entries()].map(([id, c]) => ({
        id,
        profileId: c.profileId || null,
        status: c.status,
        host: c.hostInfo?.host ?? null,
        port: c.hostInfo?.port ?? null,
        username: c.hostInfo?.username ?? null,
        platform: c.platform ?? null,
        home: c.home ?? null,
        workspace: c.workspace ?? null,
        autoReconnect: c.desired,
        reason: c.reason || null,
        retry: c.retry || 0
      })).sort((a, b) => (a.id < b.id ? -1 : 1))
    };
  }

  _hook(key, conn) {
    conn.on('status', (info) => {
      const wasActive = this._activeId === key;
      const becameDisconnected = info?.status === 'disconnected';
      this._fallbackActive();
      // 意外掉线(desired 仍为 true,非用户手动断开):触发全局清理。
      // 任意连接都发(不限于活动连接)——切走服务器后仍在后台运行的会话绑定的是它。
      if (becameDisconnected && conn.desired) this.emit('connection-lost', key);
      this.emit('status');
    });
    conn.on('log', (level, message) => this.emit('log', level, message));
  }

  // ---- 以下操作委托给活动连接 ----
  listDir(p) { return this._act('listDir', p); }
  stat(p) { return this._act('stat', p); }
  readFileChunk(p, o) { return this._act('readFileChunk', p, o); }
  isProbablyBinary(b) { return this._act('isProbablyBinary', b); }
  writeRemoteFile(p, c, o) { return this._act('writeRemoteFile', p, c, o); }
  mkdirp(p) { return this._act('mkdirp', p); }
  atype(p) { return this._act('atype', p); }
  rmdirRecursive(p, cb, allow) { return this._act('rmdirRecursive', p, cb, allow); }
  copyPath(s, d, o) { return this._act('copyPath', s, d, o); }
  exec(cmd, o) { return this._act('exec', cmd, o); }
  execBackground(cmd, o) { return this._act('execBackground', cmd, o); }
  shell(o) { return this._act('shell', o); }
  kill(runId, o) { return this.active ? this.active.kill(runId, o) : false; }
  cdCommand(cmd) { return this.active ? this.active.cdCommand(cmd) : cmd; }

  _act(name, ...args) {
    const c = this.active;
    if (!c) {
      if (name === 'isProbablyBinary') return false;
      return Promise.reject(new Error('SSH 未连接'));
    }
    return c[name](...args);
  }
}

export const sshManager = new SshManager();