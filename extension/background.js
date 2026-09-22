// Teleforge Auto 后台(service worker):反向连到本机 Teleforge 的 /ws/ext,接收指令并操作浏览器。
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

let ws = null;
let wsUrl = '';
let token = '';
/** 服务端下发的快照脚本(与内置预览同一份,见 server/core/browser-bridge.ts) */
let snapshotScript = '';
let paused = false;
let reconnectDelay = RECONNECT_MIN;
let reconnectTimer = null;
let lastError = '';

// ---------------- 配置与状态 ----------------

async function loadConfig() {
  const st = await chrome.storage.local.get(['serverBase', 'token', 'wsUrl', 'paused']);
  return {
    serverBase: String(st.serverBase || DEFAULT_SERVER).replace(/\/+$/, ''),
    token: String(st.token || ''),
    wsUrl: String(st.wsUrl || ''),
    paused: st.paused === true
  };
}

function detectBrowser() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\//.test(ua)) return 'opera';
  return 'chrome';
}

async function buildStatus() {
  const cfg = await loadConfig();
  return {
    connected: !!(ws && ws.readyState === 1),
    connecting: !!(ws && ws.readyState === 0),
    paused: cfg.paused,
    hasToken: !!cfg.token,
    serverBase: cfg.serverBase,
    wsUrl: cfg.wsUrl,
    error: lastError,
    version: chrome.runtime.getManifest().version,
    browser: detectBrowser(),
    attachedTabs: attachedTabs()
  };
}

