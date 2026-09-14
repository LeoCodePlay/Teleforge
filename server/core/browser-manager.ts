// 浏览器预览内核(Playwright 驱动真实 Chromium,三个用途合一):
//   1) 把页面画面通过 CDP screencast 实时推给前端「浏览器预览」标签(用户肉眼可看);
//   2) 接收前端鼠标/键盘输入并转发给页面(用户可直接在预览里操作,像真浏览器一样);
//   3) 向 AI 暴露快照 / 点击 / 输入 / 截图等能力(AI 操控的就是同一个预览页面)。
//
// playwright-core 采用惰性动态加载:不打开预览就不付出任何启动开销;
// 未安装依赖或找不到浏览器时,给出可操作的错误提示,而不是让服务启动失败。
import { EventEmitter } from 'node:events';
import { sshManager } from './ssh-manager.ts';
import type { Browser, BrowserContext, Page, CDPSession } from 'playwright-core';

export interface BrowserViewport { width: number; height: number }

/** 浏览器标签的对外状态(前端标签标题 / 状态条据此渲染) */
export interface BrowserState {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  viewport: BrowserViewport;
  /** 最近一次导航/操作失败的说明 */
  error: string | null;
  /**
   * 这个预览浏览器归属的会话 id(null = 未绑定:浏览器模式下手动打开、或旧会话遗留的自由预览)。
   * 一个预览只服务一个对话:只有归属会话的 AI 工具与用户输入能操作它。
   */
  ownerSid: string | null;
  /** 归属会话的标题(供前端左下角显示"已连接的会话"),会话已删除时为 null */
  ownerTitle: string | null;
}

// ---------------- 预览浏览器归属:一个预览标签 ↔ 一个对话 ----------------
// 浏览器会话 id 里直接编入归属会话,做到"谁开的就是谁的":
//   s_xxx:1   → 归属会话 s_xxx(第 1 个预览),会话内可再开 s_xxx:2、s_xxx:3 …
//   d_yyy:1   → 归属"新会话草稿"d_yyy;草稿落地为真实会话时由 transferOwner 改名继承
//   main      → 无归属(旧版共享预览 / 浏览器模式下手动打开),任何会话都不独占
// 归属在创建时写入后不再改变,因此不会出现"两个对话抢同一个预览"的中间态。
const SESSION_ID_RE = /^s_[0-9a-z]+$/i;
const DRAFT_ID_RE = /^d_[0-9a-z]+$/i;
/** 该 id 是否是一个会话的标识(真实会话 s_… 或新会话草稿 d_…) */
export function isBrowserOwner(sid: unknown): boolean {
  const s = String(sid ?? '').trim();
  return SESSION_ID_RE.test(s) || DRAFT_ID_RE.test(s);
}
/** 从浏览器会话 id 里解析归属会话(null = 无归属) */
export function ownerFromBrowserId(id: unknown): string | null {
  const s = String(id ?? '').trim();
  const i = s.indexOf(':');
  if (i <= 0) return null;
  return isBrowserOwner(s.slice(0, i)) ? s.slice(0, i) : null;
}
/** 某会话的默认预览浏览器 id:同一会话再次打开复用这一个(会话内多开时用 :2、:3 …) */
export function defaultBrowserIdFor(sid: string): string {
  return `${String(sid).trim()}:1`;
}
/** 浏览器 id → 归属会话是否就是 sid(无归属的预览不对任何会话成立) */
export function browserOwnedBy(browserId: unknown, sid: unknown): boolean {
  const owner = ownerFromBrowserId(browserId);
  return !!owner && !!sid && owner === String(sid).trim();
}

/** 前端上行的输入事件(坐标一律用 0~1 归一化值,与服务端视口尺寸解耦) */
export interface BrowserInputEvent {
  kind: 'mouse' | 'wheel' | 'key' | 'text';
  action?: 'move' | 'down' | 'up' | 'click';
  nx?: number;
  ny?: number;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  dx?: number;
  dy?: number;
  key?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  text?: string;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const MIN_DIM = 240;
const MAX_DIM = 3840;
const SCREENCAST_QUALITY = 62;
const NAV_TIMEOUT_MS = 45_000;
const ACTION_TIMEOUT_MS = 10_000;

const clampDim = (v: unknown, fallback: number) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, MIN_DIM), MAX_DIM);
};

