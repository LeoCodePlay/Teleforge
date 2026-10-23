// 桥接协议 v2 回归:子协议 token / snapshot v2 参数透传 / batch 一条指令 / act / 域名策略 / 审计日志。
//
// 与 browser-native-tab-binding.test.js 同样的做法:进程内起真服务端 + 一个假扩展连 /ws/ext,
// 然后直接调用 browser_* 工具定义,检查扩展收到的指令与工具返回的文本。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'tf-bridge-v2-'));
process.env.DATA_DIR = DATA_DIR;
process.env.HOST = '127.0.0.1';

const { WebSocket } = await import('ws');
const { startApp } = await import('../server/index.ts');
const { browserToolDefs } = await import('../server/agent/browser-tools.ts');
const { browserBridge } = await import('../server/core/browser-bridge.ts');
const { readAudit } = await import('../server/core/browser-audit.ts');

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

const SNAPSHOT_V2 = {
  v: 2, url: 'https://ai.example/inbox', title: '收件箱',
  viewport: { w: 1280, h: 800, scrollY: 0, scrollHeight: 2000 },
  nodes: [
    { ref: 'e1abc', role: 'heading', name: '收件箱', tag: 'h1', depth: 0, level: 1 },
    { ref: 'e2def', role: 'button', name: '新建', tag: 'button', depth: 1, loc: '#new' }
  ],
  frames: [{ index: 1, url: 'https://frame.example/', nodes: [{ ref: 'e3ghi', role: 'button', name: '框架内按钮', tag: 'button', depth: 1, loc: '#fbtn' }] }]
};

/** 假扩展 v2:支持 snapshot(带参数)/ batch / act,并记录收到的每条指令 */
function makeExt(port, token, { instanceId = 'inst_v2', useSubprotocol = true } = {}) {
  const state = { tabs: [{ tabId: 1, url: 'https://user.example/', title: '用户标签', active: true }], nextId: 2, calls: [], ws: null, lastOpenedTabId: null };
  const send = (o) => { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(o)); };
  const broadcast = () => send({ type: 'ext_event', event: 'tabs_changed', at: Date.now() });

  const handle = (msg) => {
    if (msg.type === 'ext_ping') { send({ type: 'ext_pong' }); return; }
    if (msg.type === 'ext_welcome') { state.welcome = msg; return; }
    if (msg.type !== 'ext_call') return;
    const { id, method, params = {} } = msg;
    state.calls.push({ method, params });
    const ok = (data) => send({ type: 'ext_result', id, ok: true, data });
    const bad = (error) => send({ type: 'ext_result', id, ok: false, error });
    switch (method) {
      case 'tabs.list': return ok(state.tabs);
      case 'tabs.open': {
        const tab = { tabId: state.nextId++, url: String(params.url || ''), title: 'AI 标签', active: params.active === true };
        for (const t of state.tabs) t.active = false;
        state.tabs.push(tab);
        state.lastOpenedTabId = tab.tabId;
        broadcast();
        return ok({ tabId: tab.tabId, url: tab.url, title: tab.title });
      }
      case 'tabs.close': state.tabs = state.tabs.filter((t) => t.tabId !== params.tabId); broadcast(); return ok({ ok: true });
      case 'snapshot': return ok({ ...SNAPSHOT_V2, tabIdUsed: params.tabId });
      case 'click': return ok({ ok: true });
      case 'act': return ok(`已执行动作:${params.action}`);
      case 'batch': {
        const steps = Array.isArray(params.steps) ? params.steps : [];
        const results = steps.map((s, i) => ({ index: i + 1, op: s.op, ok: true, detail: `第 ${i + 1} 步 ${s.op} 完成` }));
        const out = { ok: true, steps: results, failedAt: null, url: 'https://ai.example/inbox', title: '收件箱' };
        if (params.snapshot === 'always' || params.snapshot === 'on_error') out.snapshotData = SNAPSHOT_V2;
        return ok(out);
      }
      default: return bad(`未知方法:${method}`);
    }
  };

  state.connect = () => new Promise((resolve, reject) => {
    const url = useSubprotocol
      ? `ws://127.0.0.1:${port}/ws/ext`
      : `ws://127.0.0.1:${port}/ws/ext?token=${encodeURIComponent(token)}`;
    const ws = useSubprotocol ? new WebSocket(url, [`tf.${token}`]) : new WebSocket(url);
    state.ws = ws;
    ws.on('error', reject);
    ws.on('open', () => {
      state.negotiated = ws.protocol;
      send({ type: 'ext_hello', token, instanceId, version: '1.1.0', protocol: 2, browser: 'chrome' });
      resolve();
    });
    ws.on('message', (raw) => { let m; try { m = JSON.parse(String(raw)); } catch { return; } handle(m); });
  });
  state.lastCall = (method) => [...state.calls].reverse().find((c) => c.method === method) || null;
  return state;
}

