// 成果物卡片 + 右侧栏(文件预览 / 分栏 / 持久化)的真实浏览器测试。
//
// 环境要求:web/dist 已构建(npm run build)+ 本机有 Chrome/Edge(或 BROWSER_PREVIEW_EXECUTABLE)。
// 缺任一项则整段跳过并算通过 —— 那是环境问题,不是代码回归。
//
// 覆盖的链路(mock 模型分两步:write_local_file → present):
//   1. 模型交付文件 → assistant 气泡下方出现「交付文件」卡(与「N 个文件已更改」并存,语义不同);
//   2. 点卡片上的「侧栏」→ 右侧栏打开并显示该文件;
//   3. 同一个文件再点一次「侧栏」→ **不多开标签**(内容身份幂等),只是聚焦;
//   4. 分栏 → 两个 pane;
//   5. 刷新页面 → 布局与标签按会话持久化,仍然在;
//   6. 收起 → 细条;再展开 → 标签还在。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DATA = mkdtempSync(path.join(tmpdir(), 'sshai-rsb-'));
process.env.DATA_DIR = DATA;
mkdirSync(DATA, { recursive: true });
writeFileSync(path.join(DATA, 'ai-providers.json'), JSON.stringify([
  { id: 'u_mock', name: 'Mock', baseUrl: 'http://mock', models: ['mock'], apiKey: '' }
]));
writeFileSync(path.join(DATA, 'ui-state.json'), JSON.stringify({
  providerId: 'u_mock', customModel: '', models: { u_mock: 'mock' }, keys: {}, maxIters: {}
}));
writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ version: 1, defaultPermissionMode: 'full-access' }));

let pass = 0, fail = 0, skipped = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const skip = (why) => { skipped++; console.log(`  – 跳过:${why}`); };

const DIST = path.resolve('web/dist/index.html');
if (!existsSync(DIST)) {
  skip('web/dist 未构建(先跑 npm run build)');
  console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败, ${skipped} 跳过 ====`);
  process.exit(0);
}

const { chromium } = await import('playwright-core');
const { WebSocket } = await import('ws');
const { startApp } = await import('../server/index.ts');

const WORK_WS = mkdtempSync(path.join(tmpdir(), 'sshai-rsb-ws-'));

async function launchBrowser() {
  const cands = [];
  const exe = String(process.env.BROWSER_PREVIEW_EXECUTABLE || '').trim();
  if (exe) cands.push({ executablePath: exe });
  cands.push({ channel: 'chrome' }, { channel: 'msedge' }, {});
  for (const opts of cands) {
    try { return await chromium.launch({ ...opts, headless: true }); } catch { /* 试下一个 */ }
  }
  return null;
}

const browser = await launchBrowser();
if (!browser) {
  skip('本机没有可用的 Chrome/Edge/Chromium');
  console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败, ${skipped} 跳过 ====`);
  process.exit(0);
}

