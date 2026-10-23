// 回归:AI 用 browser_open 开的标签必须一直有权限 —— 换 socket、服务端重启、链接点开的新标签都算。
//
// 之前的两个漏洞:
//   1) "AI 自建"只记在内存里:服务端一重启/扩展一重连,标签就变成"没有授权",读页面直接失败;
//   2) 标记时用 tabId 反查连接:清单还没刷新或多浏览器并存时会标到错的连接上。
// 现在:开标签在桥接层原子标记(知道是哪条连接开的)+ 落盘到 browser-bridge.json,
// 并把"AI 标签里点开的子标签(openerTabId)"也自动归给 AI。
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'tf-tab-perm-'));
process.env.DATA_DIR = DATA_DIR;
process.env.HOST = '127.0.0.1';

const { WebSocket } = await import('ws');
const { startApp } = await import('../server/index.ts');
const { browserToolDefs } = await import('../server/agent/browser-tools.ts');
const { browserBridge } = await import('../server/core/browser-bridge.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function makeExt(port, token, { instanceId, browser = 'chrome', nextId = 2 }) {
  const state = { tabs: [{ tabId: 1, url: 'https://user.example/', title: '用户的标签', active: true, openerTabId: null }], nextId, ws: null, calls: [] };
  const send = (o) => { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(o)); };
  const broadcast = () => send({ type: 'ext_event', event: 'tabs_changed', at: Date.now() });
  const handle = (msg) => {
    if (msg.type === 'ext_ping') { send({ type: 'ext_pong' }); return; }
    if (msg.type === 'ext_welcome') return;
    if (msg.type !== 'ext_call') return;
    const { id, method, params = {} } = msg;
    state.calls.push({ method, params });
    const ok = (data) => send({ type: 'ext_result', id, ok: true, data });
    const bad = (error) => send({ type: 'ext_result', id, ok: false, error });
    switch (method) {
      case 'tabs.list': return ok(state.tabs);
      case 'tabs.open': {
        const tab = { tabId: state.nextId++, url: String(params.url || ''), title: 'AI 标签', active: params.active === true, openerTabId: null };
        if (tab.active) for (const t of state.tabs) t.active = false;
        state.tabs.push(tab);
        state.lastOpenedTabId = tab.tabId;
        broadcast();
        return ok({ tabId: tab.tabId, url: tab.url, title: tab.title });
      }
      case 'tabs.close': state.tabs = state.tabs.filter((t) => t.tabId !== params.tabId); broadcast(); return ok({ ok: true });
      case 'snapshot': return state.tabs.some((t) => t.tabId === params.tabId)
        ? ok({ v: 2, url: 'https://ai.example/', title: 'AI 页面', nodes: [{ ref: 'e1', role: 'button', name: '确定', tag: 'button', depth: 0 }] })
        : bad(`No tab with given id ${params.tabId}`);
      case 'click': return ok({ ok: true });
      default: return bad(`未知方法:${method}`);
    }
  };
  state.connect = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/ext?token=${encodeURIComponent(token)}`);
    state.ws = ws;
    ws.on('error', reject);
    ws.on('open', () => {
      send({ type: 'ext_hello', token, instanceId, version: '1.1.0', protocol: 2, browser });
      resolve();
    });
    ws.on('message', (raw) => { let m; try { m = JSON.parse(String(raw)); } catch { return; } handle(m); });
  });
  state.addTab = (tab) => { state.tabs.push(tab); broadcast(); };
  state.lastCall = (method) => [...state.calls].reverse().find((c) => c.method === method) || null;
  return state;
}

const tool = (name) => browserToolDefs.find((d) => d.name === name);
const ctx = (sid) => ({ sid, emit: () => {} });
const tabOf = (hint, tabId) => browserBridge.status(hint).tabs.find((t) => t.tabId === tabId) || null;

let app = null;
let chrome = null;
let edge = null;
try {
  const port = await freePort();
  app = await startApp({ port, host: '127.0.0.1', quiet: true });
  const pair = await (await fetch(`http://127.0.0.1:${port}/api/browser-bridge/pair`, { headers: { 'X-Bridge-Pair': '1' } })).json();
  chrome = makeExt(port, pair.token, { instanceId: 'inst_chrome', browser: 'chrome' });
  await chrome.connect();
  await sleep(400);

  // ---------- 1. AI 开的标签立刻有权限 ----------
  const sid = 's_perm';
  await tool('browser_open').run({ url: 'https://ai.example/inbox' }, ctx(sid));
  const aiTab = chrome.lastOpenedTabId;
  check('browser_open 开了新标签', Number.isFinite(aiTab), String(aiTab));
  const t1 = tabOf('chrome', aiTab);
  check('新标签立刻标记为 AI 自建', !!t1 && t1.owned === true && t1.allowed === true, JSON.stringify(t1));

  const snap = await tool('browser_snapshot').run({ tab_id: aiTab }, ctx(sid));
  check('立刻就能读页面(不再报没有授权)', String(snap.content).includes('页面结构'), String(snap.content).slice(0, 120));

  // ---------- 2. 授权落盘 ----------
  await sleep(500);
  let saved = null;
  try { saved = JSON.parse(readFileSync(join(DATA_DIR, 'browser-bridge.json'), 'utf8')); } catch { /* 没写出来 */ }
  const stored = saved?.auth?.inst_chrome;
  check('AI 自建标签写进了 browser-bridge.json', !!stored && (stored.aiTabs || []).includes(aiTab), JSON.stringify(saved?.auth));

  // ---------- 3. 扩展重连(换 socket)后仍然有权限 ----------
  chrome.ws.close();
  await sleep(300);
  await chrome.connect();
  await sleep(400);
  const snap2 = await tool('browser_snapshot').run({ tab_id: aiTab }, ctx(sid));
  check('扩展重连后仍有权限', String(snap2.content).includes('页面结构'), String(snap2.content).slice(0, 120));

  // ---------- 4. 服务端重启(内存授权清空、只剩磁盘)后仍有权限 ----------
  chrome.ws.close();
  await sleep(300);                    // 先让旧连接彻底断开(它断开时会把授权写回内存)
  browserBridge.authByInstance.clear(); // 模拟服务端重启:内存没了,只剩磁盘
  await chrome.connect();
  await sleep(500);
  const t2 = tabOf('chrome', aiTab);
  check('重启后从磁盘恢复授权', !!t2 && t2.owned === true, JSON.stringify(t2));
  const snap3 = await tool('browser_snapshot').run({ tab_id: aiTab }, ctx(sid));
  check('重启后仍能读页面', String(snap3.content).includes('页面结构'), String(snap3.content).slice(0, 120));

  // ---------- 5. AI 标签里点开的子标签自动归 AI(openerTabId) ----------
  const childId = 900;
  chrome.addTab({ tabId: childId, url: 'https://ai.example/detail', title: '点开的新标签', active: false, openerTabId: aiTab });
  await sleep(500);
  const t3 = tabOf('chrome', childId);
  check('AI 标签里打开的链接自动归 AI', !!t3 && t3.owned === true && t3.allowed === true, JSON.stringify(t3));
  const snap4 = await tool('browser_snapshot').run({ tab_id: childId }, ctx(sid));
  check('子标签也能直接读', String(snap4.content).includes('页面结构'), String(snap4.content).slice(0, 120));

  // 用户自己的标签里开出的标签不该被顺带授权
  const userChild = 901;
  chrome.addTab({ tabId: userChild, url: 'https://user.example/x', title: '用户点开的', active: false, openerTabId: 1 });
  await sleep(400);
  const t4 = tabOf('chrome', userChild);
  check('用户标签的子标签不会被误授权', !!t4 && t4.owned === false && t4.allowed === false, JSON.stringify(t4));

  // ---------- 6. 多浏览器:标在真正执行的那台上 ----------
  edge = makeExt(port, pair.token, { instanceId: 'inst_edge', browser: 'edge', nextId: 5000 });
  await edge.connect();
  await sleep(400);
  await tool('browser_open').run({ url: 'https://ai.example/edge', browser: 'edge' }, ctx(sid));
  const edgeTab = edge.lastOpenedTabId;
  const te = tabOf('edge', edgeTab);
  const tc = tabOf('chrome', edgeTab);
  check('browser=edge 开的标签标在 Edge 上', !!te && te.owned === true, JSON.stringify(te));
  check('不会误标到 Chrome 同名 tabId 上', !tc || tc.owned === false, JSON.stringify(tc));
  const snapEdge = await tool('browser_snapshot').run({ tab_id: edgeTab, browser: 'edge' }, ctx(sid));
  check('Edge 上那个标签能直接读', String(snapEdge.content).includes('页面结构'), String(snapEdge.content).slice(0, 120));
} catch (e) {
  fail++;
  console.log(`  ✗ 异常:${(e && e.stack) || e}`);
} finally {
  try { chrome?.ws?.close(); } catch { /* 忽略 */ }
  try { edge?.ws?.close(); } catch { /* 忽略 */ }
  try { app?.app?.close(); } catch { /* 忽略 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}:${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
