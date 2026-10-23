// Teleforge Auto 后台(service worker):反向连到本机 Teleforge 的 /ws/ext,接收指令并操作浏览器。
//
// 多服务端:桌面端与开发用的网页端(`npm run dev`)经常同时在这台机器上跑,各自占
// 4000-4019 里的一个端口。扩展因此对**每个服务端各持一条 WebSocket**(conns 表),
// 而不是只连一个 —— 单连接时新连的会把旧的顶掉,表现就是"连上网页端之后桌面端就再也用不了"。
// 指令的回复只发回发起它的那条连接;标签变化事件广播给所有连接。
//
// 保活要点(MV3 的 service worker 默认约 30s 空闲就被回收):
//   - WebSocket 有收发活动时 Chrome 会重置空闲计时器(116+),服务端每 20s 发一次 ext_ping,足够维持常驻;
//   - 再加一个 chrome.alarms 每 30s 兜底唤醒,断线就按指数退避重连。
import { attachedTabs, detach } from './cdp.js';
import * as ops from './page-ops.js';

const DEFAULT_SERVER = 'http://127.0.0.1:4000';
// 桌面端(安装版)会在这段固定区间里挑端口,见 src-tauri/src/backend.rs 的 PORT_RANGE_*。
// 两边必须一致:端口随机的话扩展根本扫不到服务端,用户装好扩展也配不上对。
const PORT_RANGE_START = 4000;
const PORT_RANGE_END = 4019;
const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 30000;

/**
 * 已配对的服务端:base(`http://127.0.0.1:4011`) → 连接记录。
 * 一条记录 = 一个服务端 = 一条 WebSocket,互不影响:网页端与桌面端可以同时在线。
 */
const conns = new Map();
/** 全局暂停开关(所有服务端共用一个):popup 里勾上后任何服务端都调不动浏览器 */
let paused = false;

/**
 * 本浏览器实例的稳定 id:首次运行生成一次写进 chrome.storage.local,之后每次重连都带上。
 * 服务端靠它区分「同一台浏览器重连(该替换旧连接)」和「另一台浏览器(该各占一条连接)」——
 * 没有它,Chrome 与 Edge 会被当成同一条连接的争夺者,互相顶掉。
 */
let instanceId = '';
let instanceOnce = null;
function loadInstanceId() {
  if (instanceId) return Promise.resolve(instanceId);
  if (!instanceOnce) {
    instanceOnce = (async () => {
      try {
        const st = await chrome.storage.local.get(['instanceId']);
        let id = String(st.instanceId || '').trim();
        if (!/^[0-9a-f]{8,32}$/i.test(id)) {
          const rnd = (globalThis.crypto && crypto.randomUUID)
            ? crypto.randomUUID().replace(/-/g, '')
            : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
          id = rnd.slice(0, 12);
          try { await chrome.storage.local.set({ instanceId: id }); } catch { /* 存不下也先用本次的 */ }
        }
        instanceId = id;
      } catch { /* 读存储失败:按旧协议上报,由服务端给临时 id */ }
      return instanceId;
    })();
  }
  return instanceOnce;
}

// ---------------- 地址与持久化 ----------------

function normBase(s) {
  return String(s || '').trim().replace(/\/+$/, '');
}

/**
 * 把用户填的东西变成服务地址。支持三种写法:
 *   4011 / 127.0.0.1:4011 / http://127.0.0.1:4011
 * 只填端口是最常用的一种 —— 用户看着桌面端日志或面板上的端口号就能直接连,
 * 不必记住"要带 http:// 前缀"。
 */
function normalizeInput(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) return `http://127.0.0.1:${s}`;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return normBase(s);
}

/** 已配对服务端清单(base/token/wsUrl)落盘,service worker 被回收后据此恢复 */
async function loadSavedServers() {
  const st = await chrome.storage.local.get(['servers', 'serverBase', 'token', 'wsUrl']);
  let list = Array.isArray(st.servers) ? st.servers : [];
  list = list
    .filter((x) => x && x.base && x.token && x.wsUrl)
    .map((x) => ({ base: normBase(x.base), token: String(x.token), wsUrl: String(x.wsUrl), kind: String(x.kind || '') }));
  // 旧版本只存单个服务端(serverBase/token/wsUrl):升级后直接迁移,不用重新配对
  if (!list.length && st.serverBase && st.token && st.wsUrl) {
    list = [{ base: normBase(st.serverBase), token: String(st.token), wsUrl: String(st.wsUrl), kind: '' }];
    await chrome.storage.local.remove(['serverBase', 'token', 'wsUrl']);
  }
  return list;
}

