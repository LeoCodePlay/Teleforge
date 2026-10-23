// 浏览器扩展桥接:把「本机真实浏览器」接入 AI 控制。
//
// 扩展(仓库根的 extension/)以 WebSocket 反向连到 /ws/ext(upgrade 路由见 core/ws.ts),
// 本模块负责四件事:
//   1) 配对鉴权 —— 只有拿着 data/browser-bridge.json 里那份 token 的扩展能连上。
//      这不是可选项:WebSocket 不受同源策略限制,任意本机网页都能连 ws://127.0.0.1:4000/*,
//      而"接管浏览器"是高危能力,没有 token 就等于把用户的浏览器交出去。
//   2) 多浏览器连接表 —— 同一台机器上常常同时开着 Chrome 和 Edge(各装了一份同一扩展),
//      每个浏览器实例一条 WebSocket,各自持有**独立的**标签清单、标签授权与操作模式。
//      旧实现只保留"最后一条连接"(新连接顶掉旧的),两个浏览器会以 1s 的重连节奏互相顶掉,
//      表现就是状态点永远在闪、刚连上又断开 —— 见 attach()/finishHello()。
//   3) 请求应答 —— call() 发 ext_call,按自增 id 与扩展回传的 ext_result 配对。
//   4) 标签授权 / 状态事件 —— 连接/断开/标签变化通过 'change' 通知前端(ws.ts 广播给 /ws)。
//
// 与 core/browser-manager.ts 的分工:那个是 Playwright 拉起的「内置预览」(兜底,用户什么都不用装);
// 这个是用户日常那个带登录态的浏览器。两者在 agent/browser-backends.ts 里按
// 「扩展在线且已授权 → 真机;否则 → 内置预览」路由。
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { DATA_DIR } from '../config.ts';
import { SNAPSHOT_SCRIPT } from './browser-manager.ts';

export type BridgeMode = 'ai-tabs' | 'all';

/** 扩展上报的标签(不含授权判定结果) */
export interface ExtTabRaw {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  /** 这个标签是从哪个标签里打开的(链接 target=_blank / window.open);用来把 AI 开的子标签也归给 AI */
  openerTabId?: number | null;
}

/** 对外(前端/工具层)看到的标签:带上本端算出的授权判定 */
export interface ExtTab extends ExtTabRaw {
  /** AI 自己创建的标签(自动可操作) */
  owned: boolean;
  /** 用户显式授权给 AI 的标签 */
  granted: boolean;
  /** 当前是否允许 AI 操作 */
  allowed: boolean;
}

/** 一条扩展连接(一个浏览器实例)对外可见的摘要 */
export interface BridgeConnection {
  /** 浏览器实例标识(扩展生成并持久化;旧版扩展没上报时是本次连接的临时 id) */
  id: string;
  /** 界面/工具里显示的名字:Chrome / Edge / Opera … */
  label: string;
  /** 内核名:chrome / edge / opera … */
  browser: string;
  version: string | null;
  online: boolean;
  connectedAt: number | null;
  mode: BridgeMode;
  tabCount: number;
  /** 扩展协议版本(2 = 支持 batch / snapshot-v2 / act;1 = 旧版) */
  protocol: number;
}

export interface BridgeStatus {
  /** 默认目标那台浏览器是否在线(单浏览器时与旧版语义完全一致) */
  online: boolean;
  version: string | null;
  browser: string | null;
  connectedAt: number | null;
  mode: BridgeMode;
  tabs: ExtTab[];
  error: string | null;
  /** 这份视图对应的连接(默认目标);没有在线连接时为 null */
  id: string | null;
  label: string | null;
  /** 同时在线的真机浏览器数量(>1 时工具层可用 browser 参数指定要操作哪台) */
  onlineCount: number;
  /** 全部在线连接(多浏览器时前端/工具据此列出可选项) */
  connections: BridgeConnection[];
  /** 默认目标的扩展协议版本(null = 没连上) */
  protocolVersion: number | null;
  /** 域名白/黑名单(用户级策略,存在 browser-bridge.json) */
  domains: { allowed: string[]; blocked: string[] };
}

/** 扩展上线时回传的自我介绍 */
interface ExtHello {
  type: 'ext_hello';
  token?: string;
  version?: string;
  browser?: string;
  /** 协议版本:2 支持 batch / snapshot-v2 / act(旧扩展没有这个字段) */
  protocol?: number;
  /** 浏览器实例 id:扩展首次配对时生成并写进 chrome.storage.local,重连不变 */
  instanceId?: string;
  capabilities?: string[];
}

const PAIR_FILE = path.join(DATA_DIR, 'browser-bridge.json');
const CALL_TIMEOUT_MS = 30_000;
/** 应用层心跳:MV3 的 service worker 在 WebSocket 有收发时不会被回收,20s 一次足以维持常驻 */
const PING_MS = 20_000;
const HELLO_TIMEOUT_MS = 10_000;