const tool = (name) => browserToolDefs.find((d) => d.name === name);
const ctx = (sid) => ({ sid, emit: () => {} });

let app = null;
let ext = null;
let ext2 = null;
try {
  const port = await freePort();
  app = await startApp({ port, host: '127.0.0.1', quiet: true });
  const pair = await (await fetch(`http://127.0.0.1:${port}/api/browser-bridge/pair`, { headers: { 'X-Bridge-Pair': '1' } })).json();
  ext = makeExt(port, pair.token);
  await ext.connect();
  await sleep(500);

  // ---------- 1. 握手与协议协商 ----------
  check('子协议 token 被服务端回选(握手成功)', ext.negotiated === `tf.${pair.token}`, String(ext.negotiated));
  check('welcome 带协议版本 2', Number(ext.welcome?.protocol) === 2, JSON.stringify(ext.welcome).slice(0, 120));
  check('welcome 下发快照函数源码(v2)', /function/.test(String(ext.welcome?.snapshotScriptSrc || '')), String(ext.welcome?.snapshotScriptSrc).slice(0, 40));
  check('welcome 仍兼容旧扩展的自执行脚本', /\)\(\)\s*$/.test(String(ext.welcome?.snapshotScript || '').trim()), String(ext.welcome?.snapshotScript).slice(-10));

  const status = browserBridge.status();
  check('状态里能看到协议版本', status.protocolVersion === 2, String(status.protocolVersion));
  check('状态里带域名策略(默认空)', Array.isArray(status.domains?.allowed) && Array.isArray(status.domains?.blocked), JSON.stringify(status.domains));

  // 老写法(?token=)仍能连:用另一个实例 id,避免把上面那条顶掉
  ext2 = makeExt(port, pair.token, { instanceId: 'inst_legacy', useSubprotocol: false });
  await ext2.connect();
  await sleep(400);
  check('旧版 ?token= 连接仍然可用(向后兼容)', browserBridge.status().onlineCount === 2, String(browserBridge.status().onlineCount));
  ext2.ws.close();
  await sleep(300);

  const sid = 's_bridge_v2';

  // ---------- 2. 快照:参数透传 + v2 渲染 ----------
  await tool('browser_open').run({ url: 'https://ai.example/inbox' }, ctx(sid));
  const tabId = ext.lastOpenedTabId;
  check('browser_open 默认不抢焦点(active=false)', ext.lastCall('tabs.open')?.params.active === false, JSON.stringify(ext.lastCall('tabs.open')?.params));

  const snap = await tool('browser_snapshot').run({ scope: 'subtree', root: 'e2def', text: 500 }, ctx(sid));
  const snapParams = ext.lastCall('snapshot')?.params || {};
  check('snapshot 把 scope/root/text 透传给扩展', snapParams.scope === 'subtree' && snapParams.root === 'e2def' && Number(snapParams.text) === 500, JSON.stringify(snapParams));
  check('快照文本是 v2 结构(页面结构/ref)', String(snap.content).includes('页面结构') && String(snap.content).includes('e2def'), String(snap.content).slice(0, 160));
  check('子框架 ref 带 fN: 前缀', String(snap.content).includes('f1:e3ghi'), String(snap.content).slice(0, 240));

  // ---------- 3. 批处理 ----------
  const steps = [
    { op: 'click', ref: 'e2def' },
    { op: 'type', selector: '#title', text: '周报' },
    { op: 'wait', text: '已保存' },
    { op: 'assert', text: '已保存' }
  ];
  const batched = await tool('browser_batch').run({ steps, snapshot: 'always' }, ctx(sid));
  const batchCall = ext.lastCall('batch');
  check('batch 只下发一条指令(不用一步一次工具调用)', !!batchCall && batchCall.params.steps.length === 4, JSON.stringify(batchCall?.params).slice(0, 120));
  check('batch 结果按步回报', String(batched.content).includes('✓ 1. click') && String(batched.content).includes('✓ 4. assert'), String(batched.content).slice(0, 200));
  check('batch 的原始快照由服务端渲染成同一套文本', String(batched.content).includes('页面结构'), String(batched.content).slice(-160));

  const noSnapshot = await tool('browser_batch').run({ steps, snapshot: 'never' }, ctx(sid));
  check('snapshot=never 时不附快照', !String(noSnapshot.content).includes('页面结构'), String(noSnapshot.content).slice(-80));

  let emptyErr = '';
  try { await tool('browser_batch').run({ steps: [] }, ctx(sid)); } catch (e) { emptyErr = String(e?.message || e); }
  check('空 steps 被拒绝并给出说明', /steps/.test(emptyErr), emptyErr.slice(0, 80));

  // ---------- 4. 通用动作 ----------
  const acted = await tool('browser_act').run({ action: 'hover', ref: 'e2def' }, ctx(sid));
  check('browser_act 把 action 透传给扩展', ext.lastCall('act')?.params.action === 'hover', JSON.stringify(ext.lastCall('act')?.params));
  check('动作结果回给模型', String(acted.content).includes('已执行动作:hover'), String(acted.content));

  // ---------- 5. 点击回执:默认不再每步塞全量快照 ----------
  const clicked = await tool('browser_click').run({ ref: 'e2def' }, ctx(sid));
  check('点击默认只回执,不附全量快照', !String(clicked.content).includes('页面结构') && String(clicked.content).includes('当前页面'), String(clicked.content).slice(0, 120));
  const clickedWithSnap = await tool('browser_click').run({ ref: 'e2def', snapshot: true }, ctx(sid));
  check('显式 snapshot=true 才附快照', String(clickedWithSnap.content).includes('页面结构'), String(clickedWithSnap.content).slice(0, 120));

  // ---------- 6. 站点经验:记下来 + 下次打开自动提示 ----------
  const saved = await tool('browser_memory').run({ action: 'save', url: 'https://ai.example/inbox', note: '「新建」在右上角,loc=#new', selector: '#new' }, ctx(sid));
  check('经验可以保存', String(saved.content).includes('已记下'), String(saved.content));
  const listed = await tool('browser_memory').run({ action: 'list', url: 'https://ai.example/inbox' }, ctx(sid));
  check('经验可以列出', String(listed.content).includes('右上角'), String(listed.content));
  const reopened = await tool('browser_open').run({ url: 'https://ai.example/inbox' }, ctx(sid));
  check('browser_open 自动带上本站经验', String(reopened.content).includes('本站经验') && String(reopened.content).includes('右上角'), String(reopened.content).slice(-200));
  const forgot = await tool('browser_memory').run({ action: 'forget', url: 'https://ai.example/inbox' }, ctx(sid));
  check('经验可以清除', String(forgot.content).includes('已删除'), String(forgot.content));

  // ---------- 7. 域名策略 ----------
  browserBridge.setDomains({ blocked: ['evil.example'] });
  ext.tabs.push({ tabId: 500, url: 'https://evil.example/admin', title: '危险站点', active: false });
  browserBridge.grant(500);
  ext.ws.send(JSON.stringify({ type: 'ext_event', event: 'tabs_changed', at: Date.now() }));
  await sleep(400);
  let domainErr = '';
  try { await tool('browser_snapshot').run({ tab_id: 500 }, ctx(sid)); } catch (e) { domainErr = String(e?.message || e); }
  check('禁止清单里的域名会被拒', /禁止清单/.test(domainErr), domainErr.slice(0, 160));
  browserBridge.setDomains({ allowed: [], blocked: [] });

  // ---------- 8. 审计日志(mutating 工具自动落盘,不含输入内容) ----------
  const audit = readAudit(50);
  check('审计日志有记录', audit.length > 0, String(audit.length));
  const batchAudit = audit.find((a) => a.tool === 'browser_batch');
  check('审计记录了 batch 步数', !!batchAudit && batchAudit.steps === 4, JSON.stringify(batchAudit));
  check('审计不记录输入文本内容', !JSON.stringify(audit).includes('周报'), JSON.stringify(audit).slice(0, 200));
  const clickAudit = audit.find((a) => a.tool === 'browser_click');
  check('审计记录后端与 url', !!clickAudit && clickAudit.backend === 'native' && String(clickAudit.url).includes('ai.example'), JSON.stringify(clickAudit));
} catch (e) {
  fail++;
  log(`✗ 异常:${(e && e.stack) || e}`);
} finally {
  try { ext?.ws?.close(); } catch { /* 忽略 */ }
  try { ext2?.ws?.close(); } catch { /* 忽略 */ }
  try { app?.app?.close(); } catch { /* 忽略 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}:${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
