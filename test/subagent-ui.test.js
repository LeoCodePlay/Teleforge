// 子代理面板 UI 冒烟(真浏览器):派发子代理 → 卡片「查看会话」→ 右侧抽屉显示完整对话。
//
// 环境要求:web/dist 已构建(npm run build)+ 本机有 Chrome/Edge(或 BROWSER_PREVIEW_EXECUTABLE)。
// 缺任一项则整段跳过并算通过 —— 那是环境问题,不是代码回归。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 预置:mock 模型(无需 API Key)+ 完全访问(免审批)+ 选中 mock 提供方
const DATA = mkdtempSync(path.join(tmpdir(), 'sshai-sa-ui-'));
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
const skip = (why) => { skipped++; console.log(`  … 跳过:${why}`); };

const DIST = path.resolve('web/dist/index.html');
if (!existsSync(DIST)) {
  skip('web/dist 未构建(先跑 npm run build)');
  console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败, ${skipped} 跳过 ====`);
  process.exit(0);
}

const { chromium } = await import('playwright-core');
const { WebSocket } = await import('ws');
const { startApp } = await import('../server/index.ts');

const WORK_WS = mkdtempSync(path.join(tmpdir(), 'sshai-sa-ui-ws-'));

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
  // 端口交给系统分配:固定端口会和残留进程/并行用例抢(实测会 EADDRINUSE)
  app = await startApp({ port: 0, host: '127.0.0.1', quiet: true });
  const PORT = app.server.address().port;

  // 前置:用 ws 客户端把本地工作区设好(前端 canSend 需要 workspace 或 localWorkspace)
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

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [页面异常]', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });

  const input = page.locator('textarea').first();
  await input.waitFor({ timeout: 20000 });
  check('应用已加载出对话输入框', await input.isVisible());

  // 等前端把 mock 模型下发到服务端(加载 providers/ui-state 后会自动 send('llm'))
  await page.waitForTimeout(1200);

  check('还没派发时没有悬浮胶囊(整块面板不存在)', (await page.locator('.dock-fab').count()) === 0);

  await input.fill('派个子代理看看工作区');
  await input.press('Enter');

  // 父代理 → subagent 工具卡
  const card = page.locator('[data-tool="subagent"]').first();
  await card.waitFor({ timeout: 40000 });
  check('对话里出现子代理工具卡', await card.isVisible());
  const cardText = await card.innerText();
  check('卡片摘要显示派发任务名', cardText.includes('看工作区目录'), cardText.slice(0, 80));

  // 右上角悬浮胶囊
  const fab = page.locator('.dock-fab').first();
  check('右上角出现「运行与子代理」胶囊', await fab.isVisible());
  check('没有运行终端时,终端分区不出现(只有子代理分区)',
    (await page.locator('[data-dock-tab="subagent"]').count()) === 1 && (await page.locator('[data-dock-tab="term"]').count()) === 0);

  // 点卡片行尾的「查看会话」→ 抽屉打开并定位到这次派发
  const openBtn = card.locator('.dsh-rowAction').first();
  // runId 随 tool/result 到达,入口按钮随后才出现(运行中先看胶囊)
  await openBtn.waitFor({ timeout: 25000 });
  check('卡片上有「查看会话」入口', (await openBtn.count()) > 0);
  await openBtn.click();
  await page.locator('.dock-drawer.open').first().waitFor({ timeout: 10000 });
  check('右侧抽屉已打开', true);

  // 等详情加载完成:工具行出现 + 这次派发收尾(状态栏进入终态)后再读文本,
  // 避免读到还在流式追加的中间态。
  // 详情区照搬正常对话:工具调用以主对话同款工具行(.dsh-tooltree)出现
  await page.locator('.dock-drawer .sa-chat .dsh-tooltree').first().waitFor({ timeout: 15000 });
  // 可能有多次派发:等「这次」的结论真的渲染出来再读文本,避免读到中间态/别的记录的状态
  await page.locator('.dock-drawer .sa-chat').getByText('结论:目录可读').first().waitFor({ timeout: 25000 });
  // 等抽屉的位移过渡(.24s)结束:.msg 带 content-visibility:auto,过渡途中还在屏外时 innerText 会跳过内容
  await page.waitForTimeout(450);
  const drawerText = await page.locator('.dock-drawer').first().innerText();
  check('抽屉里有派发记录列表', drawerText.includes('看工作区目录'));
  check('对话首条是父对话生成的任务与边界', drawerText.includes('任务目标') && drawerText.includes('边界(必须遵守)'), drawerText.slice(0, 200));
  check('对话里有子代理的真实工具调用(主对话同款工具行)',
    (await page.locator('.dock-drawer .sa-chat [data-tool="get_local_info"]').count()) > 0);
  check('对话里有子代理的结论', drawerText.includes('结论:目录可读'), drawerText.slice(-120));
  check('不再显示步数/调用次数等过程元信息', !/\d+\s*步/.test(drawerText) && !/次调用/.test(drawerText), drawerText.slice(-80));
  check('详情区用正常对话样式(用户气泡 + 助手气泡)',
    (await page.locator('.dock-drawer .sa-chat .msg.user .bubble.user-bubble').count()) > 0
    && (await page.locator('.dock-drawer .sa-chat .msg.assistant .bubble.ai-bubble').count()) > 0);
  check('抽屉里没有任何修改入口(只读回看)', !(await page.locator('.dock-drawer button').allInnerTexts()).some((t) => /删除|停止|重跑|编辑/.test(t)));

  // 留一张截图作为证据
  mkdirSync(path.resolve('output/playwright'), { recursive: true });
  await page.screenshot({ path: path.resolve('output/playwright/subagent-panel.png') });
  console.log('  截图:output/playwright/subagent-panel.png');

  // 抽屉是 .24s 的位移过渡:等它停稳再量几何,否则量到的是动画中途(会误判越界)
  await page.waitForTimeout(450);

  // 布局体检(产品 UI:抽屉贴住内容区右侧、两栏都真的占位、不横向溢出)
  const box = await page.locator('.dock-drawer').first().boundingBox();
  const fit = await page.locator('.dock-drawer').first().evaluate((el) => {
    const host = el.parentElement.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { right: Math.round(r.right), hostRight: Math.round(host.right), docW: document.documentElement.clientWidth };
  });
  check('抽屉贴住对话区右侧且不超出文档宽度',
    Math.abs(fit.right - fit.hostRight) <= 2 && fit.right <= fit.docW + 2, JSON.stringify(fit));
  check('抽屉宽度落在两栏可用的区间(600-900px)', !!box && box.width >= 600 && box.width <= 900, String(box?.width));
  const listBox = await page.locator('.sa-list').first().boundingBox();
  const detailBox = await page.locator('.sa-detail').first().boundingBox();
  check('左列表与右对话都占到了实际宽度',
    !!listBox && !!detailBox && listBox.width > 200 && detailBox.width > 300,
    JSON.stringify({ list: listBox?.width, detail: detailBox?.width }));
  const overflow = await page.locator('.dock-drawer').first().evaluate((el) => el.scrollWidth - el.clientWidth);
  check('抽屉内没有横向溢出', overflow <= 1, `溢出 ${overflow}px`);

  // Esc 收起
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  check('Esc 能收起抽屉', (await page.locator('.dock-drawer.open').count()) === 0);

  // 面板只属于 AI 对话页:切到终端标签页后整块消失,切回来再出现
  await page.locator('.tabstrip').getByText('终端', { exact: true }).first().click();
  await page.waitForTimeout(500);
  check('切到终端标签页:悬浮胶囊不显示', !(await page.locator('.dock-fab').first().isVisible()));
  check('切到终端标签页:抽屉不显示', !(await page.locator('.dock-drawer').first().isVisible()));
  await page.locator('.tabstrip').getByText('AI 编程助手', { exact: true }).first().click();
  await page.waitForTimeout(500);
  check('切回 AI 标签页:胶囊恢复', await page.locator('.dock-fab').first().isVisible());

  // 再点胶囊打开,列表仍能切到那条记录
  await fab.click();
  await page.locator('.dock-drawer.open').first().waitFor({ timeout: 8000 });
  check('胶囊能重新打开抽屉', true);

  // ---- 面板不跨对话:换一个对话后,胶囊与抽屉都不该再出现 ----
  const firstSessionTitle = await page.locator('.session-item .s-title').first().innerText();
  await page.locator('.sidebar-left').getByText('＋ 新建', { exact: true }).first().click();
  await page.waitForTimeout(800);
  check('新建对话后:悬浮胶囊不显示(该对话没有终端/子代理)',
    (await page.locator('.dock-fab').count()) === 0 || !(await page.locator('.dock-fab').first().isVisible()));
  check('新建对话后:抽屉不显示', !(await page.locator('.dock-drawer').first().isVisible()));
  await page.locator('.session-item').filter({ hasText: firstSessionTitle }).first().click();
  await page.waitForTimeout(800);
  check('切回原对话:胶囊又出现(记录属于那个对话)', await page.locator('.dock-fab').first().isVisible());
} catch (e) {
  fail++;
  console.log(`  ✗ 用例异常:${e?.message || e}`);
} finally {
  try { await browser.close(); } catch { /* 忽略 */ }
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败, ${skipped} 跳过 ====`);
process.exit(fail > 0 ? 1 : 0);