/** token 与配对信息落盘(只在本机可读的 data 目录) */
interface PairRecord {
  token: string;
  createdAt: number;
  /** 只允许 AI 访问这些域(为空 = 不限制);支持 *.example.com */
  allowedDomains?: string[];
  /** 禁止 AI 访问这些域(优先级高于 allowedDomains) */
  blockedDomains?: string[];
  /**
   * 按浏览器实例持久化的授权状态。
   * 为什么必须落盘:AI 用 browser_open 开的标签如果只记在内存里,服务端一重启、
   * 或扩展被 MV3 回收后重连,这些标签就全变成"没有授权",用户下次读页面直接失败。
   */
  auth?: Record<string, { mode: BridgeMode; grantedTabs: number[]; aiTabs: number[] }>;
}

/** 域名规则匹配:精确、后缀(*.example.com)与裸域等价 */
function domainMatches(host: string, rule: string): boolean {
  const h = String(host || '').toLowerCase().trim();
  let r = String(rule || '').toLowerCase().trim().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  if (!h || !r) return false;
  if (r.startsWith('*.')) r = r.slice(2);
  if (r.startsWith('.')) r = r.slice(1);
  return h === r || h.endsWith('.' + r);
}

/** 内核名 → 界面/工具里显示的名字(多浏览器时用来区分"哪一台") */
function browserLabel(browser: string): string {
  switch (String(browser || '').toLowerCase()) {
    case 'edge': return 'Edge';
    case 'chrome': return 'Chrome';
    case 'opera': return 'Opera';
    case 'firefox': return 'Firefox';
    default: return String(browser || '浏览器');
  }
}

/**
 * 一个浏览器实例的全部连接状态。
 * 标签清单 / 标签授权 / 操作模式都是**按连接隔离**的:Chrome 与 Edge 的 tabId 会重复
 * (两边都从 1 开始编号),合并成一份会把 A 浏览器授权的标签算到 B 头上。
 */
class ExtConn {
  id: string;
  ws: WebSocket;
  ready = false;
  /** 该连接是否已上报过实例 id(旧版扩展没有,退化成"每次连接一个临时 id") */
  labeled = false;
  browser = 'chrome';
  version: string | null = null;
  /** 扩展协议版本(旧扩展不上报,按 1 处理) */
  protocol = 1;
  connectedAt: number | null = null;
  mode: BridgeMode = 'ai-tabs';
  grantedTabs = new Set<number>();
  aiTabs = new Set<number>();
  tabs: ExtTabRaw[] = [];
  lastError: string | null = null;
  seq = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  pingTimer: NodeJS.Timeout | null = null;
  helloTimer: NodeJS.Timeout | null = null;
  tabsTimer: NodeJS.Timeout | null = null;
  /** 幂等标记:close 与 error 会各触发一次清理 */
  dropped = false;

  constructor(id: string, ws: WebSocket) {
    this.id = id;
    this.ws = ws;
  }

  get label(): string {
    return browserLabel(this.browser);
  }

  get online(): boolean {
    return this.ready && !this.dropped && this.ws.readyState === 1;
  }
}

class BrowserBridge extends EventEmitter {
  private pair: PairRecord | null = null;
  /** 已握手完成的连接:实例 id → 连接(同一个 id 重连时替换,保持插入顺序) */
  private conns = new Map<string, ExtConn>();
  /** 已 attach 但还没上报实例的连接(握手超时前) */
  private pendingConns = new Set<ExtConn>();
  /**
   * 默认目标浏览器(工具层没指定 browser 时用它)。
   * 规则:显式选过 → 记住它;否则第一台连上的;它掉线了就顺延到下一台在线浏览器。
   */
  private activeId: string | null = null;
  /**
   * 实例的授权/模式快照,连接断开后仍保留:用户"交给 AI"的标签不该因为
   * service worker 重启 / 网络抖动换了一条 socket 就失效。上限 32 个实例,超出丢最早的。
   */
  private authByInstance = new Map<string, { mode: BridgeMode; grantedTabs: Set<number>; aiTabs: Set<number> }>();
  /** 连接层最近一次失败原因(token 不匹配 / 拒绝网页来源等),供前端提示 */
  private lastError: string | null = null;

  // ---------------- 配对 token ----------------