async function saveSavedServers() {
  const list = [...conns.values()].map((c) => ({ base: c.base, token: c.token, wsUrl: c.wsUrl, kind: c.kind }));
  await chrome.storage.local.set({ servers: list });
}

function ensureConn(rec) {
  let conn = conns.get(rec.base);
  if (!conn) {
    conn = {
      base: rec.base,
      token: rec.token,
      wsUrl: rec.wsUrl,
      /** 'desktop' | 'web':由服务端在配对响应里告知,只为在 popup 里标出来是哪一个,不影响连接 */
      kind: rec.kind || '',
      ws: null,
      /** 该服务端下发的快照脚本:按连接保存,两个服务端版本不同时内容可能不一样 */
      snapshotScript: '',
      /** v2:函数源码(未执行),调用时带上 scope/root/text 参数 */
      snapshotScriptSrc: '',
      reconnectDelay: RECONNECT_MIN,
      reconnectTimer: null,
      /** true = 服务端不支持子协议 token,退回 ?token= 老写法 */
      useQueryToken: false,
      lastError: ''
    };
    conns.set(rec.base, conn);
  } else {
    conn.token = rec.token;
    conn.wsUrl = rec.wsUrl;
    if (rec.kind) conn.kind = rec.kind;
  }
  return conn;
}

// ---------------- 配对与连接 ----------------

/**
 * 问一个地址是不是 Teleforge 服务端。接口要求 X-Bridge-Pair 头(普通网页拿不到),
 * 并且校验响应里确实带 token + wsUrl —— 只认 2xx 会把恰好监听在这个端口的其他服务当成服务端。
 * @returns 配对信息 {token, wsUrl};不是 Teleforge 则 null
 */