function send(obj) {
  try {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch { /* 忽略 */ }
}

// ---------------- 配对与连接 ----------------

/** 探一个地址是不是 Teleforge 服务端(接口要求 X-Bridge-Pair 头,普通网页拿不到这个响应) */
async function probeServer(base) {
  try {
    const res = await fetch(base + '/api/browser-bridge/pair', {
      headers: { 'X-Bridge-Pair': '1' },
      signal: AbortSignal.timeout(1500)
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 自动找服务端:先试用户填的/记住的地址,再并行扫固定端口区间。
 * 安装版桌面端每次启动端口都可能不同,不能让用户去猜 —— 扫一遍就能找到。
 * @returns 第一个应答的地址;都连不上返回 null
 */
async function discoverServerBase(preferred) {
  const cfg = await loadConfig();
  const cands = [];
  if (preferred) cands.push(preferred);
  if (cfg.serverBase) cands.push(cfg.serverBase);
  cands.push(DEFAULT_SERVER);
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) cands.push(`http://127.0.0.1:${p}`);
  const uniq = [...new Set(cands.map((s) => String(s).replace(/\/+$/, '')))];
  const hits = await Promise.all(uniq.map(async (b) => ((await probeServer(b)) ? b : null)));
  return hits.find(Boolean) || null;
}

/** 从本机 Teleforge 取回配对 token 与 WS 地址(接口要求 X-Bridge-Pair 头,网页拿不到) */
async function pair(serverBase) {
  let base = String(serverBase || '').trim().replace(/\/+$/, '');
  // 没填地址、或填的地址连不上 → 自动扫端口区间找服务端
  if (!base || !(await probeServer(base))) {
    const found = await discoverServerBase(base);
    if (!found) {
      throw new Error(
        `没找到 Teleforge 服务端(已扫描 127.0.0.1:${PORT_RANGE_START}-${PORT_RANGE_END})。` +
        '请确认 Teleforge 正在运行,或在上面填服务地址后重试'
      );
    }
    base = found;
  }
  let res;
  try {
    res = await fetch(base + '/api/browser-bridge/pair', { headers: { 'X-Bridge-Pair': '1' } });
  } catch (e) {
    throw new Error(`连不上 ${base}:请确认 Teleforge 服务正在运行(${(e && e.message) || e})`);
  }
  if (!res.ok) throw new Error(`配对接口返回 ${res.status}:确认 Teleforge 版本已包含浏览器桥接`);
  const data = await res.json();
  if (!data || !data.token || !data.wsUrl) throw new Error('服务端没有返回配对信息');
  await chrome.storage.local.set({ serverBase: base, token: data.token, wsUrl: data.wsUrl });
  return { token: data.token, wsUrl: data.wsUrl };
}

async function connect() {
  const cfg = await loadConfig();
  if (!cfg.token || !cfg.wsUrl) throw new Error('还没有配对:请先在 popup 里填服务端地址并点「获取配对并连接」');
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  wsUrl = cfg.wsUrl;
  token = cfg.token;
  paused = cfg.paused;

  const url = wsUrl + (wsUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
  let sock;
  try {
    sock = new WebSocket(url);
  } catch (e) {
    throw new Error(`WebSocket 地址不合法:${wsUrl}(${(e && e.message) || e})`);
  }
  ws = sock;

  sock.onopen = () => {
    reconnectDelay = RECONNECT_MIN;
    lastError = '';
    send({
      type: 'ext_hello',
      token,
      version: chrome.runtime.getManifest().version,
      browser: detectBrowser(),
      capabilities: ['tabs', 'cdp', 'screenshot', 'evaluate']
    });
  };
  sock.onmessage = (ev) => { void onMessage(ev); };
  sock.onclose = () => {
    if (ws === sock) {
      ws = null;
      scheduleReconnect();
    }
  };
  sock.onerror = () => {
    lastError = '连接失败:确认 Teleforge 正在运行,且配对 token 没有失效';
  };
}

function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const sock = ws;
  ws = null;
  try { if (sock) sock.close(1000, 'user disconnect'); } catch { /* 忽略 */ }
  // 主动断开时把调试器全部摘掉,标签顶部的「正在调试」黄条随之消失
  for (const id of attachedTabs()) { detach(id).catch(() => {}); }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureConnected();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
}

async function ensureConnected() {
  const cfg = await loadConfig();
  if (!cfg.token) return;
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  try { await connect(); } catch (e) { lastError = String((e && e.message) || e); }
}

// ---------------- 指令处理 ----------------

async function onMessage(ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'ext_ping') { send({ type: 'ext_pong' }); return; }
  if (msg.type === 'ext_welcome') {
    snapshotScript = String(msg.snapshotScript || '');
    lastError = '';
    return;
  }
  if (msg.type === 'ext_config') return;
  if (msg.type !== 'ext_call') return;

  const id = msg.id;
  if (paused) {
    send({ type: 'ext_result', id, ok: false, error: '用户在扩展里暂停了 AI 控制(popup 里可恢复)' });
    return;
  }
  try {
    const data = await handleCall(String(msg.method || ''), msg.params || {});
    send({ type: 'ext_result', id, ok: true, data });
  } catch (e) {
    send({ type: 'ext_result', id, ok: false, error: String((e && e.message) || e) });
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
    .map((t) => ({ tabId: t.id, url: t.url || t.pendingUrl || '', title: t.title || '', active: t.active === true }));
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
  const tab = await chrome.tabs.create({ url, active: p.active !== false });
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

async function handleCall(method, p) {
  switch (method) {
    case 'tabs.list':
      return listTabs();
    case 'tabs.open':
      return openTab(p);
    case 'tabs.close':
      await closeTab(p.tabId);
      return { ok: true };
    case 'tabs.activate':
      return activateTab(p.tabId);
    case 'navigate':
      return ops.navigate(needTab(p.tabId), String(p.url || ''));
    case 'snapshot':
      return ops.snapshot(needTab(p.tabId), snapshotScript);
    case 'click':
      return ops.click(needTab(p.tabId), p);
    case 'type':
      return ops.type(needTab(p.tabId), p);
    case 'press':
      return ops.press(needTab(p.tabId), String(p.key || 'Enter'));
    case 'scroll':
      return ops.scroll(needTab(p.tabId), p);
    case 'wait':
      return ops.wait(needTab(p.tabId), p);
    case 'evaluate':
      return ops.evaluate(needTab(p.tabId), String(p.expression || ''));
    case 'screenshot':
      return ops.screenshot(needTab(p.tabId), p);
    case 'debug.detach':
      await detach(needTab(p.tabId));
      return { ok: true };
    default:
      throw new Error(`未知方法:${method}`);
  }
}

// ---------------- 标签变化上报 ----------------

function notifyTabs() {
  send({ type: 'ext_event', event: 'tabs_changed', at: Date.now() });
}

chrome.tabs.onCreated.addListener(() => notifyTabs());
chrome.tabs.onRemoved.addListener(() => notifyTabs());
chrome.tabs.onActivated.addListener(() => notifyTabs());
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info && (info.status === 'complete' || info.url || info.title)) notifyTabs();
});

// ---------------- 生命周期 ----------------

chrome.runtime.onInstalled.addListener(() => { void ensureConnected(); });
chrome.runtime.onStartup.addListener(() => { void ensureConnected(); });

chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a && a.name === 'bridge-keepalive') void ensureConnected();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  void (async () => {
    try {
      const type = msg && msg.type;
      if (type === 'status') {
        sendResponse({ ok: true, status: await buildStatus() });
      } else if (type === 'pair') {
        const r = await pair(msg.serverBase);
        await connect();
        sendResponse({ ok: true, status: await buildStatus(), wsUrl: r.wsUrl });
      } else if (type === 'connect') {
        await connect();
        sendResponse({ ok: true, status: await buildStatus() });
      } else if (type === 'disconnect') {
        disconnect();
        sendResponse({ ok: true, status: await buildStatus() });
      } else if (type === 'setPaused') {
        paused = msg.paused === true;
        await chrome.storage.local.set({ paused });
        sendResponse({ ok: true, status: await buildStatus() });
      } else if (type === 'detachAll') {
        for (const id of attachedTabs()) { await detach(id).catch(() => {}); }
        sendResponse({ ok: true, status: await buildStatus() });
      } else {
        sendResponse({ ok: false, error: `未知消息:${type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // 异步回复
});

// service worker 被唤醒时先尝试连上(已连则直接返回)
void ensureConnected();
