// 子智能体 UI 冒烟(真浏览器):派发子智能体 → 会话头部出现 catalog 入口 → 点卡片「查看会话」
// 在主对话区打开这个子智能体会话(面包屑 + 只读输入位),行尾按钮则送进右侧栏。
//
// 断言的是**与 deepseek-harness 对齐的形态**:
//   - 入口在会话头部动作区(不是对话区悬浮胶囊、不是右侧大抽屉);
//   - catalog 弹层宽 336px(ui-subagent 的 SubagentHeaderLineage.module.css 原值);
//   - 进了子会话后,根会话的 count 入口让位给面包屑里的切换器(与 dsh 的 lineage 槽一致);
//   - 子会话的输入位是一块只读说明框(one-shot 子代理),而不是禁用输入框。
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
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });

  const input = page.locator('textarea').first();
  await input.waitFor({ timeout: 20000 });
  check('应用已加载出对话输入框', await input.isVisible());

  // 等前端把 mock 模型下发到服务端(加载 providers/ui-state 后会自动 send('llm'))
  await page.waitForTimeout(1200);

  check('还没派发时头部没有子智能体入口(整块入口不存在)',
    (await page.locator('[data-subagent-catalog]').count()) === 0
    && (await page.locator('[data-job-list]').count()) === 0);

  await input.fill('派个子代理看看工作区');
  await input.press('Enter');

  // ---- 回合过程折叠(对齐 deepseek-harness 的 TurnProcessNodeView)----
  // 回合**结束后**出现一行折叠行:「已完成,用时 X分Y秒」▾,整轮工具活动收起。
  // 这三条断言直接对应三条验收要求:文案、展开后无滚动条、折叠行无边框阴影。
  const fold = page.locator('[data-turn-process]').first();
  await fold.waitFor({ timeout: 60000 });
  check('回合结束后出现过程折叠行', await fold.isVisible());
  // 只读 .pf-label:整个按钮的 innerText 还会带上视觉隐藏的无障碍播报文本(.pf-sr),
  // 那是给屏幕阅读器的,不属于显示文案
  const foldLabel = (await fold.locator('.pf-label').innerText()).trim();
  check('折叠行文案是「已完成，用时 …」', /^已完成，用时 /.test(foldLabel), foldLabel);
  check('折叠行耗时带单位(秒)', /秒$/.test(foldLabel), foldLabel);
  check('折叠行不显示"N 个工具调用"这类计数', !/\d+\s*次?\s*工具调用/.test(foldLabel), foldLabel);
  // 折叠行样式:无边框、无阴影、无背景(用户明确要求)
  const foldStyle = await fold.evaluate((el) => {
    const s = getComputedStyle(el);
    return { bt: s.borderTopWidth, bb: s.borderBottomWidth, bs: s.boxShadow, bi: s.backgroundImage, bc: s.backgroundColor };
  });
  check('折叠行无边框', foldStyle.bt === '0px' && foldStyle.bb === '0px', JSON.stringify(foldStyle));
  check('折叠行无阴影', foldStyle.bs === 'none', foldStyle.bs);
  check('折叠行无背景', foldStyle.bi === 'none' || foldStyle.bc === 'rgba(0, 0, 0, 0)', `${foldStyle.bi} / ${foldStyle.bc}`);
  // 折叠态:工具行在 DOM 里但不可见(用 hidden 属性,不是卸载)
  check('折叠时工具行存在但不可见',
    (await page.locator('[data-tool="subagent"]').count()) >= 1
    && !(await page.locator('[data-tool="subagent"]').first().isVisible()));

  await fold.click();
  await page.waitForTimeout(500);
  check('展开后工具行可见', await page.locator('[data-tool="subagent"]').first().isVisible());
  check('展开后折叠行标记为已展开', (await fold.getAttribute('aria-expanded')) === 'true');
  // 展开必须**完整铺开**:内部不能出现滚动条(用户明确要求)
  const bodyFit = await page.locator('[data-process-body]').first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { overflowY: s.overflowY, maxH: s.maxHeight, scrollable: el.scrollHeight - el.clientHeight };
  });
  check('展开后组体不滚动(overflow 非 auto/scroll)', bodyFit.overflowY !== 'auto' && bodyFit.overflowY !== 'scroll', JSON.stringify(bodyFit));
  check('展开后没有高度上限', bodyFit.maxH === 'none', bodyFit.maxH);
  check('展开后内容未被截断(scrollHeight ≈ clientHeight)', Math.abs(bodyFit.scrollable) <= 2, String(bodyFit.scrollable));

  // 父代理 → subagent 工具卡
  const card = page.locator('[data-tool="subagent"]').first();
  await card.waitFor({ timeout: 40000 });
  check('对话里出现子智能体工具卡', await card.isVisible());
  const cardText = await card.innerText();
  check('卡片摘要显示派发任务名', cardText.includes('看工作区目录'), cardText.slice(0, 80));

  // ---- 会话头部动作区:子智能体 catalog(照搬 dsh 的 header actions,order -30)----
  const catalog = page.locator('[data-subagent-catalog="count"]').first();
  await catalog.waitFor({ timeout: 25000 });
  check('会话头部出现「N 个子智能体」入口', await catalog.isVisible());
  const catalogText = await catalog.innerText();
  check('入口文案是「N 个子智能体」', /\d+\s*个子智能体/.test(catalogText), catalogText);
  check('没有运行终端时,后台任务入口不出现', (await page.locator('[data-job-list]').count()) === 0);

  // 打开子会话**之前**先量一下主对话的正文中轴:子会话必须与它完全对齐
  // (这是「照搬 dsh」的关键可见结果 —— dsh 的 ChatView `.column` 与子会话共用
  //  ConversationRoot 的 `--dsh-chat-content-width`,两条中轴是同一个)
  const mainCol = await page.locator('.agent-slot:not(.hide) .chatwrap').first()
    .evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; });
  const mainMsgBox = await page.locator('.agent-slot:not(.hide) .chatwrap .msg').first()
    .evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; });

  // ---- 卡片行尾「查看会话」→ 在主对话区打开子智能体会话(dsh 的 openChild)----
  const openBtn = card.locator('.dsh-rowAction').first();
  // runId 随 tool/result 到达,入口按钮随后才出现(运行中先看头部入口)
  await openBtn.waitFor({ timeout: 25000 });
  check('卡片上有「查看会话」入口', (await openBtn.count()) > 0);
  await openBtn.click();
  const view = page.locator('[data-subagent-conversation]').first();
  await view.waitFor({ timeout: 15000 });
  check('主对话区打开了子智能体会话', await view.isVisible());

  // 面包屑:进了子会话,根会话的 count 入口让位给标题切换器(与 dsh 的 lineage 槽一致)
  const switcher = page.locator('[data-subagent-catalog="switcher"]').first();
  await switcher.waitFor({ timeout: 10000 });
  check('会话头部出现子智能体切换器(面包屑)', await switcher.isVisible());
  check('进了子会话后,根会话的 catalog 入口不再出现',
    (await page.locator('[data-subagent-catalog="count"]').count()) === 0);
  check('面包屑里有回父会话的入口', (await page.locator('[data-session-crumb]').count()) === 1);

  // 详情区照搬正常对话:工具调用以主对话同款工具行(.dsh-tooltree)出现
  await view.locator('.sa-chat .dsh-tooltree').first().waitFor({ timeout: 15000 });
  // 可能是多次派发:等「这次」的结论真的渲染出来再读文本,避免读到中间态/别的记录
  await view.locator('.sa-chat').getByText('结论:目录可读').first().waitFor({ timeout: 25000 });
  await page.waitForTimeout(400);
  const viewText = await view.innerText();
  check('对话首条是父对话生成的任务与边界', viewText.includes('任务目标') && viewText.includes('边界(必须遵守)'), viewText.slice(0, 200));
  check('对话里有子代理的真实工具调用(主对话同款工具行)',
    (await view.locator('.sa-chat [data-tool="get_local_info"]').count()) > 0);
  check('对话里有子代理的结论', viewText.includes('结论:目录可读'), viewText.slice(-120));
  check('不再显示步数/调用次数等过程元信息', !/\d+\s*步/.test(viewText) && !/次调用/.test(viewText), viewText.slice(-80));
  check('详情区用正常对话样式(用户气泡 + 助手气泡)',
    (await view.locator('.sa-chat .msg.user .bubble.user-bubble').count()) > 0
    && (await view.locator('.sa-chat .msg.assistant .bubble.ai-bubble').count()) > 0);
  // 输入位被只读说明框顶掉(dsh 对 one-shot 子代理的同样处理)
  const readonly = view.locator('[data-subagent-readonly]').first();
  check('子会话的输入位是只读说明框', await readonly.isVisible());
  check('只读说明文案是「一次性子智能体记录」',
    (await readonly.innerText()).includes('一次性子智能体记录'), await readonly.innerText());
  check('子会话里没有任何修改入口(只读回看)',
    !(await view.locator('button').allInnerTexts()).some((t) => /删除|停止|重跑|编辑/.test(t)));
  check('看子会话时主会话输入框已隐藏', !(await page.locator('.chatwrap textarea').first().isVisible()));

  // ---- 布局体检:头部是 dsh 的那条带;子会话正文与主对话同一条中轴 ----
  const headStyle = await page.locator('[data-session-header]').first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { pad: s.padding, borderB: s.borderBottomWidth, h: Math.round(el.getBoundingClientRect().height) };
  });
  check('会话头部内边距是 dsh 的 10px 28px 10px 20px', headStyle.pad === '10px 28px 10px 20px', JSON.stringify(headStyle));
  check('会话头部下方有一条分隔线', parseFloat(headStyle.borderB) > 0, headStyle.borderB);
  check('会话头部高度约 50px(dsh 无视图 tab 条时的高度)', headStyle.h >= 48 && headStyle.h <= 54, String(headStyle.h));

  const subCol = await view.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; });
  const subMsgBox = await view.locator('.msg').first()
    .evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; });
  check('子会话正文列与主对话同一中轴(同宽同 x)',
    subCol.x === mainCol.x && subCol.w === mainCol.w, JSON.stringify({ subCol, mainCol }));
  check('子会话消息列与主对话消息列同宽同 x',
    subMsgBox.x === mainMsgBox.x && subMsgBox.w === mainMsgBox.w, JSON.stringify({ subMsgBox, mainMsgBox }));
  // 面板内边距 24px(dsh SubagentReadOnlyComposer 的 margin: 0 24px 20px)
  const roBox = await readonly.boundingBox();
  check('只读输入位按 dsh 的 24px 内边距落位',
    !!roBox && Math.abs((roBox.x - mainCol.x) - 24) <= 1, JSON.stringify(roBox && { dx: roBox.x - mainCol.x }));
  // 面包屑不能把标题画两遍(dsh 里子会话那一节交给 lineage 槽,只出现一次)
  const headerText = await page.locator('[data-session-header]').first().innerText();
  check('面包屑里子智能体标题只出现一次',
    (headerText.match(/看工作区目录/g) || []).length === 1, headerText.replace(/\n/g, ' | '));

  // 留一张截图作为证据
  mkdirSync(path.resolve('output/playwright'), { recursive: true });
  await page.screenshot({ path: path.resolve('output/playwright/subagent-panel.png') });
  console.log('  截图:output/playwright/subagent-panel.png');

  // ---- 回主会话:点面包屑里父会话那一节 ----
  await page.locator('[data-session-crumb]').first().click();
  await page.waitForTimeout(500);
  check('点父会话面包屑回到主会话', (await page.locator('[data-subagent-conversation]').count()) === 0);
  check('回主会话后 catalog 入口恢复', await page.locator('[data-subagent-catalog="count"]').first().isVisible());
  check('回主会话后输入框可用', await page.locator('.chatwrap textarea').first().isVisible());

  // ---- catalog 弹层:336px、列出这次派发、Esc 关闭 ----
  console.log('\n[子智能体 catalog 弹层]');
  await page.locator('[data-subagent-catalog="count"]').first().click();
  const menu = page.locator('[data-subagent-menu]').first();
  await menu.waitFor({ timeout: 8000 });
  check('点 catalog 打开弹层', await menu.isVisible());
  // 等落位效果跑完再量宽度(open 那一帧才设置 fixed 定位)
  await page.waitForTimeout(150);
  const mbox = await menu.boundingBox();
  check('弹层宽度是 dsh 的 336px', !!mbox && Math.abs(mbox.width - 336) <= 2, String(mbox?.width));
  const row = page.locator('[data-subagent-row]').first();
  check('弹层里列出这次派发', await row.isVisible());
  const rowText = await row.innerText();
  check('行上有子智能体描述', rowText.includes('看工作区目录'), rowText);
  check('行上有「一次性」模式标记', rowText.includes('一次性'), rowText);
  check('行尾有「在侧边栏打开」按钮', await page.locator('[data-subagent-aside]').first().isVisible());

  // 行内左侧不留分支占位的空块;状态点必须在行高里垂直居中
  check('行里没有分支占位的空白块',
    (await page.locator('[data-subagent-menu] [class*="disclosureSpace"]').count()) === 0);
  const dotFit = await page.locator('[data-subagent-row]').first().evaluate((row) => {
    const r = (e) => { const q = e.getBoundingClientRect(); return { left: Math.round(q.left), cy: Math.round((q.top + q.height / 2) * 10) / 10 }; };
    const slot = row.querySelector('[data-subagent-activity]');
    const dot = slot && slot.firstElementChild;
    return { row: r(row), slot: slot && r(slot), dot: dot && r(dot) };
  });
  check('状态点在行高里垂直居中',
    !!dotFit.dot && Math.abs(dotFit.dot.cy - dotFit.row.cy) <= 1, JSON.stringify(dotFit));
  check('状态点紧贴行的左内边距(没有被占位块推开)',
    !!dotFit.slot && dotFit.slot.left - dotFit.row.left <= 10, JSON.stringify(dotFit));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Esc 关闭 catalog 弹层', (await page.locator('[data-subagent-menu]').count()) === 0);

  // ---- 点 catalog 里的一行 = 在主对话区打开那个子智能体 ----
  await page.locator('[data-subagent-catalog="count"]').first().click();
  await page.locator('[data-subagent-menu]').first().waitFor({ timeout: 8000 });
  await page.locator('[data-subagent-row]').first().click();
  await page.locator('[data-subagent-conversation]').first().waitFor({ timeout: 10000 });
  check('点 catalog 一行在主对话区打开子智能体',
    (await page.locator('[data-subagent-conversation]').count()) === 1);
  await page.locator('[data-session-crumb]').first().click();
  await page.waitForTimeout(400);

  // ---- 入口只在 AI 对话页出现:切到终端标签页后整块消失,切回来再出现 ----
  await page.locator('.tabstrip').getByText('终端', { exact: true }).first().click();
  await page.waitForTimeout(500);
  check('切到终端标签页:会话头部动作区不显示',
    !(await page.locator('[data-subagent-catalog="count"]').first().isVisible()));
  await page.locator('.tabstrip').getByText('AI 编程助手', { exact: true }).first().click();
  await page.waitForTimeout(500);
  check('切回 AI 标签页:会话头部动作区恢复',
    await page.locator('[data-subagent-catalog="count"]').first().isVisible());

  // ---- 入口不跨对话:换一个对话后不再出现,切回来又出现 ----
  const firstSessionTitle = await page.locator('.session-item .s-title').first().innerText();
  await page.locator('.sidebar-left').getByText('＋ 新建', { exact: true }).first().click();
  await page.waitForTimeout(800);
  check('新建对话后:头部没有子智能体入口(记录属于那个对话)',
    (await page.locator('[data-subagent-catalog]').count()) === 0);
  await page.locator('.session-item').filter({ hasText: firstSessionTitle }).first().click();
  await page.waitForTimeout(800);
  check('切回原对话:头部入口又出现', await page.locator('[data-subagent-catalog="count"]').first().isVisible());

  // ---- 子智能体会话进右侧栏(对照阅读)----
  // 放在最后:开右侧栏会压缩主区域宽度,前面的断言依赖全宽布局。
  console.log('\n[子智能体会话进右侧栏]');
  await page.locator('[data-subagent-catalog="count"]').first().click();
  await page.locator('[data-subagent-menu]').first().waitFor({ timeout: 8000 });
  const asideBtn = page.locator('[data-subagent-aside]').first();
  await asideBtn.waitFor({ timeout: 20000 });
  check('catalog 行里有「在侧边栏打开」入口', await asideBtn.isVisible());

  await asideBtn.click();
  const rsb = page.locator('.sidebar-right').first();
  await rsb.waitFor({ timeout: 10000 });
  check('右侧栏打开', await rsb.isVisible());
  check('侧栏里恰好一个子智能体标签', (await rsb.locator('[data-dockkit-tab]').count()) === 1,
    String(await rsb.locator('[data-dockkit-tab]').count()));
  // 正文用与主对话区同一份渲染层(conversation.tsx):任务/边界 + 工具行 + 结论都要在
  const rsbView = rsb.locator('[data-subagent-conversation]').first();
  await rsbView.waitFor({ timeout: 20000 });
  const rsbText = await rsbView.innerText();
  check('侧栏显示任务与边界', rsbText.includes('任务目标') && rsbText.includes('边界(必须遵守)'), rsbText.slice(0, 200));
  check('侧栏显示子代理的工具调用', (await rsbView.locator('.sa-chat [data-tool="get_local_info"]').count()) > 0);
  check('侧栏显示子代理的结论', rsbText.includes('结论:目录可读'), rsbText.slice(-160));
  check('侧栏标注了只读', rsbText.includes('一次性子智能体记录'), rsbText.slice(-160));
  check('侧栏没有任何修改入口(与主对话区同为只读回看)',
    !(await rsbView.locator('button').allInnerTexts()).some((t) => /删除|停止|重跑|编辑/.test(t)));

  // 再点一次:内容身份是 runId,不该重复开标签
  await page.locator('[data-subagent-catalog="count"]').first().click();
  await page.locator('[data-subagent-menu]').first().waitFor({ timeout: 8000 });
  await page.locator('[data-subagent-aside]').first().click();
  await page.waitForTimeout(400);
  check('再次打开同一子智能体不重复开标签', (await rsb.locator('[data-dockkit-tab]').count()) === 1,
    String(await rsb.locator('[data-dockkit-tab]').count()));
} catch (e) {
  fail++;
  console.log(`  ✗ 用例异常:${e?.message || e}`);
} finally {
  try { await browser.close(); } catch { /* 忽略 */ }
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败, ${skipped} 跳过 ====`);
process.exit(fail > 0 ? 1 : 0);