async function fetchPair(base) {
  try {
    const res = await fetch(base + '/api/browser-bridge/pair', {
      headers: { 'X-Bridge-Pair': '1' },
      signal: AbortSignal.timeout(1500)
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.token || !data.wsUrl) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 扫出所有在跑的服务端。桌面端每次启动的端口都可能不同,不能让用户去猜 ——
 * 扫一遍就能把网页端和桌面端一起找出来(不是只取第一个)。
 * @returns [{base, data}]
 */
async function discoverServers(extra = []) {
  const cands = new Set();
  for (const raw of extra) {
    const b = normalizeInput(raw);
    if (b) cands.add(b);
  }
  for (const c of conns.keys()) cands.add(c);
  cands.add(DEFAULT_SERVER);
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) cands.add(`http://127.0.0.1:${p}`);
  const bases = [...cands];
  const hits = await Promise.all(bases.map(async (base) => ({ base, data: await fetchPair(base) })));
  return hits.filter((h) => h.data);
}

/** 配对并登记一个服务端(不建立连接,由 connectConn 负责) */
async function registerServer(rawBase) {
  const base = normalizeInput(rawBase);
  if (!base) throw new Error('请填服务地址,例如 4011 或 127.0.0.1:4011');
  const data = await fetchPair(base);
  if (!data) throw new Error(`连不上 ${base}:确认 Teleforge 正在运行,且端口填对了`);
  const conn = ensureConn({ base, token: data.token, wsUrl: data.wsUrl, kind: data.kind });
  await saveSavedServers();
  return conn;
}

function sendTo(conn, obj) {
  try {
    if (conn.ws && conn.ws.readyState === 1) conn.ws.send(JSON.stringify(obj));
  } catch { /* 忽略 */ }
}

function connectConn(conn) {
  if (conn.ws && (conn.ws.readyState === 0 || conn.ws.readyState === 1)) return;
  // 优先把 token 放进 WebSocket 子协议(不进 URL,不会被访问日志/代理记下来);
  // 老版本服务端不认子协议时,握手会失败 → 自动退回 ?token= 的老写法(只退一次)。
  const useProto = !conn.useQueryToken;
  const url = useProto
    ? conn.wsUrl
    : conn.wsUrl + (conn.wsUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(conn.token);
  let sock;
  let opened = false;
  try {
    sock = useProto ? new WebSocket(url, ['tf.' + conn.token]) : new WebSocket(url);
  } catch (e) {
    conn.lastError = `WebSocket 地址不合法:${conn.wsUrl}(${(e && e.message) || e})`;
    scheduleReconnect(conn);
    return;
  }
  conn.ws = sock;

  sock.onopen = async () => {
    opened = true;
    conn.reconnectDelay = RECONNECT_MIN;
    conn.lastError = '';
    let iid = '';
    try { iid = await loadInstanceId(); } catch { /* 拿不到就按旧协议上报 */ }
    // 等实例 id 期间用户可能已经断开 / 被新连接顶掉:那就别再把 hello 发出去
    if (conn.ws !== sock || sock.readyState !== 1) return;
    sendTo(conn, {
      type: 'ext_hello',
      token: conn.token,
      instanceId: iid,
      version: chrome.runtime.getManifest().version,
      protocol: 2,
      browser: detectBrowser(),
      capabilities: ['tabs', 'cdp', 'screenshot', 'evaluate', 'batch', 'act', 'snapshot-v2', 'frames', 'actionability']
    });
  };
  sock.onmessage = (ev) => { void onMessage(conn, ev); };
  sock.onclose = () => {
    if (conn.ws !== sock) return;
    conn.ws = null;
    conn.snapshotScript = '';
    conn.snapshotScriptSrc = '';
    if (!opened && useProto) {
      // 握手阶段就失败:多半是服务端还不支持子协议 token,退回查询参数再试一次
      conn.useQueryToken = true;
      conn.lastError = '';
      setTimeout(() => { if (!conn.ws) connectConn(conn); }, 300);
      return;
    }
    scheduleReconnect(conn);
  };
  sock.onerror = () => {
    conn.lastError = '连接失败:确认 Teleforge 正在运行,且配对 token 没有失效';
  };
}

/** 断开一个服务端。forget=true 表示同时忘掉它(不再自动重连) */
async function disconnectConn(base, forget) {
  const conn = conns.get(base);
  if (!conn) return;
  if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = null; }
  const sock = conn.ws;
  const wasLive = !!(sock && sock.readyState === 1);
  conn.ws = null;
  conn.snapshotScript = '';
  try { if (sock) sock.close(1000, 'user disconnect'); } catch { /* 忽略 */ }
  if (forget) {
    conns.delete(base);
    await saveSavedServers();
  }
  // 只有这条连接本来在跑时才摘调试器:断开其中一个服务端不该把另一个正在用的也断掉
  if (wasLive) {
    for (const id of attachedTabs()) { detach(id).catch(() => {}); }
  }
}

function scheduleReconnect(conn) {
  if (conn.reconnectTimer) return;
  conn.reconnectTimer = setTimeout(() => {
    conn.reconnectTimer = null;
    if (conns.get(conn.base) === conn) connectConn(conn);
  }, conn.reconnectDelay);
  conn.reconnectDelay = Math.min(conn.reconnectDelay * 2, RECONNECT_MAX);
}

/** 恢复持久化的服务端并保证每条都连上(service worker 唤醒/浏览器启动/心跳都走这里) */
async function ensureConnected() {
  const saved = await loadSavedServers();
  for (const rec of saved) {
    const conn = ensureConn(rec);
    connectConn(conn);
  }
  return saved.length;
}

/**
 * 定时兜底:重连所有已配对服务端;若一个都没连上(桌面端换了端口、服务端刚重启等),
 * 再扫一遍端口区间把它们找回来。列表为空时**不扫** —— 用户主动断开过的服务端不该被擅自加回来。
 */
async function keepAlive() {
  await ensureConnected();
  const online = [...conns.values()].some((c) => c.ws && c.ws.readyState === 1);
  if (conns.size && !online) {
    try { await scanAndConnect(); } catch { /* 扫描失败不影响重连 */ }
  }
}

/** 扫端口区间,把发现的服务端全部配对并连接(已有的跳过),返回本次新增的地址 */
async function scanAndConnect() {
  const found = await discoverServers();
  const added = [];
  for (const { base, data } of found) {
    const existing = conns.get(base);
    if (existing && existing.token === data.token) {
      if (data.kind) existing.kind = data.kind;
      connectConn(existing); // 已配对但没连上 → 顺手连上
      continue;
    }
    const conn = ensureConn({ base, token: data.token, wsUrl: data.wsUrl, kind: data.kind });
    added.push(base);
    connectConn(conn);
  }
  if (added.length || found.length) await saveSavedServers();
  return { added, found: found.map((f) => f.base) };
}

// ---------------- 状态 ----------------

function detectBrowser() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\//.test(ua)) return 'opera';
  return 'chrome';
}

function portOf(base) {
  const m = String(base).match(/:(\d+)$/);
  return m ? m[1] : '';
}

function buildStatus() {
  const servers = [...conns.values()].map((c) => ({
    base: c.base,
    port: portOf(c.base),
    kind: c.kind || '',
    connected: !!(c.ws && c.ws.readyState === 1),
    connecting: !!(c.ws && c.ws.readyState === 0),
    /** 服务端协议版本(2 = 支持 batch / snapshot v2);0 = 还没握手 */
    protocol: Number(c.protocol) || 0,
    error: c.lastError || ''
  }));
  return {
    paused,
    servers,
    online: servers.filter((s) => s.connected).length,
    version: chrome.runtime.getManifest().version,
    browser: detectBrowser(),
    /** 浏览器实例 id(同一台浏览器里固定):服务端靠它把多台浏览器区分成多条连接 */
    instance: instanceId,
    attachedTabs: attachedTabs()
  };
}

// ---------------- 指令处理 ----------------

async function onMessage(conn, ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'ext_ping') { sendTo(conn, { type: 'ext_pong' }); return; }
  if (msg.type === 'ext_welcome') {
    conn.snapshotScript = String(msg.snapshotScript || '');
    conn.snapshotScriptSrc = String(msg.snapshotScriptSrc || '');
    conn.protocol = Number(msg.protocol) || 1;
    conn.lastError = '';
    return;
  }
  if (msg.type === 'ext_config') return;
  if (msg.type !== 'ext_call') return;

  const id = msg.id;
  if (paused) {
    sendTo(conn, { type: 'ext_result', id, ok: false, error: '用户在扩展里暂停了 AI 控制(popup 里可恢复)' });
    return;
  }
  try {
    const data = await handleCall(String(msg.method || ''), msg.params || {}, conn);
    sendTo(conn, { type: 'ext_result', id, ok: true, data });
  } catch (e) {
    sendTo(conn, { type: 'ext_result', id, ok: false, error: String((e && e.message) || e) });
  } finally {
    updateBadge();
  }
}

