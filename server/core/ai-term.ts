// AI 运行终端:被 AI 拉起的项目进程(npm run dev / vite / next dev / python -m http.server …)
// 在服务端持有一个带 PTY 的进程,输出实时广播给前端「运行终端」面板。
//
// 数据流:
//   远程 = ssh2 的非交互 PTY 通道(core/ssh-manager.ts ptyExec),命令退出 → 通道 close → 拿到退出码
//   本地 = node-pty 直接起命令进程,进程退出 → onExit → 拿到退出码
//
// 只读语义:通道不接受键盘输入,前端 xterm 也禁用输入;用户唯一能做的操作是删除
// (= 停止进程 + 从列表移除),与「不允许操控,只允许删除」的约束一致。
//
// 「运行终端」= 正在运行的终端:list() 只返回 state==='running' 的条目。
// 进程结束后条目从运行列表消失(退出码/日志在 FINISHED_TTL_MS 内仍可由 get()/log() 读到,
// 供工具侧的「是否秒退」判定与诊断使用),之后被惰性回收。
//
// 事件(经 setAiTermHub 广播给前端,type='ai_term'):
//   start   { term }              新终端已登记(进程可能仍在启动)
//   output  { id, data }          实时输出(原始终端流,含 ANSI)
//   exit    { term }              进程自行结束(此后该终端不再出现在运行列表里)
//   removed { id }                终端被删除 / 被回收
import * as pty from 'node-pty';
import type { ClientChannel } from 'ssh2';
import { sshManager as ssh, type SshConnection } from './ssh-manager.ts';
import { localFs } from './local-fs.ts';

export type AiTermTarget = 'remote' | 'local';
export type AiTermState = 'running' | 'exited' | 'failed';

/** 对外快照(不含日志正文;日志按需通过 log(id) 取) */
export interface AiTermInfo {
  id: string;
  /** 归属会话 id(仅用于展示/追溯,面板本身跨会话可见) */
  sid: string | null;
  /** 人类可读的标签:优先用工具的 description,缺失时取命令行首段 */
  label: string;
  command: string;
  target: AiTermTarget;
  /** 启动时的工作目录(远程=远程工作区,本地=本地工作区/家目录) */
  cwd: string | null;
  /** 远程:user@host:port;本地:'本机' */
  host: string;
  state: AiTermState;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  /** 结束原因补充(exit 时写入,如连接断开) */
  note?: string | null;
}

export interface AiTermStartOptions {
  command: string;
  sid?: string | null;
  /** 展示用标签(一般传工具的 description) */
  label?: string;
  target?: AiTermTarget;
  cols?: number;
  rows?: number;
}

interface Hub {
  emit: (event: string, payload: any) => void;
}

interface Entry {
  info: AiTermInfo;
  log: string;
  pty: pty.IPty | null;
  chan: ClientChannel | null;
  conn: SshConnection | null;
  removed: boolean;
}

// 单个终端的日志上限(保留尾部;dev server 长期运行也不会无限吃内存)
const MAX_LOG_CHARS = 200_000;
// 终端的条数上限:超出时优先淘汰已结束的旧终端
const MAX_TERMS = 12;
// 已结束条目的保留时长:仅供 get()/log()/waitForExit 读取,不进入运行列表
const FINISHED_TTL_MS = 60_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

function localShellArgs(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-c', command] };
}

