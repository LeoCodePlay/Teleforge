// 回归:用户手动切标签,不能改变 AI 正在操控的那个标签。
//
// 修的是这个隐患:agent/browser-backends.ts 的 resolveOps() 每次工具调用都新建一个 ops
// (闭包里的 cur 只在这一次调用内有效),所以"没传 tab_id"时旧实现会回落到**当前活动标签** ——
// 也就是用户此刻正在看的那个。用户随手切一下标签,AI 下一步就可能对着别的标签快照/点击
// (默认 ai-tabs 模式下会被 canOperate 拒掉变成一步失败;mode=all 或用户授权过那个标签时
// 更会真的操作错标签)。现在 browser_open 会把标签绑到会话上,用户怎么切都不影响。
//
// 做法:进程内起真服务端(startApp)+ 一个假扩展连上 /ws/ext(协议就是 JSON),
// 然后直接调用 browser_* 工具定义,检查指令最终落在哪个 tabId 上。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'tf-native-tab-'));
process.env.DATA_DIR = DATA_DIR;
process.env.HOST = '127.0.0.1';

const { WebSocket } = await import('ws');
const { startApp } = await import('../server/index.ts');
const { browserToolDefs } = await import('../server/agent/browser-tools.ts');

let pass = 0, fail = 0;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const check = (n, c, e = '') => { if (c) { pass++; log(`✓ ${n}`); } else { fail++; log(`✗ ${n} ${e}`); } };
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

const SNAPSHOT = { title: 'T', url: 'https://x/', viewportHeight: 800, scrollY: 0, scrollHeight: 900, items: ['e1 button "确定"'], heads: [], text: 'hi' };