function needTab(tabId) {
  const id = Number(tabId);
  if (!Number.isFinite(id)) throw new Error('缺少 tabId(先用 tabs.list / browser_open 拿到标签 id)');
  return id;
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => t.id != null)
    .map((t) => ({
      tabId: t.id,
      url: t.url || t.pendingUrl || '',
      title: t.title || '',
      active: t.active === true,
      // 这个标签是从哪个标签打开的(链接 target=_blank / window.open):
      // 服务端据此把「AI 标签里点开的子标签」也认作 AI 自建,否则新标签会没授权。
      openerTabId: Number.isFinite(t.openerTabId) ? t.openerTabId : null
    }));
}

async function waitTabComplete(tabId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return null;
    if (t.status === 'complete') return t;
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

async function openTab(p) {
  const url = String(p.url || '').trim();
  if (!url) throw new Error('url 不能为空');
  // 默认后台打开:AI 干活不该抢走用户正在看的标签(focus=true 才切前台)
  const tab = await chrome.tabs.create({ url, active: p.active === true });
  const t = (await waitTabComplete(tab.id)) || tab;
  return { tabId: tab.id, url: t.url || url, title: t.title || '' };
}

async function closeTab(tabId) {
  const id = needTab(tabId);
  await detach(id).catch(() => {});
  await chrome.tabs.remove(id);
}

async function activateTab(tabId) {
  const id = needTab(tabId);
  const t = await chrome.tabs.update(id, { active: true });
  if (t && t.windowId != null) {
    await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
  }
  return { tabId: id, url: (t && t.url) || '', title: (t && t.title) || '' };
}

// ---------------- 每标签串行队列 ----------------
// 同一个标签上的指令必须按顺序落地:batch 跑到一半插进来一个 click,页面状态就不可解释了。
// 不同标签之间仍然并发(多任务并行不受影响)。
const tabQueues = new Map();

function withTabLock(tabId, fn) {
  const prev = tabQueues.get(tabId) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  tabQueues.set(tabId, tail);
  tail.finally(() => {
    if (tabQueues.get(tabId) === tail) tabQueues.delete(tabId);
  }).catch(() => {});
  return run;
}

function updateBadge() {
  try {
    const n = attachedTabs().length;
    chrome.action.setBadgeText({ text: n ? String(n) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#ff3b6b' });
  } catch { /* 忽略 */ }
}

async function handleCall(method, p, conn) {
  // 标签级操作
  switch (method) {
    case 'tabs.list':
      return listTabs();
    case 'tabs.open':
      return openTab(p);
    case 'tabs.close':
      await closeTab(p.tabId);
      updateBadge();
      return { ok: true };
    case 'tabs.activate':
      return activateTab(p.tabId);
    default:
      break;
  }

  const id = needTab(p.tabId);
  await ops.init(id);
  return withTabLock(id, async () => {
    switch (method) {
      case 'navigate':
        return ops.navigate(id, String(p.url || ''));
      case 'snapshot':
        // v2:下发的是函数源码,带上 scope/root/text;旧服务端只会给已自执行的表达式(直接求值)
        if (conn.snapshotScriptSrc) return ops.snapshot(id, conn.snapshotScriptSrc, p);
        if (!conn.snapshotScript) throw new Error('快照脚本还没下发(扩展刚连接上),请稍后重试');
        return ops.evaluate(id, conn.snapshotScript);
      case 'click':
        return ops.click(id, p);
      case 'type':
        return ops.type(id, { ...p, text: String(p.text == null ? '' : p.text) });
      case 'press':
        return ops.press(id, String(p.key || 'Enter'));
      case 'scroll':
        return ops.scroll(id, p);
      case 'wait':
        return ops.wait(id, p);
      case 'evaluate':
        return ops.evaluate(id, String(p.expression || ''));
      case 'screenshot':
        return ops.screenshot(id, p);
      case 'act':
        return ops.act(id, String(p.action || ''), p);
      case 'batch':
        return ops.batch(id, p.steps, p, conn.snapshotScriptSrc || '');
      case 'debug.detach':
        await detach(id);
        updateBadge();
        return { ok: true };
      default:
        throw new Error(`未知方法:${method}`);
    }
  });
}

// ---------------- 标签变化上报 ----------------

/** 标签是浏览器全局的,任何服务端都可能在跟踪它们 → 广播给所有连接 */
function notifyTabs() {
  for (const conn of conns.values()) {
    sendTo(conn, { type: 'ext_event', event: 'tabs_changed', at: Date.now() });
  }
}

chrome.tabs.onCreated.addListener(() => notifyTabs());
chrome.tabs.onRemoved.addListener(() => notifyTabs());
chrome.tabs.onActivated.addListener(() => notifyTabs());
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info && (info.status === 'complete' || info.url || info.title)) notifyTabs();
});

