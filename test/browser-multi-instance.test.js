// 回归:同一台服务端上,多台真机浏览器(Chrome + Edge)必须能**同时**在线。
//
// 修的是这个现象:server/core/browser-bridge.ts 旧实现只留一条扩展连接("新连接顶掉旧的",
// close code 4409),而扩展断线后 1s 就重连 —— 两个浏览器于是按 ~1s 的节奏互相顶掉,
// 用户看到的就是"刚显示已连接又断开"、状态点一直闪。现在按浏览器实例(id)各占一条连接,
// 标签授权/操作模式也各算各的;工具层用 browser 参数指定操作哪一台。
//
// 做法:进程内起真服务端 + 两个假扩展(instanceId/browser 不同)连同一个 /ws/ext,
// 先证明两边都稳定在线(没被顶掉),再驱动 browser_* 工具确认指令落在指定那台上。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'tf-multi-browser-'));
process.env.DATA_DIR = DATA_DIR;
process.env.HOST = '127.0.0.1';

const { WebSocket } = await import('ws');
const { startApp } = await import('../server/index.ts');
const { browserToolDefs } = await import('../server/agent/browser-tools.ts');
const { browserBridge } = await import('../server/core/browser-bridge.ts');

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

const snapshotOf = (label, url) => ({
  title: `${label} 的页面`, url, viewportHeight: 800, scrollY: 0, scrollHeight: 900,
  items: ['e1 button "确定"'], heads: [], text: `${label}-page`
});

