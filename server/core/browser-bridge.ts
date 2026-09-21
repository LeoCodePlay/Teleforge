// 浏览器扩展桥接:把「本机真实浏览器」接入 AI 控制。
//
// 扩展(仓库根的 extension/)以 WebSocket 反向连到 /ws/ext(upgrade 路由见 core/ws.ts),
// 本模块负责四件事:
//   1) 配对鉴权 —— 只有拿着 data/browser-bridge.json 里那份 token 的扩展能连上。
//      这不是可选项:WebSocket 不受同源策略限制,任意本机网页都能连 ws://127.0.0.1:4000/*,
//      而"接管浏览器"是高危能力,没有 token 就等于把用户的浏览器交出去。
//   2) 请求应答 —— call() 发 ext_call,按自增 id 与扩展回传的 ext_result 配对。
//   3) 标签授权 —— 默认只允许操作「AI 自己开的标签」与「用户显式交给 AI 的标签」(mode='ai-tabs');
//      用户在 UI 上明确放开后才切到 mode='all'。
//   4) 状态事件 —— 连接/断开/标签变化通过 'change' 通知前端(ws.ts 会广播给 /ws 通道)。
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

export interface BridgeStatus {
  online: boolean;
  version: string | null;
  browser: string | null;
  connectedAt: number | null;
  mode: BridgeMode;
  tabs: ExtTab[];
  /** 最近一次连接/调用失败原因(供前端提示) */
  error: string | null;
}

/** 扩展上线时回传的自我介绍 */
interface ExtHello {
  type: 'ext_hello';
  token?: string;
  version?: string;
  browser?: string;
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
}

class BrowserBridge extends EventEmitter {
  private ws: WebSocket | null = null;
  private pair: PairRecord | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private version: string | null = null;
  private browser: string | null = null;
  private connectedAt: number | null = null;
  private mode: BridgeMode = 'ai-tabs';
  private grantedTabs = new Set<number>();
  private aiTabs = new Set<number>();
  private tabs: ExtTabRaw[] = [];
  private lastError: string | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private helloTimer: NodeJS.Timeout | null = null;
  /** 握手完成(收到 ext_hello 且 token 匹配)才算真正可用 */
  private ready = false;

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