// ---------------- 生命周期 ----------------

/** 首次安装/升级:一份配置都没有时自动扫一遍,装完就能用 */
async function bootstrap() {
  const saved = await ensureConnected();
  if (!saved) {
    try { await scanAndConnect(); } catch { /* 服务端没在跑就算了,用户可在 popup 里重试 */ }
  }
}

chrome.runtime.onInstalled.addListener(() => { void bootstrap(); });
chrome.runtime.onStartup.addListener(() => { void ensureConnected(); });

chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a && a.name === 'bridge-keepalive') void keepAlive();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  void (async () => {
    try {
      const type = msg && msg.type;
      if (type === 'status') {
        sendResponse({ ok: true, status: buildStatus() });
      } else if (type === 'connect') {
        // 用户显式填了地址/端口:只连这一个(填了就走填的,不擅自扫别的)
        const conn = await registerServer(msg.serverBase);
        connectConn(conn);
        sendResponse({ ok: true, status: buildStatus(), base: conn.base });
      } else if (type === 'scan') {
        const r = await scanAndConnect();
        sendResponse({ ok: true, status: buildStatus(), added: r.added, found: r.found });
      } else if (type === 'reconnect') {
        const base = normBase(msg.base);
        const conn = conns.get(base);
        if (!conn) throw new Error('该服务端不在列表里,请重新填地址连接');
        // 能连上就重新配对一次(服务端重启会让旧 token 失效);连不上就按原样重连,等它回来
        const data = await fetchPair(base);
        if (data) {
          conn.token = data.token;
          conn.wsUrl = data.wsUrl;
          if (data.kind) conn.kind = data.kind;
          await saveSavedServers();
        }
        connectConn(conn);
        sendResponse({ ok: true, status: buildStatus() });
      } else if (type === 'remove') {
        await disconnectConn(normBase(msg.base), true);
        sendResponse({ ok: true, status: buildStatus() });
      } else if (type === 'disconnectAll') {
        for (const base of [...conns.keys()]) await disconnectConn(base, true);
        sendResponse({ ok: true, status: buildStatus() });
      } else if (type === 'setPaused') {
        paused = msg.paused === true;
        await chrome.storage.local.set({ paused });
        sendResponse({ ok: true, status: buildStatus() });
      } else if (type === 'detachAll') {
        for (const id of attachedTabs()) { await detach(id).catch(() => {}); }
        sendResponse({ ok: true, status: buildStatus() });
      } else {
        sendResponse({ ok: false, error: `未知消息:${type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // 异步回复
});

// service worker 被唤醒时先恢复连接与暂停开关(已连则直接返回)
void (async () => {
  const st = await chrome.storage.local.get(['paused']);
  paused = st.paused === true;
  await loadInstanceId();
  await ensureConnected();
})();