/** 假扩展:维护一份标签清单,记录每条指令落在哪个 tabId 上 */
function makeFakeExtension(port, token) {
  const state = {
    tabs: [{ tabId: 1, url: 'https://user.example/', title: '用户自己的标签', active: true }],
    nextId: 2,
    /** 收到的每条指令:{method, params} */
    calls: [],
    ws: null,
    ready: false
  };

  const send = (obj) => { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj)); };
  const broadcast = () => send({ type: 'ext_event', event: 'tabs_changed', at: Date.now() });

  const handle = (msg) => {
    if (msg.type === 'ext_ping') { send({ type: 'ext_pong' }); return; }
    if (msg.type === 'ext_welcome') { state.ready = true; return; }
    if (msg.type !== 'ext_call') return;
    const { id, method, params = {} } = msg;
    state.calls.push({ method, params });
    const ok = (data) => send({ type: 'ext_result', id, ok: true, data });
    const bad = (error) => send({ type: 'ext_result', id, ok: false, error });
    switch (method) {
      case 'tabs.list':
        return ok(state.tabs);
      case 'tabs.open': {
        const tab = { tabId: state.nextId++, url: String(params.url || ''), title: 'AI 开的标签', active: params.active !== false };
        for (const t of state.tabs) t.active = false;
        state.tabs.push(tab);
        state.lastOpenedTabId = tab.tabId;
        broadcast();
        return ok({ tabId: tab.tabId, url: tab.url, title: tab.title });
      }
      case 'snapshot':
        return state.tabs.some((t) => t.tabId === params.tabId) ? ok(SNAPSHOT) : bad(`No tab with given id ${params.tabId}`);
      case 'click':
      case 'type':
      case 'press':
      case 'scroll':
      case 'navigate':
        return state.tabs.some((t) => t.tabId === params.tabId) ? ok({ ok: true, tabId: params.tabId }) : bad(`No tab with given id ${params.tabId}`);
      case 'tabs.close': {
        state.tabs = state.tabs.filter((t) => t.tabId !== params.tabId);
        if (state.tabs.length && !state.tabs.some((t) => t.active)) state.tabs[0].active = true;
        broadcast();
        return ok({ ok: true });
      }
      default:
        return bad(`未知方法:${method}`);
    }
  };

  state.connect = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/ext?token=${encodeURIComponent(token)}`);
    state.ws = ws;
    ws.on('error', reject);
    ws.on('open', () => {
      send({ type: 'ext_hello', token, version: 'test', browser: 'chrome', capabilities: ['tabs', 'cdp'] });
      resolve();
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      handle(m);
    });
  });

  /** 模拟"用户手动切到自己的标签" */
  state.userSwitchesToOwnTab = () => {
    for (const t of state.tabs) t.active = t.tabId === 1;
    broadcast();
  };
  /** 模拟"用户手动关掉了 AI 那个标签" */
  state.userClosesTab = (tabId) => {
    state.tabs = state.tabs.filter((t) => t.tabId !== tabId);
    broadcast();
  };
  state.lastCall = (method) => [...state.calls].reverse().find((c) => c.method === method) || null;
  /** 手动让扩展报一次"标签有变化",桥接会重新拉清单 */
  state.notify = broadcast;
  return state;
}

const tool = (name) => browserToolDefs.find((d) => d.name === name);
const ctx = (sid) => ({ sid, emit: () => {} });

let app = null;
let ext = null;
try {
  const port = await freePort();
  app = await startApp({ port, host: '127.0.0.1', quiet: true });
  const pair = await (await fetch(`http://127.0.0.1:${port}/api/browser-bridge/pair`, { headers: { 'X-Bridge-Pair': '1' } })).json();
  ext = makeFakeExtension(port, pair.token);
  await ext.connect();
  await sleep(400); // 等握手 + 首次 tabs.list

  const st = await (await fetch(`http://127.0.0.1:${port}/api/browser-bridge/pair`, { headers: { 'X-Bridge-Pair': '1' } })).json();
  check('假扩展已连上桥接', st.status.online === true, JSON.stringify(st.status));
  check('桥接已拉到标签清单', (st.status.tabs || []).length === 1, JSON.stringify(st.status.tabs));

  const sid = 's_bind_test';

  // 1) AI 开标签 → 绑定到这个对话
  const opened = await tool('browser_open').run({ url: 'https://ai.example/' }, ctx(sid));
  const aiTabId = ext.lastOpenedTabId;
  check('browser_open 在真机浏览器开了新标签', Number.isFinite(aiTabId), JSON.stringify(ext.tabs));
  check('browser_open 返回真机后端', opened.meta.backend === 'native', JSON.stringify(opened.meta).slice(0, 200));

  // 2) 用户切回自己的标签 —— 这是关键:AI 的下一步不能跟着跑到用户的标签上
  ext.userSwitchesToOwnTab();
  await sleep(400); // 等 tabs_changed 事件把新清单同步到桥接

  const snap = await tool('browser_snapshot').run({}, ctx(sid));
  const snapCall = ext.lastCall('snapshot');
  check('用户切标签后,browser_snapshot 仍作用于 AI 自己的标签', snapCall?.params.tabId === aiTabId, `落点=${snapCall?.params.tabId} 期望=${aiTabId}`);
  check('快照内容来自 AI 那个标签', String(snap.content).includes('页面标题'), String(snap.content).slice(0, 120));

  const clicked = await tool('browser_click').run({ ref: 'e1' }, ctx(sid));
  const clickCall = ext.lastCall('click');
  check('用户切标签后,browser_click 仍作用于 AI 自己的标签', clickCall?.params.tabId === aiTabId, `落点=${clickCall?.params.tabId} 期望=${aiTabId}`);
  check('点击没被授权模型拒掉', !/没有授权/.test(String(clicked.content)), String(clicked.content).slice(0, 200));

  // 3) 别的对话没有绑定 → 回落活动标签(用户那个),必须被授权模型挡住,而不是悄悄操作
  let otherErr = '';
  try {
    await tool('browser_snapshot').run({}, ctx('s_other'));
    otherErr = '(没有报错)';
  } catch (e) { otherErr = String(e?.message || e); }
  check('别的对话不会静默操作用户的标签', /没有授权/.test(otherErr), otherErr.slice(0, 200));
  check('被拒的调用没有真的下发 snapshot', ext.lastCall('snapshot')?.params.tabId === aiTabId, JSON.stringify(ext.lastCall('snapshot')));

  // 4) 用户手动关掉 AI 的标签 → 绑定失效,不拿死 tabId 去撞,而是给出可理解的拒绝
  ext.userClosesTab(aiTabId);
  await sleep(400);
  let afterCloseErr = '';
  try {
    await tool('browser_snapshot').run({}, ctx(sid));
    afterCloseErr = '(没有报错)';
  } catch (e) { afterCloseErr = String(e?.message || e); }
  check('标签被用户关掉后不会用死 tabId 继续操作', !/No tab with given id/.test(afterCloseErr), afterCloseErr.slice(0, 200));
  check('标签被关掉后给出可理解的说明', /没有授权|没有可操作的标签/.test(afterCloseErr), afterCloseErr.slice(0, 200));

  // 5) 显式传 tab_id 仍然优先(用户/模型指定谁就操作谁)
  ext.tabs.push({ tabId: 99, url: 'https://granted.example/', title: '用户交给 AI 的标签', active: false });
  ext.notify();
  const bridge = await import('../server/core/browser-bridge.ts');
  bridge.browserBridge.grant(99);
  await sleep(400);
  await tool('browser_snapshot').run({ tab_id: 99 }, ctx(sid));
  check('显式 tab_id 优先于会话绑定', ext.lastCall('snapshot')?.params.tabId === 99, JSON.stringify(ext.lastCall('snapshot')));
} catch (e) {
  fail++;
  log(`✗ 异常:${(e && e.stack) || e}`);
} finally {
  // fastify 的 close() 会等所有连接断开,而假扩展的 WS 还挂着 → 不 await,免得卡在收尾上
  try { ext?.ws?.close(); } catch { /* 忽略 */ }
  try { app?.app?.close(); } catch { /* 忽略 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}:${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