  /** 读取(必要时生成)配对 token;失败时抛错,由调用方决定怎么提示 */
  token(): string {
    if (this.pair) return this.pair.token;
    try {
      if (fs.existsSync(PAIR_FILE)) {
        const raw = JSON.parse(fs.readFileSync(PAIR_FILE, 'utf8'));
        if (raw && typeof raw.token === 'string' && raw.token.length >= 16) {
          this.pair = { token: raw.token, createdAt: Number(raw.createdAt) || Date.now() };
          return this.pair.token;
        }
      }
    } catch { /* 文件损坏:重新生成一份 */ }
    const rec: PairRecord = { token: crypto.randomBytes(24).toString('hex'), createdAt: Date.now() };
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(PAIR_FILE, JSON.stringify(rec, null, 2), 'utf8');
      try { fs.chmodSync(PAIR_FILE, 0o600); } catch { /* Windows 上忽略 */ }
    } catch { /* 落盘失败也先返回内存里的 token:至少本次运行可用 */ }
    this.pair = rec;
    return rec.token;
  }

  /** 重置配对 token(所有旧扩展立即掉线,用于"撤销设备") */
  resetToken(): string {
    this.pair = null;
    try { fs.rmSync(PAIR_FILE, { force: true }); } catch { /* 忽略 */ }
    const t = this.token();
    for (const conn of [...this.conns.values()]) this.closeConn(conn, 4403, 'token reset');
    // 正在握手(还没上报实例 id)的连接也要断,否则它会拿着旧 token 完成握手
    for (const conn of [...this.pendingConns]) this.closeConn(conn, 4403, 'token reset');
    this.authByInstance.clear();
    return t;
  }

  // ---------------- 域名策略 ----------------

  /** 读整份配对记录(token + 域名策略);文件损坏时退回内存里的那份 */
  private pairRecord(): PairRecord | null {
    try {
      if (fs.existsSync(PAIR_FILE)) {
        const raw = JSON.parse(fs.readFileSync(PAIR_FILE, 'utf8'));
        if (raw && typeof raw.token === 'string' && raw.token.length >= 16) return raw as PairRecord;
      }
    } catch { /* 下面回退 */ }
    return this.pair;
  }

  domains(): { allowed: string[]; blocked: string[] } {
    const rec = this.pairRecord();
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
    return { allowed: list(rec?.allowedDomains), blocked: list(rec?.blockedDomains) };
  }

  /**
   * 设置域名白/黑名单(用户级策略)。
   * allowed 非空 = 只允许这些域;blocked 永远优先。空数组 = 不限制。
   */
  setDomains(next: { allowed?: string[]; blocked?: string[] }): { allowed: string[]; blocked: string[] } {
    const rec: PairRecord = this.pairRecord() || { token: this.token(), createdAt: Date.now() };
    const clean = (v: unknown) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean).slice(0, 200) : []);
    rec.allowedDomains = clean(next?.allowed);
    rec.blockedDomains = clean(next?.blocked);
    this.pair = rec;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(PAIR_FILE, JSON.stringify(rec, null, 2), 'utf8');
      try { fs.chmodSync(PAIR_FILE, 0o600); } catch { /* Windows 上忽略 */ }
    } catch { /* 落盘失败仍生效于本次运行 */ }
    this.emit('change', this.status());
    return this.domains();
  }

  /** 某次导航/操作是否被域名策略允许 */
  checkDomain(url: string): { ok: true } | { ok: false; reason: string } {
    const { allowed, blocked } = this.domains();
    if (!allowed.length && !blocked.length) return { ok: true };
    let host = '';
    try { host = new URL(String(url || '')).hostname; } catch { return { ok: true }; }
    if (!host) return { ok: true };
    if (blocked.some((r) => domainMatches(host, r))) {
      return { ok: false, reason: `域名 ${host} 在禁止清单里(浏览器桥接的域名策略),AI 不能操作它` };
    }
    if (allowed.length && !allowed.some((r) => domainMatches(host, r))) {
      return { ok: false, reason: `域名 ${host} 不在允许清单里(当前只允许:${allowed.join('、')})` };
    }
    return { ok: true };
  }

  // ---------------- 授权状态持久化 ----------------

  private authSaveTimer: NodeJS.Timeout | null = null;

  /** 把一条连接的授权记进内存快照(断开后仍保留),并节流落盘 */
  private rememberAuth(conn: ExtConn): void {
    if (!conn.labeled) return; // 旧扩展没有稳定实例 id:落盘后 tabId 也不可靠
    this.authByInstance.set(conn.id, {
      mode: conn.mode,
      grantedTabs: new Set(conn.grantedTabs),
      aiTabs: new Set(conn.aiTabs)
    });
    if (this.authByInstance.size > 32) {
      const oldest = this.authByInstance.keys().next().value;
      if (oldest !== undefined && oldest !== conn.id) this.authByInstance.delete(oldest);
    }
    this.scheduleAuthFlush();
  }

  private scheduleAuthFlush(): void {
    if (this.authSaveTimer) return;
    this.authSaveTimer = setTimeout(() => {
      this.authSaveTimer = null;
      this.flushAuth();
    }, 300);
    this.authSaveTimer.unref?.();
  }

  /** 立刻把内存里的授权写进 browser-bridge.json(保留 token / 域名策略 / 其它实例的历史授权) */
  private flushAuth(): void {
    const rec: PairRecord = this.pairRecord() || { token: this.token(), createdAt: Date.now() };
    // 与磁盘上的旧记录合并,而不是整体覆盖:内存里可能只是"暂时没有这个实例"
    // (服务端刚重启、连接还没握手),整体覆盖会把上次落盘的 AI 标签授权抹掉。
    const auth: NonNullable<PairRecord['auth']> = { ...(rec.auth || {}) };
    for (const [id, a] of this.authByInstance) {
      auth[id] = { mode: a.mode, grantedTabs: [...a.grantedTabs], aiTabs: [...a.aiTabs] };
    }
    rec.auth = auth;
    this.pair = rec;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(PAIR_FILE, JSON.stringify(rec, null, 2), 'utf8');
      try { fs.chmodSync(PAIR_FILE, 0o600); } catch { /* Windows 上忽略 */ }
    } catch { /* 落盘失败仍保留内存状态 */ }
  }

  /** 从磁盘恢复某实例的授权(连接握手时用) */
  private diskAuth(id: string): { mode: BridgeMode; grantedTabs: Set<number>; aiTabs: Set<number> } | null {
    try {
      const a = this.pairRecord()?.auth?.[id];
      if (!a) return null;
      return {
        mode: a.mode === 'all' ? 'all' : 'ai-tabs',
        grantedTabs: new Set((a.grantedTabs || []).filter(Number.isFinite)),
        aiTabs: new Set((a.aiTabs || []).filter(Number.isFinite))
      };
    } catch { return null; }
  }

  // ---------------- 连接与鉴权 ----------------

  /**
   * upgrade 阶段的准入检查(token 必须匹配;带 Origin 的连接必须是扩展来源)。
   * 在 core/ws.ts 的 upgrade 路由里调用 —— 不通过就直接 destroy socket,连 WS 都不建立。
   */
  authorizeUpgrade(req: IncomingMessage): boolean {
    let token = '';
    try {
      token = new URL(String(req.url || '/ws/ext'), 'http://127.0.0.1').searchParams.get('token') || '';
    } catch { return false; }
    if (!token) {
      // 新扩展把 token 放在子协议里(Sec-WebSocket-Protocol: tf.<token>):
      // 不落在 URL 上,就不会被访问日志 / 代理 / 截图里的地址栏记下来。
      const proto = String((req.headers as any)?.['sec-websocket-protocol'] || '');
      const m = /(?:^|,)\s*tf\.([A-Za-z0-9_-]{16,})\s*(?:,|$)/.exec(proto);
      if (m) token = m[1];
    }
    if (!token) return false;
    let expected: string;
    try { expected = this.token(); } catch { return false; }
    if (!timingSafeEqual(token, expected)) {
      this.lastError = '配对 token 不匹配(请在扩展 popup 里重新获取)';
      return false;
    }
    const origin = String(req.headers?.origin || '').trim();
    // 网页发起的 WS 一定带 Origin(http/https);扩展的 Origin 是 chrome-extension://<id>。
    // 本机脚本类客户端可能不带 Origin —— 它们仍要过 token 这一关,所以放行。
    if (origin && !origin.startsWith('chrome-extension://') && !origin.startsWith('moz-extension://')) {
      this.lastError = `拒绝来自网页的桥接连接(Origin: ${origin})`;
      return false;
    }
    return true;
  }

  /** 扩展连接建立:挂消息处理、起心跳,等 ext_hello 上报实例身份 */
  attach(ws: WebSocket): void {
    const conn = new ExtConn('', ws);
    this.pendingConns.add(conn);
    (ws as any).isAlive = true;
    ws.on('pong', () => { (ws as any).isAlive = true; });

    // 握手超时:连上却不自报家门的连接直接踢掉(挡住"连上但不说话"的占位)
    conn.helloTimer = setTimeout(() => {
      if (conn.ready || conn.dropped) return;
      conn.lastError = '扩展握手超时';
      try { ws.close(4408, 'hello timeout'); } catch { /* 忽略 */ }
    }, HELLO_TIMEOUT_MS);

    ws.on('message', (raw: any, isBinary: boolean) => {
      if (isBinary) return;
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      this.onMessage(conn, msg);
    });
    ws.on('close', () => this.dropConn(conn));
    ws.on('error', () => this.dropConn(conn));

    conn.pingTimer = setInterval(() => {
      if (conn.dropped || conn.ws.readyState !== 1) return;
      try { conn.ws.send(JSON.stringify({ type: 'ext_ping', ts: Date.now() })); } catch { /* 忽略 */ }
    }, PING_MS);
  }

  /** 扩展断开:清空该连接的状态、拒绝所有在途调用 */
  private dropConn(conn: ExtConn): void {
    if (conn.dropped) return;
    conn.dropped = true;
    this.pendingConns.delete(conn);
    conn.ready = false;
    if (conn.pingTimer) { clearInterval(conn.pingTimer); conn.pingTimer = null; }
    if (conn.helloTimer) { clearTimeout(conn.helloTimer); conn.helloTimer = null; }
    if (conn.tabsTimer) { clearTimeout(conn.tabsTimer); conn.tabsTimer = null; }
    for (const [, p] of conn.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('真机浏览器连接已断开(扩展被关闭或休眠);已回退内置预览,请重试'));
    }
    conn.pending.clear();
    // 同一个实例被新连接替换时,map 里已经是新连接了,不能顺手删掉(也不能盖掉新连接的授权)
    if (this.conns.get(conn.id) === conn) {
      if (conn.labeled) this.rememberAuth(conn);
      this.conns.delete(conn.id);
    }
    if (this.activeId === conn.id && !this.conns.has(conn.id)) {
      this.activeId = this.onlineConns()[0]?.id ?? null;
    }
    this.emit('change', this.status());
  }

  private closeConn(conn: ExtConn, code: number, reason: string): void {
    if (conn.lastError == null) conn.lastError = reason;
    try { conn.ws.close(code, reason); } catch { /* 忽略 */ }
  }

  private finishHello(conn: ExtConn, hello: ExtHello): void {
    let expected = '';
    try { expected = this.token(); } catch { /* 下面必然失败 */ }
    if (!expected || !timingSafeEqual(String(hello.token || ''), expected)) {
      conn.lastError = '扩展提供的 token 不正确';
      try { conn.ws.close(4401, 'bad token'); } catch { /* 忽略 */ }
      return;
    }
    // 没上报实例 id(旧版扩展)时用本次连接的临时 id:同一浏览器重连会换新 id,
    // 但至少不会和别的浏览器互相顶掉。
    const reported = String(hello.instanceId || '').trim();
    const id = reported || conn.id || `tmp-${crypto.randomBytes(4).toString('hex')}`;
    // 同一台浏览器重连:授权与操作模式跟着实例走(旧连接已断开时从快照恢复,
    // 还没断开时直接从旧连接搬),不能因为换了一条 socket 就把用户"交给 AI"的标签忘掉
    const kept = this.authByInstance.get(id);
    if (kept) {
      conn.mode = kept.mode;
      conn.grantedTabs = new Set(kept.grantedTabs);
      conn.aiTabs = new Set(kept.aiTabs);
    }
    const prev = this.conns.get(id);
    if (prev && prev !== conn) {
      conn.mode = prev.mode;
      conn.grantedTabs = prev.grantedTabs;
      conn.aiTabs = prev.aiTabs;
      this.closeConn(prev, 4409, 'replaced by a newer connection');
    } else if (!kept) {
      // 服务端重启过(内存里的 authByInstance 没了):从磁盘把"AI 开过的标签 / 用户授权的标签"捞回来。
      // 不这么做的话,重启前 AI 自己开的标签会在重启后变成"没有授权",读页面直接失败。
      const disk = this.diskAuth(id);
      if (disk) {
        conn.mode = disk.mode;
        conn.grantedTabs = new Set(disk.grantedTabs);
        conn.aiTabs = new Set(disk.aiTabs);
      }
    }

    if (conn.helloTimer) { clearTimeout(conn.helloTimer); conn.helloTimer = null; }
    this.pendingConns.delete(conn);
    conn.id = id;
    conn.labeled = !!reported;
    conn.ready = true;
    conn.browser = String(hello.browser || 'chrome');
    conn.version = String(hello.version || 'unknown');
    conn.protocol = Number(hello.protocol) || 1;
    conn.connectedAt = Date.now();
    conn.lastError = null;
    this.lastError = null;
    this.conns.set(id, conn);
    if (!this.activeId) this.activeId = id;

    // 快照脚本由服务端下发,而不是在扩展里再存一份:内置预览与真机浏览器永远跑同一份脚本,
    // 不会出现"改了服务端忘了改扩展"导致两边快照格式漂移。
    // SNAPSHOT_SCRIPT 里的 TS 类型注解在运行时已被 Node 的类型剥离替换成空白,
    // 所以 toString() 出来就是可执行的纯 JS(已实测)。
    try {
      conn.ws.send(JSON.stringify({
        type: 'ext_welcome',
        ok: true,
        heartbeatMs: PING_MS,
        mode: conn.mode,
        protocol: 2,
        // 兼容旧扩展:它们只会 eval 这段"已自执行"的表达式(拿不到 scope 参数)
        snapshotScript: `(${SNAPSHOT_SCRIPT.toString()})()`,
        // 新扩展用这个:调用时带 { scope, root, text, max },与内置预览跑同一份脚本
        snapshotScriptSrc: `(${SNAPSHOT_SCRIPT.toString()})`
      }));
    } catch { /* 忽略 */ }
    this.emit('change', this.status());
    void this.refreshTabs(conn);
  }

  private onMessage(conn: ExtConn, msg: any): void {
    if (msg.type === 'ext_hello') {
      this.finishHello(conn, msg as ExtHello);
      return;
    }
    if (msg.type === 'ext_result') {
      const id = Number(msg.id);
      const p = conn.pending.get(id);
      if (!p) return;
      conn.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(String(msg.error || '扩展执行失败')));
      return;
    }
    if (msg.type === 'ext_event') {
      // 扩展只在标签增删改时发一个"有变化"的通知,具体清单由本端重新拉取,避免两份状态漂移
      if (String(msg.event || '').startsWith('tab')) void this.refreshTabs(conn);
      return;
    }
    if (msg.type === 'ext_pong') {
      (conn.ws as any).isAlive = true;
    }
  }

  /** 拉取某条连接的标签清单(带 200ms 去抖:标签事件常常连着来一串) */
  private refreshTabs(conn: ExtConn): Promise<void> {
    if (conn.tabsTimer) clearTimeout(conn.tabsTimer);
    return new Promise((resolve) => {
      conn.tabsTimer = setTimeout(async () => {
        conn.tabsTimer = null;
        if (!conn.online) return resolve();
        try {
          const list = await this.callConn<ExtTabRaw[]>(conn, 'tabs.list', {});
          conn.tabs = Array.isArray(list) ? list : [];
          // AI(或用户授权)的标签里点开的子标签 —— 链接 target=_blank、window.open —— 自动归 AI 所有。
          // 否则 AI 点一下链接开了新标签,下一步去读它就会"没有授权",用户看到的就是"AI 开的标签也没权限"。
          let changed = false;
          for (let pass = 0; pass < 4; pass += 1) {
            for (const t of conn.tabs) {
              if (conn.aiTabs.has(t.tabId)) continue;
              const opener = Number(t.openerTabId);
              if (!Number.isFinite(opener)) continue;
              if (conn.aiTabs.has(opener) || conn.grantedTabs.has(opener)) {
                conn.aiTabs.add(t.tabId);
                changed = true;
              }
            }
          }
          // 关掉的标签会一直留在集合里:只裁剪"已经不在清单里"的,避免 tabId 被复用时误授权
          if (conn.aiTabs.size > 500) {
            for (const id of [...conn.aiTabs]) {
              if (conn.aiTabs.size <= 500) break;
              if (!conn.tabs.some((t) => t.tabId === id)) conn.aiTabs.delete(id);
            }
          }
          if (changed) this.rememberAuth(conn);
          this.emit('change', this.status());
        } catch { /* 拉取失败不影响连接本身 */ }
        resolve();
      }, 200);
    });
  }

  // ---------------- 连接解析 ----------------

  private onlineConns(): ExtConn[] {
    return [...this.conns.values()].filter((c) => c.online);
  }

  /**
   * 把「browser」参数解析成一条连接。接受:
   *   实例 id(完整或前缀)/ 内核名(chrome、edge)/ 显示名(Chrome、Edge)。
   * 解析成功会把它记为默认目标(下次不指定 browser 时就用它)。
   */
  private resolveConn(hint?: string | null): ExtConn | null {
    const h = String(hint || '').trim();
    if (!h) return this.defaultConn();
    const online = this.onlineConns();
    const exact = online.find((c) => c.id === h);
    if (exact) { this.activeId = exact.id; return exact; }
    const low = h.toLowerCase();
    const byName = online.filter((c) => c.browser.toLowerCase() === low || c.label.toLowerCase() === low);
    if (byName.length === 1) { this.activeId = byName[0].id; return byName[0]; }
    const byPrefix = online.filter((c) => c.id.toLowerCase().startsWith(low));
    if (byPrefix.length === 1) { this.activeId = byPrefix[0].id; return byPrefix[0]; }
    return null;
  }

  /** 默认目标:显式选过的 → 唯一在线的 → 第一台在线的 */
  private defaultConn(): ExtConn | null {
    const online = this.onlineConns();
    if (!online.length) return null;
    if (this.activeId) {
      const act = online.find((c) => c.id === this.activeId);
      if (act) return act;
    }
    return online[0];
  }

  /** 按 tabId 定位连接(多浏览器时 tabId 会重复,所以优先用连接自己的标签清单判定) */
  private connForTab(tabId: number, hint?: string | null): ExtConn | null {
    const h = String(hint || '').trim();
    if (h) {
      const picked = this.resolveConn(h);
      if (picked) return picked;
      return null;
    }
    const owners = this.onlineConns().filter((c) => c.tabs.some((t) => t.tabId === tabId));
    if (owners.length === 1) return owners[0];
    if (owners.length > 1) return owners.find((c) => c.id === this.activeId) || owners[0];
    return this.defaultConn();
  }

  /** 给模型/前端看的"现在有哪些浏览器"(可用 browser 参数指定) */
  availableHint(): string {
    const online = this.onlineConns();
    if (!online.length) return '当前没有真机浏览器在线。';
    return '当前在线的真机浏览器:' + online.map((c) => `${c.label}(id=${c.id.slice(0, 8)})`).join('、') + '。';
  }

  // ---------------- 对外 API ----------------

  isOnline(hint?: string | null): boolean {
    return this.resolveConn(hint) !== null;
  }

  /** 把 browser 参数解析成实例 id(工具层拼 id / 传给 call 用);解析不到返回 null */
  resolveInstanceId(hint?: string | null): string | null {
    return this.resolveConn(hint)?.id ?? null;
  }

  /**
   * 在当前/指定浏览器里开一个新标签,并**原子地**把它记为 AI 自建。
   *
   * 为什么放在桥接层:标签是在哪条连接上开的,只有 `tabs.open` 的应答现场知道。
   * 交给上层拿 tabId 反查连接,在"标签清单还没刷新"或"同时开着 Chrome + Edge"时会标到错的连接上,
   * 表现就是"AI 刚开的标签没有授权"。
   */
  async openTab(url: string, opts: { instance?: string | null; active?: boolean } = {}): Promise<{ tabId: number; url: string; title: string; instance: string }> {
    const conn = this.resolveConn(opts.instance);
    if (!conn) {
      throw new Error('真机浏览器未连接:请在浏览器里打开扩展 popup 完成配对(或改用 target=preview 走内置预览)');
    }
    const r = await this.callConn<any>(conn, 'tabs.open', { url, active: opts.active === true }, 60_000);
    const tabId = Number(r?.tabId);
    if (Number.isFinite(tabId)) {
      conn.aiTabs.add(tabId);
      this.noteOpenedTabOn(conn, tabId, {
        url: String(r?.url || url),
        title: String(r?.title || ''),
        active: opts.active === true
      });
      this.rememberAuth(conn);
      void this.refreshTabs(conn);
    }
    return { tabId, url: String(r?.url || url), title: String(r?.title || ''), instance: conn.id };
  }

  listConnections(): BridgeConnection[] {
    return this.onlineConns().map((c) => ({
      id: c.id,
      label: c.label,
      browser: c.browser,
      version: c.version,
      online: true,
      connectedAt: c.connectedAt,
      mode: c.mode,
      tabCount: c.tabs.length,
      protocol: c.protocol
    }));
  }

  status(hint?: string | null): BridgeStatus {
    const conn = this.resolveConn(hint);
    const connections = this.listConnections();
    return {
      online: conn !== null,
      version: conn?.version ?? null,
      browser: conn?.browser ?? null,
      connectedAt: conn?.connectedAt ?? null,
      mode: conn?.mode ?? 'ai-tabs',
      tabs: conn ? conn.tabs.map((t) => this.decorate(conn, t)) : [],
      error: conn?.lastError ?? this.lastError,
      id: conn?.id ?? null,
      label: conn?.label ?? null,
      onlineCount: connections.length,
      connections,
      protocolVersion: conn ? conn.protocol : null,
      domains: this.domains()
    };
  }

  /** 向指定(或默认)浏览器发一条指令并等结果;超时/断开都会 reject 成"可操作"的中文说明 */
  call<T = any>(method: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number; instance?: string | null } = {}): Promise<T> {
    const hint = String(opts.instance || '').trim();
    const conn = hint ? this.resolveConn(hint) : this.defaultConn();
    if (!conn || !conn.online) {
      const why = hint
        ? `找不到在线的浏览器「${hint}」。${this.availableHint()}`
        : '真机浏览器未连接:请在浏览器里打开扩展 popup 完成配对(或改用 target=preview 走内置预览)';
      return Promise.reject(new Error(why));
    }
    return this.callConn<T>(conn, method, params, opts.timeoutMs);
  }

  private callConn<T = any>(conn: ExtConn, method: string, params: Record<string, unknown> = {}, timeoutMs0?: number): Promise<T> {
    const id = ++conn.seq;
    const timeoutMs = Math.max(1000, Number(timeoutMs0) || CALL_TIMEOUT_MS);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`真机浏览器执行超时(${method} 超过 ${Math.round(timeoutMs / 1000)}s 未返回)`));
      }, timeoutMs);
      conn.pending.set(id, { resolve, reject, timer });
      try {
        conn.ws.send(JSON.stringify({ type: 'ext_call', id, method, params }));
      } catch (e: any) {
        clearTimeout(timer);
        conn.pending.delete(id);
        reject(new Error(`指令发送失败:${e?.message || e}`));
      }
    });
  }

  // ---------------- 标签授权 ----------------

  private decorate(conn: ExtConn, t: ExtTabRaw): ExtTab {
    const owned = conn.aiTabs.has(t.tabId);
    const granted = conn.grantedTabs.has(t.tabId);
    return { ...t, owned, granted, allowed: conn.mode === 'all' || owned || granted };
  }

  /** AI 是否可以操作该标签(工具层调用前必须过这一关):标签授权 + 域名策略 */
  canOperate(tabId: number, hint?: string | null): { ok: true } | { ok: false; reason: string } {
    const conn = this.connForTab(tabId, hint);
    if (!conn) {
      return { ok: false, reason: '真机浏览器未连接:请在浏览器里打开扩展 popup 完成配对(或改用 target=preview 走内置预览)' };
    }
    const tab = conn.tabs.find((t) => t.tabId === tabId);
    const allowed = conn.mode === 'all' || conn.aiTabs.has(tabId) || conn.grantedTabs.has(tabId);
    if (!allowed) {
      return {
        ok: false,
        reason: `标签 ${tabId}(${conn.label})没有授权给 AI(当前模式:仅 AI 自建 + 用户授权)。`
          + '请在浏览器扩展 popup 或前端「真机浏览器」面板里把该标签交给 AI,或让 AI 用 browser_open 新开一个标签。'
      };
    }
    const dom = this.checkDomain(tab?.url || '');
    if (!dom.ok) return dom;
    return { ok: true };
  }

  /** AI 自己创建的标签(自动可操作) */
  markAiTab(tabId: number, hint?: string | null): void {
    if (!Number.isFinite(tabId)) return;
    const conn = this.connForTab(tabId, hint);
    if (!conn) return;
    conn.aiTabs.add(tabId);
    this.rememberAuth(conn);
    void this.refreshTabs(conn);
  }

  /**
   * 刚开的标签先记进本地清单。tabs.list 的刷新有 200ms 去抖,不记的话
   * 「browser_open 之后紧接着的下一步」会因为清单里还没有这个标签而丢掉会话绑定,
   * 从而回落到用户的当前活动标签(默认授权模型下会被拒,看起来像"刚开就打不开了")。
   */
  noteOpenedTab(tabId: number, hint?: string | null, tab?: Partial<ExtTabRaw>): void {
    if (!Number.isFinite(tabId)) return;
    this.noteOpenedTabOn(this.connForTab(tabId, hint), tabId, tab);
  }

  private noteOpenedTabOn(conn: ExtConn | null, tabId: number, tab?: Partial<ExtTabRaw>): void {
    if (!conn || !Number.isFinite(tabId)) return;
    if (conn.tabs.some((t) => t.tabId === tabId)) return;
    // 后台打开的标签不会抢走 active:只有真的切到前台才清掉其它标签的 active
    const active = tab?.active === true;
    if (active) for (const t of conn.tabs) t.active = false;
    conn.tabs.push({
      tabId,
      url: String(tab?.url || ''),
      title: String(tab?.title || ''),
      active,
      openerTabId: tab?.openerTabId ?? null
    });
    this.emit('change', this.status());
  }

  /** 关掉的标签立刻从本地清单里去掉(同上,不等 200ms 的刷新) */
  noteClosedTab(tabId: number, hint?: string | null): void {
    const conn = this.connForTab(tabId, hint);
    if (!conn) return;
    const before = conn.tabs.length;
    conn.tabs = conn.tabs.filter((t) => t.tabId !== tabId);
    if (conn.tabs.length !== before && !conn.tabs.some((t) => t.active) && conn.tabs.length) conn.tabs[0].active = true;
    this.emit('change', this.status());
  }

  grant(tabId: number, hint?: string | null): void {
    if (!Number.isFinite(tabId)) return;
    const conn = this.connForTab(tabId, hint);
    if (!conn) return;
    conn.grantedTabs.add(tabId);
    this.rememberAuth(conn);
    this.emit('change', this.status());
  }

  revoke(tabId: number, hint?: string | null): void {
    const conn = this.connForTab(tabId, hint);
    if (!conn) return;
    conn.grantedTabs.delete(tabId);
    conn.aiTabs.delete(tabId);
    this.rememberAuth(conn);
    this.emit('change', this.status());
  }

  /** 操作模式:'ai-tabs'(默认,只碰 AI 自建 + 用户授权的标签)| 'all'(放开全部)。不指定 browser 就作用于全部在线浏览器 */
  setMode(mode: BridgeMode, hint?: string | null): void {
    const next: BridgeMode = mode === 'all' ? 'all' : 'ai-tabs';
    const want = String(hint || '').trim();
    const picked = want ? this.resolveConn(want) : null;
    // 点名了一台不存在的浏览器:什么都不改,不要"顺手"改掉全部
    const targets = want ? (picked ? [picked] : []) : this.onlineConns();
    for (const conn of targets) {
      conn.mode = next;
      this.rememberAuth(conn);
      try { conn.ws.send(JSON.stringify({ type: 'ext_config', mode: next })); } catch { /* 忽略 */ }
    }
    this.emit('change', this.status());
  }
}

/** 定长比较,避免 token 校验被逐字节计时侧信道 */
function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

export const browserBridge = new BrowserBridge();