/** 只有确实像「开发服务器地址」的输入才补协议,避免把普通文本误当 URL */
export function normalizePreviewUrl(raw: unknown): string | null {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  s = s.replace(/^[<("'`[]+/, '').replace(/[>)"'`\]，。；、.,;:!?]+$/, '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?([/?#].*)?$/i.test(s)) return 'http://' + s;
  // host.tld:port(带端口才认,避免把 www.example.com 这类无端口文本当地址)
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+:\d{2,5}([/?#].*)?$/i.test(s)) return 'http://' + s;
  return null;
}

/**
 * 从命令输出/工具结果里挑出值得预览的项目地址(去重、保序)。
 * 只认回环/私有网段/带端口的地址,避免把公网页面的普通链接也当成"项目预览"。
 */
export function extractPreviewUrls(text: unknown): string[] {
  const src = String(text ?? '');
  if (!src) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s"'`<>()[\]，。；、]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const cleaned = m[0].replace(/[.,;:!?)\]}>，。；、]+$/, '');
    const norm = normalizePreviewUrl(cleaned);
    if (!norm || seen.has(norm)) continue;
    let u: URL;
    try { u = new URL(norm); } catch { continue; }
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
    const priv = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    const port = u.port && u.port !== '80' && u.port !== '443';
    if (!loopback && !priv && !port) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= 3) break;
  }
  return out;
}

const RETRY_NAV_TIMEOUT_MS = 15_000;

function isLoopbackHost(host: string): boolean {
  const h = String(host || '').replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1';
}

/**
 * 一次导航的尝试序列。回环地址互换 localhost / 127.0.0.1(解决 IPv4/IPv6 绑定不一致),
 * 并整体重试一轮(解决"地址刚打印出来、服务还在启动")。
 */
function navigationAttempts(url: string): string[] {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '127.0.0.1') {
      const alt = new URL(url);
      alt.hostname = host === 'localhost' ? '127.0.0.1' : 'localhost';
      return [url, alt.toString(), url, alt.toString()];
    }
  } catch { /* 非法地址:仍按单次 + 重试处理 */ }
  return [url, url];
}

const RETRYABLE_NAV_RE = /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED|ERR_EMPTY_RESPONSE|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_CHANGED|ERR_SOCKET_NOT_CONNECTED|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|Timeout \d+ms exceeded/i;

function isRetryableNavError(e: unknown): boolean {
  return RETRYABLE_NAV_RE.test(String((e as any)?.message || e));
}

/** 把 Chromium 的导航错误翻成"用户能照着做"的中文说明 */
export function describeNavError(e: unknown, url: string): string {
  const raw = String((e as any)?.message || e).split('\n')[0];
  let loopback = false;
  try { loopback = isLoopbackHost(new URL(url).hostname); } catch { /* 非法地址 */ }
  const remoteHint = loopback && !sshManager.connected
    ? ' 若项目跑在远程服务器上,请先连接 SSH——未连接时不会自动建立端口隧道,localhost/127.0.0.1 只会指向本机。'
    : '';
  if (/ERR_CONNECTION_REFUSED/.test(raw)) {
    return `无法连接 ${url}:该端口没有服务在监听。常见原因:项目还没启动;前台 run_command 超时(默认 300s)把 dev server 杀掉了;`
      + `Vite 端口被占用时会自动 +1,点到了旧地址。${remoteHint}`;
  }
  if (/ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/.test(raw)) {
    return `连接 ${url} 被中断:服务可能刚重启、只监听了 IPv6(::1),或 SSH 隧道对端没有服务。${remoteHint}`;
  }
  if (/ERR_NAME_NOT_RESOLVED/.test(raw)) return `域名无法解析:${url}`;
  if (/ERR_ABORTED/.test(raw)) return `加载被中断:${url}(可能被下一次导航覆盖)`;
  if (/Timeout \d+ms exceeded/i.test(raw)) return `加载超时:${url} 一直没有返回内容(服务卡住或首次编译过慢)。${remoteHint}`;
  if (/ERR_CERT|SSL/i.test(raw)) return `HTTPS 证书有问题:${url}(${raw})`;
  return `打开失败:${raw}`;
}

interface BrowserSession {
  id: string;
  /** 归属会话 id(null = 无归属的自由预览,见文件头归属说明) */
  ownerSid: string | null;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  viewport: BrowserViewport;
  frame: Buffer | null;
  frameWidth: number;
  frameHeight: number;
  title: string;
  loading: boolean;
  error: string | null;
  closed: boolean;
  titleTimer: ReturnType<typeof setTimeout> | null;
  canBack: boolean;
  canForward: boolean;
  /** 当前订阅画面的连接数:为 0 时停掉 screencast,避免无人观看还持续编码 JPEG */
  viewers: number;
  /** 会话级串行队列:输入与交互动作按到达顺序执行(见 _enqueue) */
  chain: Promise<unknown>;
}

function launchCandidates(): Array<{ label: string; opts: Record<string, unknown> }> {
  const list: Array<{ label: string; opts: Record<string, unknown> }> = [];
  const exe = String(process.env.BROWSER_PREVIEW_EXECUTABLE || '').trim();
  if (exe) list.push({ label: `可执行文件 ${exe}`, opts: { executablePath: exe } });
  const channel = String(process.env.BROWSER_PREVIEW_CHANNEL || '').trim();
  if (channel && channel !== 'chromium') list.push({ label: `channel=${channel}`, opts: { channel } });
  // 默认顺序:系统 Chrome → 系统 Edge → Playwright 自带 Chromium。
  // 前两者几乎在所有开发机上都存在,且不需要下载百兆浏览器。
  list.push({ label: 'channel=chrome', opts: { channel: 'chrome' } });
  list.push({ label: 'channel=msedge', opts: { channel: 'msedge' } });
  list.push({ label: 'Playwright 内置 Chromium', opts: {} });
  return list;
}

function launchArgs(): string[] {
  const args = [
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,MediaRouter'
  ];
  // 容器 / root 环境下需要关沙箱(与 Docker 内跑 Chromium 的通行做法一致)
  if (process.env.BROWSER_PREVIEW_NO_SANDBOX === '1') args.push('--no-sandbox');
  return args;
}

/**
 * 页面快照脚本:给可见的可交互元素打上 data-tp-ref="eN" 引用,返回结构化描述。
 * 必须是自包含函数(page.evaluate 会把它序列化后在页面里执行,不能引用外部变量)。
 */
const SNAPSHOT_SCRIPT = () => {
  const win = globalThis as any;
  const doc = win.document;
  const ATTR = 'data-tp-ref';
  const MAX_ELEMENTS = 160;
  doc.querySelectorAll('[' + ATTR + ']').forEach((e: any) => e.removeAttribute(ATTR));
  const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el: any) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    const st = win.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };
  const accName = (el: any) => {
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const ph = clean(el.getAttribute('placeholder'));
    if (ph) return ph;
    const alt = clean(el.getAttribute('alt'));
    if (alt) return alt;
    const title = clean(el.getAttribute('title'));
    if (title) return title;
    const text = clean(el.innerText || el.textContent);
    if (text) return text.slice(0, 90);
    const val = clean(el.value);
    if (val) return val.slice(0, 90);
    return '';
  };
  const SEL = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],'
    + '[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=textbox],'
    + '[contenteditable=""],[contenteditable=true],[onclick]';
  const items: string[] = [];
  let n = 0;
  doc.querySelectorAll(SEL).forEach((el: any) => {
    if (n >= MAX_ELEMENTS) return;
    if (!visible(el)) return;
    const tag = el.tagName.toLowerCase();
    const type = clean(el.getAttribute('type'));
    if (tag === 'input' && type === 'hidden') return;
    n += 1;
    const ref = 'e' + n;
    el.setAttribute(ATTR, ref);
    const bits = [`[${ref}] <${tag}${type ? ' type=' + type : ''}>`];
    const role = clean(el.getAttribute('role'));
    if (role) bits.push('role=' + role);
    const name = accName(el);
    if (name) bits.push(JSON.stringify(name));
    if (tag === 'input' || tag === 'textarea') bits.push('值=' + JSON.stringify(clean(el.value).slice(0, 80)));
    const href = clean(el.getAttribute('href'));
    if (href) bits.push('href=' + href.slice(0, 160));
    if (el.disabled) bits.push('(禁用)');
    if (type === 'checkbox' || type === 'radio') bits.push(el.checked ? '(已选)' : '(未选)');
    items.push(bits.join(' '));
  });
  const heads: string[] = [];
  doc.querySelectorAll('h1,h2,h3').forEach((h: any) => {
    if (heads.length >= 25 || !visible(h)) return;
    heads.push(`<${h.tagName.toLowerCase()}> ${clean(h.innerText).slice(0, 120)}`);
  });
  const body = doc.body as any;
  const bodyText = clean(body ? body.innerText : '').slice(0, 3000);
  return {
    url: win.location.href,
    title: doc.title,
    items,
    heads,
    text: bodyText,
    count: n,
    scrollY: Math.round(win.scrollY),
    scrollHeight: doc.documentElement ? doc.documentElement.scrollHeight : 0,
    viewportHeight: win.innerHeight
  };
};