/** 远程工作区前缀:cd 进会话绑定的工作区(优先 scoped workspace,而非连接级) */
function remoteCdPrefix(conn: SshConnection, ws: string | null): string {
  if (!ws) return '';
  if (conn.platform === 'win32') return `cd /d "${String(ws).replace(/"/g, '""')}" && `;
  return `cd '${String(ws).replace(/'/g, `'\\''`)}' && `;
}

function hostLabel(conn: SshConnection | null): string {
  const hi = conn?.hostInfo;
  if (!hi || !hi.host) return '远程';
  return `${hi.username ? `${hi.username}@` : ''}${hi.host}${hi.port ? `:${hi.port}` : ''}`;
}

function defaultLabel(command: string): string {
  const first = String(command).replace(/\s+/g, ' ').trim();
  return first.length > 48 ? first.slice(0, 47) + '…' : first;
}

export class AiTermManager {
  private terms = new Map<string, Entry>();
  private seq = 0;
  private hub: Hub | null = null;

  setHub(hub: Hub | null): void { this.hub = hub; }

  private send(event: string, payload: any): void {
    try { this.hub?.emit(event, payload); } catch { /* 广播失败不影响进程本身 */ }
  }

  private snapshot(e: Entry): AiTermInfo { return { ...e.info }; }

  /** 运行中的终端(面板与 list_project_terminals 的唯一数据源) */
  list(): AiTermInfo[] {
    this.prune();
    return [...this.terms.values()]
      .filter((e) => e.info.state === 'running')
      .map((e) => this.snapshot(e))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** 单个终端(含刚结束、仍在保留期内的条目,供诊断/秒退判定) */
  get(id: string): AiTermInfo | null {
    const e = this.terms.get(String(id));
    return e ? this.snapshot(e) : null;
  }

  log(id: string): string {
    return this.terms.get(String(id))?.log || '';
  }

  count(): number { return this.terms.size; }
  runningCount(): number { return [...this.terms.values()].filter((e) => e.info.state === 'running').length; }

  /**
   * 等待终端结束(用于「background 命令是否秒退」判定):
   * 在 ms 内结束则返回结束后的快照,超时仍运行则返回 null。
   */
  async waitForExit(id: string, ms: number): Promise<AiTermInfo | null> {
    const key = String(id);
    const end = Date.now() + Math.max(0, ms);
    for (;;) {
      const t = this.get(key);
      if (!t) return null;
      if (t.state !== 'running') return t;
      if (Date.now() >= end) return null;
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  /** 终止并移除一个终端(前端「删除」= 停止 + 移除) */
  async remove(id: string): Promise<boolean> {
    const key = String(id);
    const e = this.terms.get(key);
    if (!e) return false;
    e.removed = true;
    this.killEntry(e);
    this.terms.delete(key);
    this.send('removed', { id: key });
    return true;
  }

  /** 批量终止某个会话拉起的终端(会话删除时调用) */
  async removeForSession(sid: string | null | undefined): Promise<void> {
    if (!sid) return;
    const doomed = [...this.terms.values()].filter((e) => e.info.sid === sid);
    for (const e of doomed) await this.remove(e.info.id);
  }

  /** 连接断开:该连接上的远程终端已随连接一起死掉 */
  failForConn(conn: SshConnection | null): void {
    if (!conn) return;
    for (const e of this.terms.values()) {
      if (e.conn !== conn || e.info.state !== 'running') continue;
      this.finish(e, null, null, 'SSH 连接已断开');
    }
  }

  clear(): void {
    for (const e of this.terms.values()) { e.removed = true; this.killEntry(e); }
    this.terms.clear();
  }

  /** 调整 PTY 尺寸(前端 xterm fit 后同步,保证换行/进度条渲染与窗口一致) */
  resize(id: string, cols: number, rows: number): boolean {
    const e = this.terms.get(String(id));
    if (!e) return false;
    const c = Math.max(2, Math.min(500, cols | 0 || DEFAULT_COLS));
    const r = Math.max(2, Math.min(300, rows | 0 || DEFAULT_ROWS));
    try { e.pty?.resize(c, r); } catch { /* 已退出 */ }
    try { e.chan?.setWindow(r, c, 0, 0); } catch { /* 已关闭 */ }
    return true;
  }

  /**
   * 拉起一个 AI 运行终端。
   * 注意:必须在 agent 工具执行作用域内同步调用(需要读取 scoped workspace / active 连接),
   * 因此这里先同步抓取上下文,再做异步启动。
   */
  async start(opts: AiTermStartOptions): Promise<AiTermInfo> {
    const command = String(opts.command || '').trim();
    if (!command) throw new Error('命令为空');
    const target: AiTermTarget = opts.target === 'local' ? 'local' : 'remote';

    // ---- 同步抓取上下文(await 之后 ALS 作用域可能已失效) ----
    let conn: SshConnection | null = null;
    let ws: string | null = null;
    let cwd: string | null = null;
    let host = '本机';
    if (target === 'remote') {
      conn = ssh.active;
      if (!conn || !conn.connected) throw new Error('SSH 未连接,无法在远程启动运行终端;请改用 run_local_command 或先连接服务器');
      ws = ssh.workspace || null;
      cwd = ws;
      host = hostLabel(conn);
    } else {
      cwd = localFs.workspace || localFs.home || null;
    }

    this.prune();
    this.evictIfNeeded();

    const id = `ait-${(++this.seq).toString(36)}${Date.now().toString(36).slice(-4)}`;
    const info: AiTermInfo = {
      id,
      sid: opts.sid ?? null,
      label: String(opts.label || '').trim() || defaultLabel(command),
      command,
      target,
      cwd,
      host,
      state: 'running',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      note: null
    };
    const entry: Entry = { info, log: '', pty: null, chan: null, conn, removed: false };
    this.terms.set(id, entry);
    this.send('start', { term: this.snapshot(entry) });

    try {
      if (target === 'local') this.startLocal(entry, command, cwd);
      else await this.startRemote(entry, conn as SshConnection, command, ws, opts.cols, opts.rows);
    } catch (e: any) {
      this.terms.delete(id);
      this.send('removed', { id });
      throw e;
    }
    return this.snapshot(entry);
  }

  // ---------------- 内部:启动 ----------------

  private startLocal(entry: Entry, command: string, cwd: string | null): void {
    const { file, args } = localShellArgs(command);
    let term: pty.IPty;
    try {
      term = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd: cwd || undefined,
        env: process.env as { [k: string]: string }
      });
    } catch (e: any) {
      throw new Error(`启动本机运行终端失败: ${e?.message || e}`);
    }
    entry.pty = term;
    if (cwd) localFs.localTermCwds.add(cwd); // 与命令台一致:记录占用目录,重命名时报 EBUSY 可提示
    term.onData((d: string) => this.append(entry, d));
    term.onExit((ev: { exitCode?: number; signal?: number }) => {
      if (cwd) localFs.localTermCwds.delete(cwd);
      this.finish(entry, typeof ev?.exitCode === 'number' ? ev.exitCode : null, ev?.signal ? `SIG${ev.signal}` : null);
    });
  }

  private async startRemote(entry: Entry, conn: SshConnection, command: string, ws: string | null, cols?: number, rows?: number): Promise<void> {
    const full = remoteCdPrefix(conn, ws) + command;
    const chan = await conn.ptyExec(full, {
      runId: entry.info.id,
      cols: cols && cols > 0 ? cols : DEFAULT_COLS,
      rows: rows && rows > 0 ? rows : DEFAULT_ROWS,
      onData: (d) => this.append(entry, d.toString('utf8')),
      onExit: (code, signal) => this.finish(entry, code, signal)
    });
    // 命令可能在通道打开前就结束(exit 回调已把状态改写):此时不要再登记通道
    if (entry.removed || entry.info.state !== 'running') { try { chan.close(); } catch { /* 忽略 */ } return; }
    entry.chan = chan;
  }

  // ---------------- 内部:输出 / 收尾 ----------------

  private append(entry: Entry, data: string): void {
    if (!data || entry.removed) return;
    entry.log += data;
    if (entry.log.length > MAX_LOG_CHARS) entry.log = entry.log.slice(entry.log.length - MAX_LOG_CHARS);
    this.send('output', { id: entry.info.id, data });
  }

  private finish(entry: Entry, code: number | null, signal: string | null, note?: string): void {
    if (entry.info.state !== 'running') return;
    const failed = code == null ? !!note : code !== 0;
    entry.info.state = failed ? 'failed' : 'exited';
    entry.info.exitCode = code;
    entry.info.endedAt = Date.now();
    if (note) entry.info.note = note;
    else if (code != null && code !== 0) entry.info.note = signal ? `信号 ${signal}` : null;
    entry.pty = null;
    entry.chan = null;
    // 结束后即从「运行列表」消失;条目保留一小段时间供 get()/log()/waitForExit 读取
    if (!entry.removed) this.send('exit', { term: this.snapshot(entry) });
  }

  private killEntry(entry: Entry): void {
    const { pty: term, chan, conn } = entry;
    entry.pty = null;
    entry.chan = null;
    if (term) { try { term.kill(); } catch { /* 已退出 */ } }
    if (chan && conn) {
      // 通过登记的 runId 走连接的 kill:先 SIGINT(等价 Ctrl+C),宽限期后 KILL + 关通道
      try { conn.kill(entry.info.id, { graceMs: 1500 }); } catch { /* 通道已关闭 */ }
      try { chan.close(); } catch { /* 忽略 */ }
    }
  }

  /** 回收保留期已过的已结束条目 */
  private prune(): void {
    const now = Date.now();
    for (const [id, e] of [...this.terms]) {
      if (e.info.state === 'running') continue;
      if (e.info.endedAt && now - e.info.endedAt > FINISHED_TTL_MS) {
        this.terms.delete(id);
        this.send('removed', { id });
      }
    }
  }

  private evictIfNeeded(): void {
    if (this.terms.size < MAX_TERMS) return;
    const finished = [...this.terms.values()]
      .filter((e) => e.info.state !== 'running')
      .sort((a, b) => (a.info.endedAt || a.info.startedAt) - (b.info.endedAt || b.info.startedAt));
    for (const e of finished) {
      if (this.terms.size < MAX_TERMS) break;
      this.terms.delete(e.info.id);
      this.send('removed', { id: e.info.id });
    }
  }
}

export const aiTerms = new AiTermManager();

// 连接意外断开:该连接上仍在运行的远程终端已随之终止,标记为 failed(不删除,用户可回看日志)
ssh.on('connection-lost', (_key: string, conn: SshConnection | null) => aiTerms.failForConn(conn));