  /** 重置配对 token(旧扩展会立即掉线,用于"撤销设备") */
  resetToken(): string {
    this.pair = null;
    try { fs.rmSync(PAIR_FILE, { force: true }); } catch { /* 忽略 */ }
    const t = this.token();
    try { this.ws?.close(4403, 'token reset'); } catch { /* 忽略 */ }
    return t;
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

  /** 扩展连接建立:握手、挂消息处理、起心跳 */
  attach(ws: WebSocket): void {
    // 同一时刻只服务一个扩展:新连接顶掉旧的,避免两个扩展抢控制权时行为不确定
    if (this.ws && this.ws !== ws) {
      try { this.ws.close(4409, 'replaced by a newer connection'); } catch { /* 忽略 */ }
      this.detach();
    }
    this.ws = ws;
    this.ready = false;
    this.lastError = null;
    (ws as any).isAlive = true;
    ws.on('pong', () => { (ws as any).isAlive = true; });

    // 握手超时:连上却不自报家门的连接直接踢掉(挡住"连上但不说话"的占位)
    this.helloTimer = setTimeout(() => {
      if (!this.ready) {
        this.lastError = '扩展握手超时';
        try { ws.close(4408, 'hello timeout'); } catch { /* 忽略 */ }
      }
    }, HELLO_TIMEOUT_MS);

    ws.on('message', (raw: any, isBinary: boolean) => {
      if (isBinary) return;
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      this.onMessage(msg, ws);
    });
    ws.on('close', () => { if (this.ws === ws) this.detach(); });
    ws.on('error', () => { if (this.ws === ws) this.detach(); });

    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      try { this.ws.send(JSON.stringify({ type: 'ext_ping', ts: Date.now() })); } catch { /* 忽略 */ }
    }, PING_MS);
  }

  /** 扩展断开:清空状态、拒绝所有在途调用,并通知前端回退 */
  private detach(): void {
    this.ready = false;
    this.ws = null;
    this.connectedAt = null;
    this.version = null;
    this.browser = null;
    this.tabs = [];
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('真机浏览器连接已断开(扩展被关闭或休眠);已回退内置预览,请重试'));
    }
    this.pending.clear();
    this.emit('change', this.status());
  }

  private onMessage(msg: any, ws: WebSocket): void {
    if (msg.type === 'ext_hello') {
      const hello = msg as ExtHello;
      let expected = '';
      try { expected = this.token(); } catch { /* 无 token 时下面会失败 */ }
      if (!expected || !timingSafeEqual(String(hello.token || ''), expected)) {
        this.lastError = '扩展提供的 token 不正确';
        try { ws.close(4401, 'bad token'); } catch { /* 忽略 */ }
        return;
      }
      if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
      this.ready = true;
      this.version = String(hello.version || 'unknown');
      this.browser = String(hello.browser || 'chrome');
      this.connectedAt = Date.now();
      this.lastError = null;
      // 快照脚本由服务端下发,而不是在扩展里再存一份:内置预览与真机浏览器永远跑同一份脚本,
      // 不会出现"改了服务端忘了改扩展"导致两边快照格式漂移。
      // SNAPSHOT_SCRIPT 里的 TS 类型注解在运行时已被 Node 的类型剥离替换成空白,
      // 所以 toString() 出来就是可执行的纯 JS(已实测)。
      try {
        ws.send(JSON.stringify({
          type: 'ext_welcome',
          ok: true,
          heartbeatMs: PING_MS,
          mode: this.mode,
          snapshotScript: `(${SNAPSHOT_SCRIPT.toString()})()`
        }));
      } catch { /* 忽略 */ }
      this.emit('change', this.status());
      void this.refreshTabs();
      return;
    }
    if (msg.type === 'ext_result') {
      const id = Number(msg.id);
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(String(msg.error || '扩展执行失败')));
      return;
    }
    if (msg.type === 'ext_event') {
      // 扩展只在标签增删改时发一个"有变化"的通知,具体清单由本端重新拉取,避免两份状态漂移
      if (String(msg.event || '').startsWith('tab')) void this.refreshTabs();
      return;
    }
    if (msg.type === 'ext_pong') {
      (ws as any).isAlive = true;
    }
  }

  /** 拉取标签清单(带 200ms 去抖:标签事件常常连着来一串) */
  private tabsTimer: NodeJS.Timeout | null = null;
  private refreshTabs(): Promise<void> {
    if (this.tabsTimer) clearTimeout(this.tabsTimer);
    return new Promise((resolve) => {
      this.tabsTimer = setTimeout(async () => {
        this.tabsTimer = null;
        if (!this.ready) return resolve();
        try {
          const list = await this.call<ExtTabRaw[]>('tabs.list', {});
          this.tabs = Array.isArray(list) ? list : [];
          this.emit('change', this.status());
        } catch { /* 拉取失败不影响连接本身 */ }
        resolve();
      }, 200);
    });
  }

  // ---------------- 请求应答 ----------------

  isOnline(): boolean {
    return this.ready && !!this.ws && this.ws.readyState === 1;
  }

  /** 向扩展发一条指令并等结果;超时/断开都会 reject 成"可操作"的中文说明 */
  call<T = any>(method: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<T> {
    if (!this.isOnline()) {
      return Promise.reject(new Error('真机浏览器未连接:请在浏览器里打开扩展 popup 完成配对(或改用 target=preview 走内置预览)'));
    }
    const ws = this.ws!;
    const id = ++this.seq;
    const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || CALL_TIMEOUT_MS);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`真机浏览器执行超时(${method} 超过 ${Math.round(timeoutMs / 1000)}s 未返回)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ type: 'ext_call', id, method, params }));
      } catch (e: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`指令发送失败:${e?.message || e}`));
      }
    });
  }

  // ---------------- 标签授权 ----------------

  private decorate(t: ExtTabRaw): ExtTab {
    const owned = this.aiTabs.has(t.tabId);
    const granted = this.grantedTabs.has(t.tabId);
    return { ...t, owned, granted, allowed: this.mode === 'all' || owned || granted };
  }

  status(): BridgeStatus {
    return {
      online: this.isOnline(),
      version: this.version,
      browser: this.browser,
      connectedAt: this.connectedAt,
      mode: this.mode,
      tabs: this.tabs.map((t) => this.decorate(t)),
      error: this.lastError
    };
  }

  /** AI 是否可以操作该标签(工具层调用前必须过这一关) */
  canOperate(tabId: number): { ok: true } | { ok: false; reason: string } {
    if (this.mode === 'all') return { ok: true };
    if (this.aiTabs.has(tabId) || this.grantedTabs.has(tabId)) return { ok: true };
    return {
      ok: false,
      reason: `标签 ${tabId} 没有授权给 AI(当前模式:仅 AI 自建 + 用户授权)。`
        + '请在浏览器扩展 popup 或前端「真机浏览器」面板里把该标签交给 AI,或让 AI 用 browser_open 新开一个标签。'
    };
  }

  /** AI 自己创建的标签(自动可操作) */
  markAiTab(tabId: number): void {
    if (!Number.isFinite(tabId)) return;
    this.aiTabs.add(tabId);
    void this.refreshTabs();
  }

  grant(tabId: number): void {
    if (!Number.isFinite(tabId)) return;
    this.grantedTabs.add(tabId);
    this.emit('change', this.status());
  }

  revoke(tabId: number): void {
    this.grantedTabs.delete(tabId);
    this.aiTabs.delete(tabId);
    this.emit('change', this.status());
  }

  setMode(mode: BridgeMode): void {
    this.mode = mode === 'all' ? 'all' : 'ai-tabs';
    if (this.isOnline()) {
      try { this.ws!.send(JSON.stringify({ type: 'ext_config', mode: this.mode })); } catch { /* 忽略 */ }
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