/** 假扩展:一个浏览器实例 = 一条 /ws/ext 连接,带自己的实例 id 与标签清单 */
function makeFakeExtension(port, token, opts) {
  const state = {
    instanceId: opts.instanceId,
    browser: opts.browser,
    tabs: opts.tabs.map((t) => ({ ...t })),
    nextId: 10,
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
    const has = (tabId) => state.tabs.some((t) => t.tabId === tabId);
    switch (method) {
      case 'tabs.list':
        return ok(state.tabs);
      case 'tabs.open': {
        const tab = { tabId: state.nextId++, url: String(params.url || ''), title: `${opts.browser} 里 AI 开的标签`, active: true };
        for (const t of state.tabs) t.active = false;
        state.tabs.push(tab);
        state.lastOpenedTabId = tab.tabId;
        broadcast();
        return ok({ tabId: tab.tabId, url: tab.url, title: tab.title });
      }
      case 'snapshot': {
        if (!has(params.tabId)) return bad(`No tab with given id ${params.tabId}`);
        const t = state.tabs.find((x) => x.tabId === params.tabId);
        return ok(snapshotOf(opts.browser, t.url));
      }
      case 'click': case 'type': case 'press': case 'scroll': case 'navigate':
        return has(params.tabId) ? ok({ ok: true, tabId: params.tabId }) : bad(`No tab with given id ${params.tabId}`);
      case 'tabs.close':
        state.tabs = state.tabs.filter((t) => t.tabId !== params.tabId);
        broadcast();
        return ok({ ok: true });
      default:
        return bad(`unknown method ${method}`);
    }
  };

  state.connect = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/ext?token=${encodeURIComponent(token)}`);
    state.ws = ws;
    ws.on('error', reject);
    ws.on('open', () => {
      send({
        type: 'ext_hello', token, instanceId: state.instanceId, version: 'test',
        browser: state.browser, capabilities: ['tabs', 'cdp']
      });
      resolve();
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      handle(m);
    });
  });
  state.lastCall = (method) => [...state.calls].reverse().find((c) => c.method === method) || null;
  return state;
}

const tool = (name) => browserToolDefs.find((d) => d.name === name);
const ctx = (sid) => ({ sid, emit: () => {} });
/** 连接表指纹:实例 + 连接时刻。被顶掉的话 connectedAt 会变 */
const sig = (status) => (status.connections || []).map((c) => `${c.id}@${c.connectedAt}`).sort().join('|');

let app = null;
let edge = null;
let chrome = null;
try {
  const port = await freePort();
  app = await startApp({ port, host: '127.0.0.1', quiet: true });
  const pairStatus = async () => (await (await fetch(`http://127.0.0.1:${port}/api/browser-bridge/pair`, { headers: { 'X-Bridge-Pair': '1' } })).json());

  const pair = await pairStatus();
  // 两台浏览器都给同一个 tabId=1(Chrome 与 Edge 各自从 1 开始编号 —— 这正是要区分的场景)
  edge = makeFakeExtension(port, pair.token, {
    instanceId: 'edge11112222', browser: 'edge',
    tabs: [{ tabId: 1, url: 'https://edge.user/', title: 'Edge 用户标签', active: true }]
  });
  chrome = makeFakeExtension(port, pair.token, {
    instanceId: 'chrome33334444', browser: 'chrome',
    tabs: [{ tabId: 1, url: 'https://chrome.user/', title: 'Chrome 用户标签', active: true }]
  });
  await edge.connect();
  await chrome.connect();
  await sleep(600);

  const st1 = await pairStatus();
  check('两台浏览器同时在线', st1.status.onlineCount === 2, JSON.stringify(st1.status.connections));
  check('连接表按浏览器列出', (st1.status.connections || []).map((c) => c.label).sort().join('+') === 'Chrome+Edge',
    JSON.stringify(st1.status.connections));
  check('两台按实例 id 区分', new Set((st1.status.connections || []).map((c) => c.id)).size === 2,
    JSON.stringify((st1.status.connections || []).map((c) => c.id)));

  // 关键的"不再互相顶掉":等 1.5s(足够旧实现来回顶两次)后连接指纹必须一模一样
  const before = sig(st1.status);
  await sleep(1500);
  const st2 = await pairStatus();
  check('1.5s 后两台都还在,且没有被顶掉重建', st2.status.onlineCount === 2 && sig(st2.status) === before,
    `${before} → ${sig(st2.status)}`);

  // 标签授权按浏览器隔离:Chrome 的 1 号标签放行,不能顺手也让 Edge 的 1 号标签可操作
  browserBridge.grant(1, 'chrome');
  const chromeOk = browserBridge.canOperate(1, 'chrome').ok;
  const edgeOk = browserBridge.canOperate(1, 'edge').ok;
  check('授权按浏览器隔离(同名 tabId 不会串台)', chromeOk === true && edgeOk === false,
    `chrome=${chromeOk} edge=${edgeOk}`);

  const sid = 's_multi';

  // 1) browser_open 指定 edge:只有 Edge 收到 tabs.open
  const opened = await tool('browser_open').run({ url: 'https://ai.example/', browser: 'edge' }, ctx(sid));
  const edgeAiTab = edge.lastOpenedTabId;
  check('browser_open(browser=edge) 只落在 Edge', !!edge.lastCall('tabs.open') && !chrome.lastCall('tabs.open'),
    `edge=${edge.calls.length} chrome=${chrome.calls.length}`);
  check('结果里标明落在哪台浏览器', opened.meta.browserLabel === 'Edge' && opened.meta.browser === 'edge',
    JSON.stringify(opened.meta).slice(0, 300));

  // 2) 不传 browser:沿用本对话绑定的那台(Edge),且仍是 Edge 里 AI 自己开的标签
  await tool('browser_snapshot').run({}, ctx(sid));
  check('不传 browser 时沿用本对话绑定的 Edge 标签',
    edge.lastCall('snapshot')?.params.tabId === edgeAiTab && !chrome.lastCall('snapshot'),
    `edge=${edge.lastCall('snapshot')?.params.tabId} 期望=${edgeAiTab}`);

  // 3) 显式切到 chrome:落在 Chrome 自己的标签上
  chrome.calls.length = 0;
  await tool('browser_snapshot').run({ browser: 'chrome' }, ctx(sid));
  check('browser=chrome 切到 Chrome 的 1 号标签', chrome.lastCall('snapshot')?.params.tabId === 1,
    JSON.stringify(chrome.lastCall('snapshot')));
  check('切浏览器时不会错用另一台的实例', !edge.lastCall('snapshot') || edge.calls.every((c) => c.method !== 'snapshot' || c.params.tabId !== 1),
    JSON.stringify(edge.lastCall('snapshot')));

  // 4) 用连接 id(前缀)指定也认
  chrome.calls.length = 0;
  await tool('browser_snapshot').run({ browser: 'chrome3333' }, ctx(sid));
  check('browser 也接受连接 id 前缀', chrome.lastCall('snapshot')?.params.tabId === 1,
    JSON.stringify(chrome.lastCall('snapshot')));

  // 5) 指定一台不存在的浏览器:必须明确报错,不能悄悄退回默认目标
  let missErr = '';
  try { await tool('browser_snapshot').run({ browser: 'firefox' }, ctx(sid)); missErr = '(没有报错)'; }
  catch (e) { missErr = String(e?.message || e); }
  check('点名不存在的浏览器时明确报错并给出可选清单',
    /找不到在线的浏览器/.test(missErr) && /Chrome/.test(missErr) && /Edge/.test(missErr), missErr.slice(0, 240));

  // 6) 同一台浏览器重连(instanceId 不变):替换旧连接而不是新增一条,授权也不该丢
  chrome.ws.close();
  await sleep(200);
  await chrome.connect();
  await sleep(500);
  const st3 = await pairStatus();
  check('同一实例重连不新增连接(仍是 2 条)', st3.status.onlineCount === 2, JSON.stringify(st3.status.connections));
  check('重连后同一台的标签授权仍在', browserBridge.canOperate(1, 'chrome').ok === true,
    JSON.stringify(browserBridge.canOperate(1, 'chrome')));

  // 7) 一台掉线:另一台不受影响
  edge.ws.close();
  await sleep(400);
  const st4 = await pairStatus();
  check('Edge 掉线后 Chrome 仍在线', st4.status.onlineCount === 1 && st4.status.connections[0].id === 'chrome33334444',
    JSON.stringify(st4.status.connections));
  const stillWorks = await tool('browser_snapshot').run({ browser: 'chrome' }, ctx(sid));
  check('剩下那台仍能正常操作', chrome.lastCall('snapshot')?.params.tabId === 1, String(stillWorks.content).slice(0, 120));
} catch (e) {
  fail++;
  log(`✗ 异常:${(e && e.stack) || e}`);
} finally {
  // fastify 的 close() 会等所有连接断开,而假扩展的 WS 还挂着 → 不 await,免得卡在收尾上
  try { edge?.ws?.close(); } catch { /* 忽略 */ }
  try { chrome?.ws?.close(); } catch { /* 忽略 */ }
  try { app?.app?.close(); } catch { /* 忽略 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}:${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