function formatSnapshot(d: any): string {
  const lines: string[] = [];
  lines.push(`页面标题:${d?.title || '(无标题)'}`);
  lines.push(`地址:${d?.url || ''}`);
  lines.push(`视口:${d?.viewportHeight || 0}px 高 · 已滚动 ${d?.scrollY || 0}/${d?.scrollHeight || 0}px`);
  const items: string[] = Array.isArray(d?.items) ? d.items : [];
  lines.push('');
  lines.push(`可交互元素(${items.length} 个,点击用 ref,如 e3):`);
  lines.push(items.length ? items.join('\n') : '(无可交互元素)');
  const heads: string[] = Array.isArray(d?.heads) ? d.heads : [];
  if (heads.length) {
    lines.push('');
    lines.push('标题结构:');
    lines.push(heads.join('\n'));
  }
  const text = String(d?.text || '').trim();
  if (text) {
    lines.push('');
    lines.push('正文摘录:');
    lines.push(text.length > 2000 ? text.slice(0, 2000) + '\n…(已截断)' : text);
  }
  return lines.join('\n');
}

/** 把浏览器按键名规范成 Playwright 能识别的名字 */
function normalizeKey(key: string): string {
  const k = String(key || '');
  const map: Record<string, string> = {
    ' ': 'Space', Spacebar: 'Space', Esc: 'Escape', Left: 'ArrowLeft', Right: 'ArrowRight',
    Up: 'ArrowUp', Down: 'ArrowDown', Del: 'Delete', Return: 'Enter', Add: '+'
  };
  return map[k] || k;
}

class BrowserManager extends EventEmitter {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private sessions = new Map<string, BrowserSession>();
  /** 会话标题查询(会话存储侧注入,避免 core → store 的模块循环依赖;见 setSessionTitleLookup) */
  private sessionTitleOf: ((sid: string) => string | null) | null = null;
  /** 会话建立前先连上的观看者数(见 setViewer 的记账逻辑) */
  private pendingViewers = new Map<string, number>();
  /** 标题轮询:SPA 路由切换会直接改 document.title,不会触发导航事件,靠轮询兜住 */
  private titlePoller: ReturnType<typeof setInterval> | null = null;

  /** 浏览器是否已就绪(未启动返回 null,便于前端区分「未打开」与「已关闭」) */
  get active(): boolean { return !!this.browser && this.browser.isConnected(); }

  /** 注入会话标题查询:预览状态里带上归属会话标题,前端左下角直接显示(未注入时只显示会话 id) */
  setSessionTitleLookup(fn: ((sid: string) => string | null) | null): void {
    this.sessionTitleOf = fn;
  }

  /**
   * 这个会话能否操作指定预览。返回值即"拒绝理由"(可操作时返回 null):
   *  - 会话不存在 / 预览不存在 → 各自给一句能照着做的提示;
   *  - 预览有归属且归属不是这个会话 → 明确拒绝,并把归属会话说出来(只提示,不泄露其内容)。
   * AI 工具与前端输入都走它,保证"一个预览只被一个对话操控"这条规则只有一个实现。
   */
  /**
   * 这个会话能否操作指定预览。返回值即"拒绝理由"(可操作时返回 null):
   *  - 会话不存在 / 预览不存在 → 各自给一句能照着做的提示;
   *  - 预览有归属且归属不是这个会话 → 明确拒绝,并把归属会话说出来(只提示,不泄露其内容)。
   * 判定以会话上记着的归属为准(id 里编的归属只用于建会话时的分配):
   * 草稿预览改名继承后,id 仍是 `d_xxx:1` 而归属已改成真实会话,若按 id 判定就会把正当的主人挡在门外。
   * AI 工具与前端输入都走它,保证"一个预览只被一个对话操控"这条规则只有一个实现。
   */
  denyReason(id: string, sid: string | null | undefined): string | null {
    const s = this.sessions.get(String(id || 'main'));
    if (!s || s.closed) return `浏览器预览不存在或已关闭(${id})。请先打开预览。`;
    if (s.ownerSid && s.ownerSid !== String(sid ?? '').trim()) {
      return `预览「${id}」已绑定到另一个会话(${s.ownerSid}),本会话无权操作;`
        + `请改用本会话自己的预览(默认 ${defaultBrowserIdFor(String(sid || 'sid'))}),或用 browser_open 新开一个。`;
    }
    return null;
  }

