// SSH 连接管理器:建立/保活/自动重连,SFTP 文件操作,exec 命令执行
import { EventEmitter } from 'node:events';
import { Client } from 'ssh2';
import { SSH, EXEC, FILE } from './config.js';

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

export class SshManager extends EventEmitter {
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
    this.workspace = null;// 用户选择的工作区
    this.execQueue = Promise.resolve();
    this.hostInfo = null; // {host,port,username}
  }

  get connected() { return this.status === 'connected'; }

  // ---------- 连接生命周期 ----------
  async connect(opts) {
    this.desired = true;
    this.opts = opts;
    this.retry = 0;
    this.hostInfo = { host: opts.host, port: opts.port, username: opts.username };
    await this._open();
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
  // 返回 { code, signal, stdout, stderr } ;onOut/onErr 实时回调;截断已处理
  exec(cmd, { timeout, onOut, onErr, maxOutput = EXEC.MAX_OUTPUT_CHARS } = {}) {
    // 串行队列,避免并发通道互相干扰
    const run = this.execQueue.then(() => this._execRaw(cmd, { timeout, onOut, onErr, maxOutput }));
    this.execQueue = run.catch(() => {});
    return run;
  }

  _execRaw(cmd, { timeout = EXEC.DEFAULT_TIMEOUT_MS, onOut, onErr, maxOutput = EXEC.MAX_OUTPUT_CHARS } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.client) return reject(new Error('SSH 未连接'));
      const t = Math.min(timeout, EXEC.MAX_TIMEOUT_MS);
      let stdout = '', stderr = '';
      let timedOut = false;
      const addOut = (s) => { stdout += s; if (stdout.length > maxOutput) stdout = stdout.slice(0, maxOutput); onOut?.(s); };
      const addErr = (s) => { stderr += s; if (stderr.length > maxOutput) stderr = stderr.slice(0, maxOutput); onErr?.(s); };
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => {
        timedOut = true;
        onErr?.('\n[超时: 命令超过 ' + (t / 1000) + 's 仍未结束,已终止]\n');
        try { stream.close(); } catch {}
        try { stream.end(); } catch {}
        // 等待 close 事件再结算
        setTimeout(() => finish({ code: -1, signal: 'TIMEOUT', stdout, stderr, timedOut }), 500);
      }, t);

      this.client.exec(cmd, { pty: false }, (err, stream) => {
        if (err) return finish({ code: -1, signal: null, stdout, stderr, error: err.message });
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
      const want = Math.min(maxBytes, Math.max(0, size - offset));
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

  async writeRemoteFile(p, content) {
    if (!this.sftp) throw new Error('SFTP 未就绪');
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (buf.length > FILE.WRITE_MAX_BYTES) throw new Error(`文件过大(>${Math.round(FILE.WRITE_MAX_BYTES / 1024 / 1024)}MB): ${p}`);
    await this.mkdirp(remoteDirName(p));
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

  async rmdirRecursive(p) {
    const st = await this.atype(p);
    if (st === 'file' || st === 'link') {
      await call((cb) => this.sftp.unlink(p, cb));
      return;
    }
    const list = await this.listDir(p);
    for (const e of list) {
      await this.rmdirRecursive(joinRemote(p, e.name));
    }
    await call((cb) => this.sftp.rmdir(p, cb));
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
}

function remoteDirName(p) {
  const n = normalizeRemote(p);
  const i = n.lastIndexOf('/');
  return i <= 0 ? '/' : n.slice(0, i);
}

export const sshManager = new SshManager();