let app = null;
try {
  app = await startApp({ port: 0, host: '127.0.0.1', quiet: true });
  const PORT = app.server.address().port;

  // 前置:设好本地工作区(canSend 需要,write_local_file 也需要)
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const t = setTimeout(() => reject(new Error('ws 超时')), 10000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'set_local_workspace', path: WORK_WS, reqId: 'r1' })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.reqId === 'r1') { clearTimeout(t); ws.close(); resolve(); }
    });
    ws.on('error', reject);
  });

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('  [页面异常]', e.message); });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });

  const input = page.locator('textarea').first();
  await input.waitFor({ timeout: 20000 });
  check('应用已加载出对话输入框', await input.isVisible());
  await page.waitForTimeout(1200);

  console.log('\n[一] 模型交付文件 → 成果物卡片');
  await input.fill('给我一个成果物');
  await input.press('Enter');

  const card = page.locator('[data-deliverables]').first();
  await card.waitFor({ timeout: 45000 });
  check('出现成果物卡片', await card.isVisible());
  check('卡片标为已交付 1 个文件', (await card.getAttribute('data-deliverables')) === '1');
  const cardText = await card.innerText();
  check('卡片显示文件名', cardText.includes('deliverable.md'), cardText.slice(0, 120));
  check('卡片显示模型写的说明', cardText.includes('mock 生成的交付物'), cardText.slice(0, 160));
  // 「文件已更改」卡与成果物卡是两张不同的卡,必须并存(语义不同,不能合并)
  check('「N 个文件已更改」卡同时存在且是另一张卡',
    (await page.locator('.fcc').count()) >= 1 && (await page.locator('[data-deliverables]').count()) === 1);
  check('右侧栏在打开文件之前不存在', (await page.locator('.sidebar-right').count()) === 0);

  console.log('\n[二] 点「侧栏」→ 右侧栏打开该文件');
  await card.locator('[data-deliverable-aside]').first().click();
  const aside = page.locator('.sidebar-right').first();
  await aside.waitFor({ timeout: 15000 });
  check('右侧栏出现', await aside.isVisible());
  check('恰好一个标签', (await aside.locator('.rsb-tab').count()) === 1);
  check('标签标题是文件名', (await aside.locator('.rsb-tab-main').first().innerText()).includes('deliverable.md'));
  // 正文已挂载并真的读到了内容(FileViewer 走本机读取通道)
  await aside.locator('[data-sidebar-body]').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
  const bodyText = await aside.locator('[data-sidebar-body]').first().innerText();
  check('正文读到了文件内容', bodyText.includes('交付物') || bodyText.includes('deliverable'), bodyText.slice(0, 160));

  console.log('\n[三] 同一文件再次打开:内容身份幂等');
  // 先收起,再点一次「侧栏」——收起状态下也必须能再次打开
  await aside.locator('.rsb-act[aria-label="收起右侧栏"]').click();
  await page.waitForTimeout(300);
  check('收起后只剩细条', (await page.locator('.rsb-rail').count()) === 1 && (await page.locator('.sidebar-right').count()) === 0);
  await card.locator('[data-deliverable-aside]').first().click();
  await aside.waitFor({ timeout: 10000 });
  check('再次打开仍只有一个标签(不重复开)', (await aside.locator('.rsb-tab').count()) === 1,
    String(await aside.locator('.rsb-tab').count()));

  console.log('\n[四] 分栏');
  await aside.locator('[data-sidebar-split]').first().click();
  await page.waitForTimeout(300);
  check('分栏后有两个 pane', (await aside.locator('.rsb-pane').count()) === 2);
  check('出现分栏分隔条', (await aside.locator('[data-sidebar-divider]').count()) === 1);
  check('两个 pane 都各有一个标签条', (await aside.locator('.rsb-strip').count()) === 2);
  // 合并回去
  await aside.locator('[data-sidebar-merge]').first().click();
  await page.waitForTimeout(300);
  check('合并后回到一个 pane', (await aside.locator('.rsb-pane').count()) === 1);
  check('合并后标签没有丢', (await aside.locator('.rsb-tab').count()) === 1);

  console.log('\n[五] 按会话持久化:刷新后仍在');
  await aside.locator('[data-sidebar-split]').first().click(); // 分栏成 2 个,便于验证持久化
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('textarea').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(2000);
  const aside2 = page.locator('.sidebar-right').first();
  await aside2.waitFor({ timeout: 15000 });
  check('刷新后右侧栏仍在', await aside2.isVisible());
  check('刷新后标签仍在', (await aside2.locator('.rsb-tab').count()) >= 1,
    String(await aside2.locator('.rsb-tab').count()));
  check('刷新后分栏结构仍在(2 个 pane)', (await aside2.locator('.rsb-pane').count()) === 2,
    String(await aside2.locator('.rsb-pane').count()));

  console.log('\n[六] 无 JS 异常');
  check('整段流程没有页面异常', pageErrors.length === 0, pageErrors.join(' | '));
} catch (e) {
  fail++;
  console.log(`  ✗ 用例异常:${e.message}`);
} finally {
  try { await browser.close(); } catch { /* 忽略 */ }
  try { if (app?.server) app.server.close(); } catch { /* 忽略 */ }
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败, ${skipped} 跳过 ====`);
// node-pty 在浏览器关闭后偶发 AttachConsole 崩溃会污染退出码,故显式以断言结果为准
process.exit(fail ? 1 : 0);