  /** 校验归属,不通过即抛错(工具链与 RPC 的写入路径统一从这里进) */
  private assertOwner(id: string, sid: string | null | undefined): BrowserSession {
    const reason = this.denyReason(id, sid);
    if (reason) throw new Error(reason);
    return this.sessions.get(String(id || 'main')) as BrowserSession;
  }

  /** 取会话画面/状态时用;内部方法不在时抛错 */
  private require(id: string): BrowserSession {
    const s = this.sessions.get(String(id || 'main'));
    if (!s || s.closed) throw new Error(`浏览器预览不存在或已关闭(${id})。请先打开预览。`);
    return s;
  }

  async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    const task = (async (): Promise<Browser> => {
      let pw: typeof import('playwright-core');
      try {
        pw = await import('playwright-core');
      } catch {
        throw new Error('浏览器预览需要 playwright-core 依赖。请在项目目录执行:npm i playwright-core');
      }
      const headless = process.env.BROWSER_PREVIEW_HEADLESS !== '0';
      const failures: string[] = [];
      for (const cand of launchCandidates()) {
        try {
          const b = await pw.chromium.launch({ headless, args: launchArgs(), ...cand.opts } as any);
          this.browser = b;
          b.on('disconnected', () => {
            this.browser = null;
            for (const s of this.sessions.values()) s.closed = true;
            this.sessions.clear();
            this.emit('state', { id: '*', closed: true });
          });
          return b;
        } catch (e: any) {
          failures.push(`- ${cand.label}:${e?.message?.split('\n')[0] || e}`);
        }
      }
      throw new Error('无法启动浏览器预览(已尝试以下方式):\n' + failures.join('\n')
        + '\n可通过环境变量 BROWSER_PREVIEW_EXECUTABLE 指定 Chrome/Edge 可执行文件路径,'
        + '或用 BROWSER_PREVIEW_CHANNEL=chrome|msedge 指定浏览器通道。');
    })();
    this.launching = task;
    try {
      return await task;
    } finally {
      this.launching = null;
    }
  }

  list(): BrowserState[] {
    return [...this.sessions.values()].filter((s) => !s.closed).map((s) => this._stateOf(s));
  }

  /** 某个会话拥有的预览(顺序 = 创建顺序,即浏览器标签从旧到新) */
  listFor(sid: string | null | undefined): BrowserState[] {
    const own = this._ownerKey(sid);
    if (!own) return [];
    return [...this.sessions.values()]
      .filter((s) => !s.closed && s.ownerSid === own)
      .map((s) => this._stateOf(s));
  }

  state(id: string): BrowserState | null {
    const s = this.sessions.get(String(id || 'main'));
    return s && !s.closed ? this._stateOf(s) : null;
  }

  /**
   * 归属改名:新会话草稿(d_…)落地成真实会话(s_…)时,把它名下的预览一并继承过去,
   * 这样"新会话里先开预览、再发第一条消息"不会让预览变成没人认领的孤儿。
   * @returns 被改名的预览数量
   */
  transferOwner(fromSid: string, toSid: string): number {
    const from = String(fromSid || '').trim();
    const to = String(toSid || '').trim();
    if (!from || !to || from === to) return 0;
    let n = 0;
    for (const s of [...this.sessions.values()]) {
      if (s.closed || s.ownerSid !== from) continue;
      const prevId = s.id;
      s.ownerSid = to;
      // 浏览器 id 里编着的归属也一并改掉,保持"id 里的会话就是归属会话"这条不变量:
      // 否则这个预览顶着草稿 id 活到重启,内存里归属虽然对,重启后按 id 判定就会把主人挡在门外。
      const next = prevId.startsWith(`${from}:`) ? `${to}:${prevId.slice(from.length + 1)}` : prevId;
      if (next !== prevId && !this.sessions.has(next)) {
        this.sessions.delete(prevId);
        s.id = next;
        this.sessions.set(next, s);
        // 改名后画面通道的订阅 key 也要跟着走,否则新连上的前端拿不到"有观看者"的记账
        if (this.pendingViewers.has(prevId)) {
          this.pendingViewers.set(next, (this.pendingViewers.get(next) || 0) + (this.pendingViewers.get(prevId) as number));
          this.pendingViewers.delete(prevId);
        }
        // 通知前端:旧 id 的订阅请改订阅到新 id(前端标签 id 同一时刻也由 handleSessionCreated 改名)
        this.emit('renamed', { from: prevId, to: next, ownerSid: to });
      }
      n += 1;
      this._emitState(s);
    }
    return n;
  }

  /** 关闭某个会话名下的全部预览(会话被删除时调用,不留僵尸浏览器) */
  async closeFor(sid: string | null | undefined): Promise<number> {
    const own = this._ownerKey(sid);
    if (!own) return 0;
    const ids = [...this.sessions.values()].filter((s) => !s.closed && s.ownerSid === own).map((s) => s.id);
    for (const id of ids) await this.close(id);
    return ids.length;
  }

  private _ownerKey(sid: string | null | undefined): string | null {
    const s = String(sid ?? '').trim();
    return s || null;
  }

  /** 最近一帧画面(新连上的前端立即有图,不必等下一次重绘) */
  lastFrame(id: string): { data: Buffer; width: number; height: number } | null {
    const s = this.sessions.get(String(id || 'main'));
    if (!s || s.closed || !s.frame) return null;
    return { data: s.frame, width: s.frameWidth, height: s.frameHeight };
  }

  /**
   * 前端预览标签连接/断开画面通道时调用:无人观看时停掉 screencast,
   * 有人观看时恢复。页面本身与页面状态不受影响。
   */
  async setViewer(id: string, watching: boolean): Promise<void> {
    const s = this.sessions.get(String(id || 'main'));
    if (!s || s.closed) {
      // 画面通道常常先于 browser_open 连上(前端标签一挂载就连 WS):先记账,
      // 建会话时把观看人数补进去,否则 viewers 永远是 0 —— 标题轮询会被跳过。
      const key = String(id || 'main');
      const n = Math.max(0, (this.pendingViewers.get(key) || 0) + (watching ? 1 : -1));
      this.pendingViewers.set(key, n);
      return;
    }
    if (watching) {
      s.viewers += 1;
      if (s.viewers === 1) await this._restartScreencast(s);
    } else {
      s.viewers = Math.max(0, s.viewers - 1);
      if (s.viewers === 0) {
        try { await s.cdp.send('Page.stopScreencast'); } catch { /* 忽略 */ }
      }
    }
  }

  /**
   * 打开/复用预览标签并导航到目标地址。
   * 已存在同 id 会话时只导航,不重建(保留页面状态);归属校验(见文件头归属说明):
   *  id 里编着归属会话时,调用会话必须是它,否则直接拒绝——两个对话永远不会共用一个预览。
   *  ownerSid 只在"新建会话"时写入,已存在的预览不改归属。
   */
  async open({ id = 'main', url, width, height, ownerSid }: {
    id?: string; url: string; width?: number; height?: number; ownerSid?: string | null;
  }): Promise<BrowserState> {
    const target = normalizePreviewUrl(url);
    if (!target) throw new Error(`不是有效的预览地址:${String(url || '(空)')}`);
    const sid = this._ownerKey(ownerSid);
    // id 自带的归属优先(前端按会话生成 id,前端传错 sid 也不会越权:错的那一侧会先被拒)
    const idOwner = ownerFromBrowserId(id);
    const owner = idOwner || sid;
    if (idOwner && sid && idOwner !== sid) throw new Error(this.denyReason(id, sid) as string);
    let s = this.sessions.get(id);
    if (!s || s.closed) s = await this._createSession(id, width, height, owner);
    else {
      const reason = this.denyReason(id, owner ?? sid);
      if (reason) throw new Error(reason);
      // 无归属的预览(旧版共享的 main / 浏览器模式下手动打开):第一次带着会话打开时认领它,
      // 之后它就和别的会话一样被独占 —— 升级后老标签不会被两个对话轮流操控。
      if (!s.ownerSid && owner) { s.ownerSid = owner; this._emitState(s); }
      if (width || height) await this.resize(id, { width, height });
    }
    await this._navigate(s, target);
    return this._stateOf(s);
  }

  async navigate(id: string, url: string, sid?: string | null): Promise<BrowserState> {
    const s = this.assertOwner(id, sid);
    const target = normalizePreviewUrl(url);
    if (!target) throw new Error(`不是有效的预览地址:${String(url || '(空)')}`);
    await this._navigate(s, target);
    return this._stateOf(s);
  }

  async reload(id: string, sid?: string | null): Promise<BrowserState> {
    const s = this.assertOwner(id, sid);
    s.loading = true; s.error = null; this._emitState(s);
    try {
      await s.page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch (e: any) {
      s.error = e?.message || String(e);
    } finally {
      s.loading = false;
      this._refreshTitle(s);
      this._emitState(s);
    }
    return this._stateOf(s);
  }

  async goBack(id: string, sid?: string | null): Promise<BrowserState> {
    const s = this.assertOwner(id, sid);
    try { await s.page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }); }
    catch (e: any) { s.error = e?.message || String(e); }
    this._refreshTitle(s);
    return this._stateOf(s);
  }

  async goForward(id: string, sid?: string | null): Promise<BrowserState> {
    const s = this.assertOwner(id, sid);
    try { await s.page.goForward({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }); }
    catch (e: any) { s.error = e?.message || String(e); }
    this._refreshTitle(s);
    return this._stateOf(s);
  }

  async resize(id: string, { width, height }: { width?: number; height?: number }): Promise<BrowserState> {
    const s = this.require(id);
    const vp = {
      width: clampDim(width, s.viewport.width),
      height: clampDim(height, s.viewport.height)
    };
    if (vp.width === s.viewport.width && vp.height === s.viewport.height) return this._stateOf(s);
    s.viewport = vp;
    try { await s.page.setViewportSize(vp); } catch { /* 页面可能已关闭 */ }
    await this._restartScreencast(s);
    this._emitState(s);
    return this._stateOf(s);
  }

  /** 关闭预览并释放底层页面。sid 非空时校验归属(前端标签只能关自己的预览) */
  async close(id: string, sid?: string | null): Promise<void> {
    const s = this.sessions.get(String(id || 'main'));
    if (!s) return;
    // 已 closed 的会话在 sessions 里已摘除;denyReason 只在需要校验归属时用(无归属的预览谁都能关)
    if (sid != null && s.ownerSid) {
      const reason = this.denyReason(id, sid);
      if (reason) throw new Error(reason);
    }
    s.closed = true;
    this.sessions.delete(s.id);
    if (s.titleTimer) clearTimeout(s.titleTimer);
    try { await s.cdp.send('Page.stopScreencast'); } catch { /* 忽略 */ }
    try { await s.context.close(); } catch { /* 忽略 */ }
    this.pendingViewers.delete(s.id);
    this.emit('closed', { id: s.id });
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.close(id);
    try { await this.browser?.close(); } catch { /* 忽略 */ }
    if (this.titlePoller) { clearInterval(this.titlePoller); this.titlePoller = null; }
    this.browser = null;
  }

  /**
   * 前端鼠标/键盘输入 → 页面。
   * 关键:必须按到达顺序串行执行。ws 的 message 回调是并发的(Node 不会 await),
   * 若 move 还没落地就执行 down,点击会落在上一个鼠标位置上(表现为"点了没反应")。
   * sid = 发起输入的前端当前所在会话:只有归属会话能操作该预览(非归属直接抛错,
   * 由 ws 层回执"已锁定"给前端做提示)。
   */
  async input(id: string, evt: BrowserInputEvent, sid?: string | null): Promise<void> {
    const s = this.sessions.get(String(id || 'main'));
    if (!s || s.closed || !evt) return;
    const reason = this.denyReason(id, sid);
    if (reason) throw new Error(reason);
    return this._enqueue(s, () => this._applyInput(s, evt));
  }

  /** 会话级串行队列:输入与 AI 交互动作共用,保证页面状态变化的先后顺序 */
  private _enqueue<T>(s: BrowserSession, fn: () => Promise<T>): Promise<T> {
    const run = s.chain.then(fn, fn);
    s.chain = run.catch(() => { /* 失败不阻断后续 */ });
    return run;
  }

  private async _applyInput(s: BrowserSession, evt: BrowserInputEvent): Promise<void> {
    const { width, height } = s.viewport;
    const px = Math.max(0, Math.min(width - 1, Math.round((Number(evt.nx) || 0) * width)));
    const py = Math.max(0, Math.min(height - 1, Math.round((Number(evt.ny) || 0) * height)));
    try {
      switch (evt.kind) {
        case 'mouse': {
          const button = (evt.button || 'left') as 'left' | 'right' | 'middle';
          // down/up 也先 move:Playwright 的 down/up 用"当前鼠标位置",不显式移动会点到旧位置
          if (evt.action === 'move' || evt.action === 'down' || evt.action === 'up') await s.page.mouse.move(px, py);
          if (evt.action === 'down') await s.page.mouse.down({ button });
          else if (evt.action === 'up') await s.page.mouse.up({ button });
          else if (evt.action === 'click') await s.page.mouse.click(px, py, { button, clickCount: Math.min(Math.max(Number(evt.clickCount) || 1, 1), 3) });
          break;
        }
        case 'wheel': {
          await s.page.mouse.move(px, py);
          await s.page.mouse.wheel(Number(evt.dx) || 0, Number(evt.dy) || 0);
          break;
        }
        case 'text': {
          const text = String(evt.text || '');
          if (text) await s.page.keyboard.insertText(text);
          break;
        }
        case 'key': {
          const raw = String(evt.key || '');
          if (!raw) break;
          const key = normalizeKey(raw);
          const mods: string[] = [];
          if (evt.altKey) mods.push('Alt');
          if (evt.ctrlKey) mods.push('Control');
          if (evt.metaKey) mods.push('Meta');
          // 单字符且无修饰键:交给 text/insertText 处理(含中文输入法),避免重复插入
          const printable = key.length === 1 && !evt.ctrlKey && !evt.metaKey && !evt.altKey;
          if (printable) break;
          if (key.length > 1 && evt.shiftKey && mods.length === 0) mods.push('Shift');
          await s.page.keyboard.press([...mods, key].join('+'));
          break;
        }
        default: break;
      }
      if (s.error) { s.error = null; this._emitState(s); }
    } catch (e: any) {
      s.error = e?.message?.split('\n')[0] || String(e);
      this._emitState(s);
    }
  }

  /** 给 AI:页面结构化快照(带 ref 引用);sid = 调用方会话,非归属拒绝 */
  async snapshot(id: string, sid?: string | null): Promise<string> {
    const s = this.assertOwner(id, sid);
    const data = await s.page.evaluate(SNAPSHOT_SCRIPT);
    return formatSnapshot(data);
  }

  /** 给 AI:点击(ref / CSS 选择器 / 可见文本三选一) */
  async click(id: string, target: { ref?: string; selector?: string; text?: string }, sid?: string | null): Promise<string> {
    const s = this.assertOwner(id, sid);
    return this._enqueue(s, async () => {
      const { ref, selector, text } = target || {};
      let loc = null as any;
      if (ref) loc = s.page.locator(`[data-tp-ref="${String(ref).replace(/"/g, '')}"]`).first();
      else if (selector) loc = s.page.locator(String(selector)).first();
      else if (text) loc = s.page.getByText(String(text), { exact: false }).first();
      else throw new Error('需要提供 ref / selector / text 之一');
      await loc.click({ timeout: ACTION_TIMEOUT_MS });
      await this._settle(s, 350);
      return `已点击:${ref ? `ref=${ref}` : selector ? `选择器 ${selector}` : `文本「${text}」`}`;
    });
  }

  /** 给 AI:向输入框填入文本(ref / selector 定位) */
  async fill(id: string, target: { ref?: string; selector?: string; text: string; submit?: boolean; clear?: boolean }, sid?: string | null): Promise<string> {
    const s = this.assertOwner(id, sid);
    return this._enqueue(s, async () => {
      const { ref, selector, text, submit, clear } = target || {};
      let loc = null as any;
      if (ref) loc = s.page.locator(`[data-tp-ref="${String(ref).replace(/"/g, '')}"]`).first();
      else if (selector) loc = s.page.locator(String(selector)).first();
      else throw new Error('需要提供 ref 或 selector');
      if (clear !== false) await loc.fill('', { timeout: ACTION_TIMEOUT_MS });
      await loc.fill(String(text ?? ''), { timeout: ACTION_TIMEOUT_MS });
      if (submit) {
        await loc.press('Enter');
        await this._settle(s, 600);
      }
      return `已输入${submit ? '并提交' : ''}:${ref ? `ref=${ref}` : selector ? `选择器 ${selector}` : ''}`;
    });
  }

  /** 给 AI:按一次按键(Enter/Tab/Escape/ArrowDown/Ctrl+A 等) */
  async press(id: string, key: string, sid?: string | null): Promise<string> {
    const s = this.assertOwner(id, sid);
    return this._enqueue(s, async () => {
      await s.page.keyboard.press(String(key || 'Enter'));
      await this._settle(s, 250);
      return `已按键:${key}`;
    });
  }

  /** 给 AI:滚动页面(像素),scroll_down/scroll_up 两种方向 */
  async scroll(id: string, { direction = 'down', amount = 600 }: { direction?: string; amount?: number }, sid?: string | null): Promise<string> {
    const s = this.assertOwner(id, sid);
    return this._enqueue(s, async () => {
      const dy = direction === 'up' ? -Math.abs(Number(amount) || 600) : Math.abs(Number(amount) || 600);
      await s.page.mouse.wheel(0, dy);
      await this._settle(s, 350);
      return `已向${direction === 'up' ? '上' : '下'}滚动 ${Math.abs(dy)}px`;
    });
  }

  /** 给 AI:等待条件(文本出现 / 选择器可见 / URL 变化 / 纯延时) */
  async waitFor(id: string, opts: { text?: string; selector?: string; url?: string; timeoutMs?: number }, sid?: string | null): Promise<string> {
    const s = this.assertOwner(id, sid);
    const timeout = Math.min(Math.max(Number(opts?.timeoutMs) || 8000, 100), 60_000);
    const { text, selector, url } = opts || {};
    if (selector) await s.page.waitForSelector(String(selector), { state: 'visible', timeout });
    if (text) await s.page.getByText(String(text), { exact: false }).first().waitFor({ state: 'visible', timeout });
    if (url) await s.page.waitForURL(String(url), { timeout });
    if (!text && !selector && !url) await s.page.waitForTimeout(timeout);
    await this._settle(s, 200);
    return `等待完成(${url ? `URL=${url} ` : ''}${selector ? `选择器=${selector} ` : ''}${text ? `文本=${text} ` : ''}${!text && !selector && !url ? `${timeout}ms` : ''})`.trim();
  }

  /** 读取远程页面当前选中的文字
   *  预览是一张 JPEG 画面,本地选不中任何东西;用户拖选出来的选区其实在远程页面里,
   *  所以「复制」必须回远程页面取文本,再由前端写进本机剪贴板。 */
  async selection(id: string, sid?: string | null): Promise<{ text: string }> {
    const s = this.assertOwner(id, sid);
    const text = await s.page.evaluate(() => {
      const win = globalThis as any;
      const doc = win.document;
      const selText = win.getSelection ? String(win.getSelection().toString()) : '';
      if (selText) return selText;
      // 输入框内的选区不进入 window.getSelection(),单独取一次
      const el = doc ? doc.activeElement : null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        const a = Number(el.selectionStart);
        const b = Number(el.selectionEnd);
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) return String(el.value).slice(a, b);
      }
      return '';
    }).catch(() => '');
    return { text: String(text || '').slice(0, 200000) };
  }

  /** 给 AI:页面内执行表达式并返回 JSON 结果(调试/取数据用) */
  async evaluate(id: string, expression: string, sid?: string | null): Promise<string> {
    const s = this.assertOwner(id, sid);
    const src = String(expression || '').trim();
    if (!src) throw new Error('expression 为空');
    const result = await s.page.evaluate(src);
    let out: string;
    try { out = JSON.stringify(result); } catch { out = String(result); }
    if (out === undefined) out = 'undefined';
    return out.length > 8000 ? out.slice(0, 8000) + '\n…(结果已截断)' : out;
  }

  /** 给 AI:整页截图(PNG),返回缓冲区交给上层落盘为附件 */
  async screenshot(id: string, { fullPage = false }: { fullPage?: boolean } = {}, sid?: string | null): Promise<Buffer> {
    const s = this.assertOwner(id, sid);
    return await s.page.screenshot({ fullPage: !!fullPage, type: 'png' });
  }

  // ---------------- 内部 ----------------

  /** 只在有观看者时轮询标题(节流到 1.2s,标题变了才推状态) */
  private _startTitlePoll() {
    if (this.titlePoller) return;
    this.titlePoller = setInterval(async () => {
      for (const s of this.sessions.values()) {
        if (s.closed || s.viewers <= 0) continue;
        try {
          const t = (await s.page.title()) || '';
          if (t !== s.title) { s.title = t; await this._refreshHistory(s); this._emitState(s); }
        } catch { /* 页面可能已关闭 */ }
      }
    }, 1200);
    if (this.titlePoller.unref) this.titlePoller.unref();
  }

  /** ownerSid = 该预览归属的会话(新建时写入,之后不变;null = 无归属的自由预览) */
  private async _createSession(id: string, width?: number, height?: number, ownerSid: string | null = null): Promise<BrowserSession> {
    const b = await this.ensureBrowser();
    const viewport: BrowserViewport = { width: clampDim(width, DEFAULT_WIDTH), height: clampDim(height, DEFAULT_HEIGHT) };
    const context = await b.newContext({ viewport, deviceScaleFactor: 1, ignoreHTTPSErrors: true } as any);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const s: BrowserSession = {
      id, ownerSid, context, page, cdp, viewport,
      frame: null, frameWidth: viewport.width, frameHeight: viewport.height,
      title: '', loading: false, error: null, closed: false, titleTimer: null,
      canBack: false, canForward: false, viewers: 0, chain: Promise.resolve()
    };
    this.sessions.set(id, s);
    this._wireSession(s);
    // 会话建立前已有观看者(WS 先连上):把观看人数补进来,否则 viewers 恒为 0
    const pending = this.pendingViewers.get(id) || 0;
    if (pending > 0) { s.viewers = pending; this.pendingViewers.delete(id); }
    this._startTitlePoll(); // 需要时才启动全局标题轮询(只轮询有观看者的会话)
    await this._startScreencast(s);
    return s;
  }

  private _wireSession(s: BrowserSession) {
    const sync = () => { this._refreshTitle(s); this._emitState(s); };
    s.page.on('framenavigated', (f) => { if (f === s.page.mainFrame()) sync(); });
    s.page.on('load', () => { s.loading = false; sync(); });
    s.page.on('domcontentloaded', () => { s.loading = false; sync(); });
    s.page.on('close', () => { s.closed = true; this.sessions.delete(s.id); this.emit('closed', { id: s.id }); });
    s.page.on('crash', () => { s.error = '页面崩溃'; this._emitState(s); });
    // 新窗口(target=_blank)在预览里没有第二块画布:直接关掉,并在当前页打开该地址
    s.page.on('popup', async (popup) => {
      try {
        const u = popup.url();
        await popup.close();
        if (u && u !== 'about:blank') await this._navigate(s, u);
      } catch { /* 忽略 */ }
    });
  }

  private async _startScreencast(s: BrowserSession) {
    s.cdp.on('Page.screencastFrame', async (f: any) => {
      if (s.closed) return;
      try { await s.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch { /* 忽略 */ }
      const buf = Buffer.from(String(f?.data || ''), 'base64');
      if (!buf.length) return;
      s.frame = buf;
      s.frameWidth = Number(f?.metadata?.deviceWidth) || s.viewport.width;
      s.frameHeight = Number(f?.metadata?.deviceHeight) || s.viewport.height;
      this.emit('frame', { id: s.id, data: buf, width: s.frameWidth, height: s.frameHeight });
    });
    await s.cdp.send('Page.enable');
    await this._restartScreencast(s);
  }

  private async _restartScreencast(s: BrowserSession) {
    try { await s.cdp.send('Page.stopScreencast'); } catch { /* 首次可能未启动 */ }
    try {
      await s.cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: SCREENCAST_QUALITY,
        maxWidth: s.viewport.width,
        maxHeight: s.viewport.height,
        everyNthFrame: 1
      });
    } catch { /* 页面可能已关闭 */ }
  }

  /**
   * 导航到目标地址。
   * 开发服务器最常见的两个坑都在这里兜住:
   *  1) 地址刚从终端输出里点出来,服务还在启动/首次编译(端口暂时拒绝连接)
   *     → 连接类错误自动重试几次;
   *  2) localhost 与 127.0.0.1 的 IPv4/IPv6 绑定不一致(vite 绑 127.0.0.1,
   *     而 localhost 先解析到 ::1)→ 两种写法交替重试。
   * 最终仍失败时,把 Chromium 的原始错误翻成可操作的中文说明。
   */
  private async _navigate(s: BrowserSession, url: string) {
    s.loading = true; s.error = null; this._emitState(s);
    const tries = navigationAttempts(url);
    let lastErr: any = null;
    for (let i = 0; i < tries.length; i++) {
      try {
        await s.page.goto(tries[i], {
          waitUntil: 'domcontentloaded',
          timeout: i === 0 ? NAV_TIMEOUT_MS : RETRY_NAV_TIMEOUT_MS
        });
        lastErr = null;
        break;
      } catch (e: any) {
        lastErr = e;
        if (i < tries.length - 1 && isRetryableNavError(e)) {
          await this._settle(s, 700 * (i + 1)); // 给服务一点点启动时间,再换写法/重试
          continue;
        }
        break;
      }
    }
    if (lastErr) s.error = describeNavError(lastErr, url);
    s.loading = false;
    this._refreshTitle(s);
    this._emitState(s);
  }

  /** 等待页面稳定(网络空闲一小段时间),让小片段动画/请求落地后再取快照 */
  private async _settle(s: BrowserSession, ms: number) {
    try { await s.page.waitForTimeout(ms); } catch { /* 忽略 */ }
  }

  private _refreshTitle(s: BrowserSession) {
    if (s.titleTimer) clearTimeout(s.titleTimer);
    s.titleTimer = setTimeout(async () => {
      try {
        s.title = (await s.page.title()) || '';
        await this._refreshHistory(s);
        this._emitState(s);
      } catch { /* 忽略 */ }
    }, 120);
    if (s.titleTimer.unref) s.titleTimer.unref();
  }

  /** 通过 CDP 取浏览历史游标,决定前进/后退按钮是否可用(Playwright 无同步 API) */
  private async _refreshHistory(s: BrowserSession) {
    try {
      const h = await s.cdp.send('Page.getNavigationHistory') as any;
      const idx = Number(h?.currentIndex) || 0;
      const len = Array.isArray(h?.entries) ? h.entries.length : 0;
      s.canBack = idx > 0;
      s.canForward = idx >= 0 && idx < len - 1;
    } catch { /* 页面可能已关闭 */ }
  }

  private _stateOf(s: BrowserSession): BrowserState {
    let url = '';
    try { url = s.page.url(); } catch { /* 忽略 */ }
    let ownerTitle: string | null = null;
    if (s.ownerSid && this.sessionTitleOf) {
      try { ownerTitle = this.sessionTitleOf(s.ownerSid); } catch { /* 查询失败只少了标题 */ }
    }
    return {
      id: s.id,
      url,
      title: s.title || '',
      loading: s.loading,
      canGoBack: s.canBack,
      canGoForward: s.canForward,
      viewport: { ...s.viewport },
      error: s.error,
      ownerSid: s.ownerSid,
      ownerTitle
    };
  }

  private _emitState(s: BrowserSession) {
    this.emit('state', this._stateOf(s));
  }
}

export const browserManager = new BrowserManager();
