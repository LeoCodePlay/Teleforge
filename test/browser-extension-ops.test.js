// 扩展页面操作层(page-ops.js)的真实浏览器回归。
//
// 做法:用 playwright-core 起一个真 Chromium,把 chrome.debugger.sendCommand 直接接到
// Playwright 的 CDPSession 上(同一个 CDP 协议),这样跑的就是**扩展里的那份代码**,
// 不是另写一套模拟实现。覆盖:快照 v2(影子 DOM/子框架)、可操作性(遮挡)、点击/输入、
// 批处理一条往返、等待与通用动作。
//
// 没有可用 Chrome/Edge 时整段跳过并算通过(与 browser-preview.test.js 的约定一致)。
import http from 'node:http';
import { SNAPSHOT_SCRIPT } from '../server/core/browser-snapshot.ts';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

function serve(html) {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function launch() {
  const { chromium } = await import('playwright-core');
  const tries = [
    ...(process.env.BROWSER_PREVIEW_EXECUTABLE ? [{ executablePath: process.env.BROWSER_PREVIEW_EXECUTABLE }] : []),
    { channel: 'chrome' },
    { channel: 'msedge' },
    {}
  ];
  for (const opts of tries) {
    try { return await chromium.launch({ headless: true, ...opts }); } catch { /* 换下一个 */ }
  }
  return null;
}

const browser = await launch();
if (!browser) {
  console.log('  跳过:本机没有可用的 Chrome/Edge');
  process.exit(0);
}

const srvB = await serve('<!doctype html><title>B</title><button id="cross">跨域按钮</button>');
const portB = srvB.address().port;
const srvA = await serve(`<!doctype html><html><head><title>扩展操作测试</title></head><body>
  <h1>工具条</h1>
  <button id="inc">加一</button><span id="count">0</span>
  <input id="name" placeholder="名字">
  <div id="rich" contenteditable="true">开头</div>
  <my-box></my-box>
  <iframe id="same" srcdoc="&lt;button id='sbtn'&gt;同源框架按钮&lt;/button&gt;"></iframe>
  <iframe id="cross" src="http://127.0.0.1:${portB}/"></iframe>
  <div style="height:2000px"></div>
  <button id="far">底部按钮</button>
  <div id="veil" style="position:fixed;inset:0;display:none;background:rgba(0,0,0,.2);z-index:9999"></div>
  <script>
    document.getElementById('inc').onclick = () => {
      const c = document.getElementById('count');
      c.textContent = String(Number(c.textContent) + 1);
    };
    document.getElementById('far').onclick = () => { window.__far = 1; };
    customElements.define('my-box', class extends HTMLElement {
      connectedCallback() {
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<button id="sh">影子按钮</button>';
        root.getElementById('sh').onclick = () => { window.__shadow = 1; };
      }
    });
  </script>
</body></html>`);
const portA = srvA.address().port;

const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${portA}/`);
await page.waitForTimeout(400);

// ---- chrome.* 假实现:CDP 命令直连 Playwright ----
const cdp = await context.newCDPSession(page);
const extListeners = new Set();
for (const ev of ['Page.javascriptDialogOpening', 'Page.frameNavigated', 'Network.requestWillBeSent',
  'Network.loadingFinished', 'Network.loadingFailed', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown']) {
  cdp.on(ev, (params) => { for (const fn of extListeners) { try { fn(ev, params); } catch { /* 忽略 */ } } });
}
const noopEvent = { addListener() {}, removeListener() {} };
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '1.1.0-test' }) },
  tabs: {
    get: async (id) => ({ id, url: page.url(), title: await page.title().catch(() => ''), status: 'complete', active: true }),
    query: async () => [{ id: 1, url: page.url(), title: await page.title().catch(() => ''), active: true }],
    create: async () => { throw new Error('测试里不该开新标签'); },
    remove: async () => {},
    update: async () => ({ id: 1, url: page.url() }),
    onCreated: noopEvent, onRemoved: noopEvent, onActivated: noopEvent, onUpdated: noopEvent
  },
  windows: { update: async () => ({}) },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  alarms: { create() {}, onAlarm: noopEvent },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    getTargets: async () => [],
    sendCommand: async (_target, method, params) => cdp.send(method, params),
    onEvent: { addListener: (fn) => extListeners.add(fn) },
    onDetach: noopEvent
  }
};

const ops = await import('../extension/page-ops.js');
const script = SNAPSHOT_SCRIPT.toString();
const TAB = 1;

// ---------------- 快照 v2 ----------------
await ops.init(TAB);
const snap = await ops.snapshot(TAB, script, { scope: 'full_page' });
const byName = (s, name) => (s.nodes || []).find((n) => String(n.name).includes(name));
check('快照返回 v2 结构', snap.v === 2 && Array.isArray(snap.nodes), JSON.stringify(snap).slice(0, 100));
check('识别主文档按钮', !!byName(snap, '加一')?.ref, JSON.stringify(byName(snap, '加一')));
check('穿透 shadow DOM', !!byName(snap, '影子按钮')?.ref);
check('抓到子框架', Array.isArray(snap.frames) && snap.frames.length >= 2, JSON.stringify(snap.frames?.map((f) => f.index)));
const frame2 = (snap.frames || []).find((f) => String(f.url).includes(String(portB)));
check('跨域框架有 url 记录', !!frame2, JSON.stringify(snap.frames));
check('跨域框架内容可读或被明确说明', !frame2 || (frame2.nodes || []).some((n) => n.name === '跨域按钮') || !!frame2.note,
  JSON.stringify(frame2).slice(0, 160));
const frame1 = (snap.frames || []).find((f) => String(f.url).includes('srcdoc'));
check('同源框架内容可读', !!frame1 && (frame1.nodes || []).some((n) => n.name === '同源框架按钮'),
  JSON.stringify(frame1).slice(0, 160));

// ---------------- 点击(可操作性 + 真实输入事件) ----------------
const inc = byName(snap, '加一');
await ops.click(TAB, { ref: inc.ref });
check('点击靠 ref 命中并触发页面逻辑', (await page.textContent('#count')) === '1');
const shadowRef = byName(snap, '影子按钮').ref;
await ops.click(TAB, { ref: shadowRef });
check('点击 shadow DOM 里的按钮', (await page.evaluate(() => window.__shadow)) === 1);

// 遮挡:铺一层全屏遮罩后必须明确失败(而不是点错东西)
await page.evaluate(() => { document.getElementById('veil').style.display = 'block'; });
const occluded = await ops.click(TAB, { ref: inc.ref, timeoutMs: 700 }).then(() => '').catch((e) => String(e.message || e));
check('被遮挡时给出明确失败', /遮挡/.test(occluded), occluded.slice(0, 120));
await page.evaluate(() => { document.getElementById('veil').style.display = 'none'; });

// 屏幕外元素:先滚动再点
const far = (await ops.snapshot(TAB, script, { scope: 'full_page' })).nodes.find((n) => n.name === '底部按钮');
await ops.click(TAB, { ref: far.ref });
check('屏幕外元素先滚动再点击', (await page.evaluate(() => window.__far)) === 1);

// ---------------- 输入 ----------------
const nameRef = (await ops.snapshot(TAB, script, { scope: 'full_page' })).nodes.find((n) => n.selector === '#name' || n.loc === '#name');
const typed = await ops.type(TAB, { selector: '#name', text: '张三', submit: false });
check('输入框写入成功', (await page.inputValue('#name')) === '张三', typed);

// 中文是重点回归项:历史上第一次输入会被吞/变成乱码,第二次才对
await ops.type(TAB, { selector: '#name', text: '你好,世界', submit: false });
check('中文一次输入即正确', (await page.inputValue('#name')) === '你好,世界', await page.inputValue('#name'));
await ops.type(TAB, { selector: '#rich', text: '这是评论区', submit: false });
check('contenteditable 中文一次输入即正确', (await page.textContent('#rich')) === '这是评论区', await page.textContent('#rich'));
await ops.type(TAB, { selector: '#name', text: '追加', clear: false, submit: false });
check('clear=false 时追加而非覆盖', (await page.inputValue('#name')) === '你好,世界追加', await page.inputValue('#name'));

// ---------------- 批处理:一次调用跑完整段 ----------------
const batch = await ops.batch(TAB, [
  { op: 'click', ref: inc.ref },
  { op: 'wait', selector: '#count' },
  { op: 'click', ref: inc.ref },
  { op: 'type', selector: '#name', text: '李四' },
  { op: 'assert', text: '工具条' }
], { stopOnError: true, snapshot: 'always' }, script);
check('批处理全部成功', batch.ok === true, JSON.stringify(batch.steps));
check('批处理返回最终快照', !!batch.snapshotData && Array.isArray(batch.snapshotData.nodes), JSON.stringify(batch.snapshotData || {}).slice(0, 80));
check('批处理后页面状态生效', (await page.textContent('#count')) === '3' && (await page.inputValue('#name')) === '李四');

const bad = await ops.batch(TAB, [
  { op: 'click', ref: inc.ref },
  { op: 'assert', text: '这段文字肯定不存在' },
  { op: 'click', ref: inc.ref }
], { stopOnError: true, snapshot: 'on_error' }, script);
check('批处理遇错即停并报告失败步', bad.ok === false && bad.failedAt === 2, JSON.stringify(bad.steps.map((s) => s.ok)));

// ---------------- 子框架操作 ----------------
const snap3 = await ops.snapshot(TAB, script, { scope: 'full_page' });
const f1 = (snap3.frames || []).find((f) => String(f.url).includes('srcdoc'));
const sameBtn = (f1?.nodes || []).find((n) => n.name === '同源框架按钮');
if (sameBtn) {
  const r = await ops.click(TAB, { ref: `f1:${sameBtn.ref}`, timeoutMs: 2500 }).then(() => 'ok').catch((e) => String(e.message || e));
  check('同源框架里可以点击(fN: 前缀)', r === 'ok', r.slice(0, 160));
} else {
  check('同源框架里可以点击(fN: 前缀)', false, '快照里没有定位到框架内按钮');
}

// ---------------- 通用动作 / 等待 ----------------
await ops.act(TAB, 'hover', { selector: '#inc' });
await ops.act(TAB, 'networkidle', { timeoutMs: 1500 });
const textOut = await ops.act(TAB, 'text', { max: 200 });
check('text 能读到正文', textOut.includes('工具条'), textOut.slice(0, 60));
await ops.wait(TAB, { text: '工具条', timeoutMs: 1000 });
check('wait 文本命中', true);

const shot = await ops.screenshot(TAB, {});
check('截图返回 base64', typeof shot === 'string' && shot.length > 100);

await browser.close();
srvA.close(); srvB.close();

console.log(`\n扩展操作层测试:${pass} 通过,${fail} 失败`);
process.exit(fail ? 1 : 0);
