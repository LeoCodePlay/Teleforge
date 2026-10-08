// 子智能体 UI 冒烟(真浏览器):派发子智能体 → 会话头部出现 catalog 入口 → 点卡片「查看会话」
// 在主对话区打开这个子智能体会话(面包屑 + 只读输入位),行尾按钮则送进右侧栏。
//
// 断言的是**与 deepseek-harness 对齐的形态**:
//   - 入口在会话头部动作区(不是对话区悬浮胶囊、不是右侧大抽屉);
//   - catalog 弹层宽 336px(ui-subagent 的 SubagentHeaderLineage.module.css 原值);
//   - 进了子会话后,根会话的 count 入口让位给面包屑里的切换器(与 dsh 的 lineage 槽一致);
//   - 子会话的输入位是**正常输入框**(默认派发的是可继续的 continuable 子代理):
//     能发后续消息、能暂停当前这一轮 —— 只有一次性子代理才换成只读说明框。
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

  // 展开:外层是"回合折叠行",内层是"过程组组头"(dsh 的两层结构)。
  // 点开外层 → 出现组头(「已读取文件…」),工具行还在组头下面收着;
  // 点开组头 → 工具行可见,组体是 dsh 的滚动区(min(400px,50vh) + 上下渐隐)。
  await fold.click();
  await page.waitForTimeout(500);
  check('展开后折叠行标记为已展开', (await fold.getAttribute('aria-expanded')) === 'true');
  const groupHead = page.locator('[data-process-title]').first();
  await groupHead.waitFor({ timeout: 10000 });
  check('展开外层后出现过程组组头(一段工具活动一个组头)', await groupHead.isVisible());
  check('组头文案是「已…」这类活动账', /^已/.test((await groupHead.innerText()).trim()), (await groupHead.innerText()).trim());
  check('组头收起时工具行仍不可见(要再点一次组头)',
    !(await page.locator('[data-tool="subagent"]').first().isVisible()));
  await groupHead.click();
  await page.waitForTimeout(400);
  check('展开组头后工具行可见', await page.locator('[data-tool="subagent"]').first().isVisible());
  check('组头标记为已展开', (await groupHead.getAttribute('aria-expanded')) === 'true');
  // 组体是 dsh 的滚动区:限高 min(400px,50vh) + overflow auto(与 dsh 的 .body 一致)。
  // 注意:这是**内层**组体的规则;外层回合折叠展开后不限高(dsh 的 uncapped)。
  const bodyFit = await page.locator('[data-process-body]').first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { overflowY: s.overflowY, maxH: s.maxHeight, scrollable: el.scrollHeight - el.clientHeight };
  });
  check('组体是滚动区(overflow-y: auto,dsh 的 .body)', bodyFit.overflowY === 'auto', JSON.stringify(bodyFit));
  check('组体限高是 dsh 的 min(400px,50vh)', bodyFit.maxH !== 'none' && /px$/.test(bodyFit.maxH), bodyFit.maxH);
  check('内容不满一屏时不被截断(scrollHeight ≈ clientHeight)', bodyFit.scrollable <= 2, String(bodyFit.scrollable));

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
  // 输入卡落位也一起量:子会话用的是同一个组件,落位必须与父会话一致(不是"再适配一次")
  const mainComposerBox = await page.locator('.agent-slot:not(.hide) .composer-box').first()
    .evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; });

  // ---- 卡片行尾「查看会话」→ 在主对话区打开子智能体会话(dsh 的 openChild)----
  const openBtn = card.locator('.dsh-rowAction').first();
  // runId 随 tool/result 到达,入口按钮随后才出现(运行中先看头部入口)
  await openBtn.waitFor({ timeout: 25000 });
  check('卡片上有「查看会话」入口', (await openBtn.count()) > 0);
  await openBtn.click();
  // 子会话现在就是**父会话那套 ChatPanel**(同一组件、同一套对话系统),只是 sid 是派发记录 id
  const view = page.locator('.subagent-pane').first();
  await view.waitFor({ timeout: 15000 });
  check('主对话区打开了子智能体会话(同一个 ChatPanel)', await view.isVisible());
  check('子会话用的是父会话的对话组件(.chatwrap + 回合折叠行)',
    (await view.locator(':scope > .chatwrap').count()) === 1
    && (await view.locator('[data-turn-process]').count()) >= 1,
    String(await view.locator('[data-turn-process]').count()));

  // 面包屑:进了子会话,根会话的 count 入口让位给标题切换器(与 dsh 的 lineage 槽一致)
  const switcher = page.locator('[data-subagent-catalog="switcher"]').first();
  await switcher.waitFor({ timeout: 10000 });
  check('会话头部出现子智能体切换器(面包屑)', await switcher.isVisible());
  check('进了子会话后,根会话的 catalog 入口不再出现',
    (await page.locator('[data-subagent-catalog="count"]').count()) === 0);
  check('面包屑里有回父会话的入口', (await page.locator('[data-session-crumb]').count()) === 1);

  // 详情区照搬正常对话(dsh 的**两层**折叠):先点回合折叠行 → 出现过程组组头;
  // 再点组头 → 工具行(主对话同款 .dsh-tooltree)才可见。子会话与父会话同一套交互。
  await view.locator('[data-turn-process]').first().click();
  await view.locator('[data-process-title]').first().waitFor({ timeout: 15000 });
  check('子会话里同样是两层折叠(回合折叠行下还有过程组组头)',
    (await view.locator('[data-process-title]').count()) >= 1);
  await view.locator('[data-process-title]').first().click();
  await view.locator('.dsh-tooltree').first().waitFor({ timeout: 15000 });
  // 可能是多次派发:等「这次」的结论真的渲染出来再读文本,避免读到中间态/别的记录
  await view.getByText('结论:目录可读').first().waitFor({ timeout: 25000 });
  await page.waitForTimeout(400);
  const viewText = await view.innerText();
  check('对话首条是父对话生成的任务与边界', viewText.includes('任务目标') && viewText.includes('边界(必须遵守)'), viewText.slice(0, 200));
  check('对话里有子代理的真实工具调用(主对话同款工具行)',
    (await view.locator('[data-tool="get_local_info"]').count()) > 0);
  check('对话里有子代理的结论', viewText.includes('结论:目录可读'), viewText.slice(-120));  check('详情区用正常对话样式(用户气泡 + 助手气泡)',
    (await view.locator('.msg.user .bubble.user-bubble').count()) > 0
    && (await view.locator('.msg.assistant .bubble.ai-bubble').count()) > 0);
  // 输入位:与父会话同一个输入卡(可继续的子代理保留默认 composer —— dsh 同语义)
  const composer = view.locator('.composer-box').first();
  check('子会话的输入位就是父会话那个输入卡(可继续发消息)', await composer.isVisible());
  check('子会话里没有只读说明框(它不是一次性子代理)',
    (await view.locator('[data-subagent-readonly]').count()) === 0);
  const composerInput = composer.locator('textarea').first();
  check('输入框可打字(不是禁用状态)', await composerInput.isEnabled());
  check('父会话专属控件已收起(工作区 chip / 权限选择 / 附件 / 模型菜单)',
    (await view.locator('.ws-chip').count()) === 0
    && (await view.locator('.composer-add').count()) === 0
    && (await view.locator('.wsbar-row .tb-model').innerText()).includes('继承父会话'),
    (await view.locator('.wsbar-row').innerText()).slice(0, 80));
  check('看子会话时主会话输入框已隐藏', !(await page.locator('.agent-slot.hide textarea').first().isVisible()));

  // ---- 布局体检:头部是 dsh 的那条带;子会话正文与主对话同一条中轴 ----
  const headStyle = await page.locator('[data-session-header]').first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { pad: s.padding, borderB: s.borderBottomWidth, h: Math.round(el.getBoundingClientRect().height) };
  });
  check('会话头部内边距是 dsh 的 10px 28px 10px 20px', headStyle.pad === '10px 28px 10px 20px', JSON.stringify(headStyle));
  check('会话头部下方有一条分隔线', parseFloat(headStyle.borderB) > 0, headStyle.borderB);
  check('会话头部高度约 50px(dsh 无视图 tab 条时的高度)', headStyle.h >= 48 && headStyle.h <= 54, String(headStyle.h));

  const subCol = await view.locator(':scope > .chatwrap').first().evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; });
  const subMsgBox = await view.locator('.msg').first()
    .evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; });
  check('子会话正文列与主对话同一中轴(同宽同 x)',
    subCol.x === mainCol.x && subCol.w === mainCol.w, JSON.stringify({ subCol, mainCol }));
  check('子会话消息列与主对话消息列同宽同 x',
    subMsgBox.x === mainMsgBox.x && subMsgBox.w === mainMsgBox.w, JSON.stringify({ subMsgBox, mainMsgBox }));
  // 输入卡与父会话同一落位(同一个 ChatPanel,不需要单独调样式)
  const roBox = await composer.boundingBox();
  const boxDx = roBox ? Math.abs(roBox.x - mainComposerBox.x) : -1;
  const boxDw = roBox ? Math.abs(roBox.width - mainComposerBox.w) : -1;
  check('子会话输入位与父会话同一落位(同一组件,无需单独适配)',
    !!roBox && boxDx <= 2 && boxDw <= 2,
    JSON.stringify({ dx: boxDx, dw: boxDw, child: roBox, main: mainComposerBox }));
  // 面包屑不能把标题画两遍(dsh 里子会话那一节交给 lineage 槽,只出现一次)
  const headerText = await page.locator('[data-session-header]').first().innerText();
  check('面包屑里子智能体标题只出现一次',
    (headerText.match(/看工作区目录/g) || []).length === 1, headerText.replace(/\n/g, ' | '));

  // ---- 续聊 + 切走切回 + 暂停:默认派发的子代理是常驻的(可继续/可暂停)----
  // 用的是父会话同一个输入卡与同一个「停止」按钮:.send-btn.stop → stop_agent{ sid } → 子代理暂停
  // 运行态必须来自服务端快照(busySessions 里带子代理):**切走再切回**时,运行中的状态行与暂停
  // 按钮都得还在 —— 否则会像用户报的那样"没有运行中的状态、也没法暂停,内容却在默默往外流"。
  console.log('\n[子会话续聊 + 切走切回 + 暂停]');
  {
    // 把 mock 模型卡在闸门上,让这一轮稳定停在"运行中",才能可靠地做切走/切回。
    // 注意要改**原型**:子代理用的是它自己那份 LlmClient 实例,改 agent.llm.chat 拦不住它。
    const { agent } = await import('../server/agent/agent.ts');
    const proto = Object.getPrototypeOf(agent.llm);
    const realChat = proto.chat;
    let release = () => {};
    const gate = new Promise((r) => { release = r; });
    proto.chat = async function (o) { await gate; return realChat.call(this, o); };
    try {
      await composerInput.fill('再补一句证据');
      await composerInput.press('Enter');
      await view.locator('.send-btn.stop').first().waitFor({ timeout: 15000 });
      check('子代理跑起来时出现父会话同款「停止」按钮(= 暂停当前这一轮)', true, '');
      await view.getByText('再补一句证据').first().waitFor({ timeout: 15000 });
      check('子会话里能看到人类发出的后续消息(subagent_prompt 链路通)', true);

      // 切到父会话再切回来(用户报的场景)
      await page.locator('[data-session-crumb]').first().click();
      await page.waitForTimeout(400);
      check('切走:子会话视图关闭、回到主会话', (await page.locator('.subagent-pane').count()) === 0);
      await page.locator('[data-subagent-catalog="count"]').first().click();
      await page.locator('[data-subagent-menu]').first().waitFor({ timeout: 8000 });
      await page.locator('[data-subagent-row]').first().click();
      await page.locator('.subagent-pane').first().waitFor({ timeout: 10000 });
      await page.waitForTimeout(300);
      check('切回子会话:运行中的状态行回来了(不是静默输出)',
        (await page.locator('.subagent-pane .running-row').count()) > 0);
      check('切回子会话:暂停按钮还在(随时可以打断)',
        (await page.locator('.subagent-pane .send-btn.stop').count()) > 0);
      // 末条回复还在流式:它不该提前长出收尾产物(分支/复制那一排)
      const lastAssistantHasBranch = await page.evaluate(() => {
        const msgs = [...document.querySelectorAll('.subagent-pane .msg.assistant')];
        const last = msgs[msgs.length - 1];
        return last ? !!last.querySelector('[aria-label="在新对话中分支"]') : null;
      });
      check('切回子会话:末条回复仍按流式渲染(收尾产物没提前冒出来)',
        lastAssistantHasBranch === false, String(lastAssistantHasBranch));
    } finally {
      release();
      proto.chat = realChat;
    }
    // 跑完后回到空闲(按钮从「停止」变回「发送」),而不是终局
    await page.waitForFunction(
      () => { const el = document.querySelector('.subagent-pane .composer-box .send-btn'); return !!el && !el.classList.contains('stop'); },
      null, { timeout: 20000 },
    );
    check('跑完回到可继续状态(还能再发消息)', await composerInput.isEnabled());
    check('子会话里多了第二个回合(工具行 + 折叠行都走同一套渲染)',
      (await view.locator('[data-turn-process]').count()) >= 2, String(await view.locator('[data-turn-process]').count()));
  }

  // 留一张截图作为证据
  mkdirSync(path.resolve('output/playwright'), { recursive: true });
  await page.screenshot({ path: path.resolve('output/playwright/subagent-panel.png') });
  console.log('  截图:output/playwright/subagent-panel.png');

  // ---- 回主会话:点面包屑里父会话那一节 ----
  await page.locator('[data-session-crumb]').first().click();
  await page.waitForTimeout(500);
  check('点父会话面包屑回到主会话', (await page.locator('.subagent-pane').count()) === 0);
  check('回主会话后 catalog 入口恢复', await page.locator('[data-subagent-catalog="count"]').first().isVisible());
  check('回主会话后输入框可用', await page.locator('.agent-slot:not(.hide) .chatwrap textarea').first().isVisible());

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
  check('行上有「可继续」模式标记(默认派发的是 continuable 子代理)', rowText.includes('可继续'), rowText);
  // 跑完的那一轮是正常完成的 → 行显示「已完成」(dsh 的 activity.completed),而不是「当前未运行」
  check('跑完的子代理行显示「已完成」而不是「当前未运行」',
    rowText.includes('已完成') && !rowText.includes('当前未运行'), rowText.replace(/\n/g, ' | '));
  // 活跃时长:只算真正在跑的回合 —— 停住之后**不会**自己涨(用户报的 bug)
  const dur1 = (await row.locator('[data-tip*="总活跃耗时"]').first().innerText()).trim();
  await page.waitForTimeout(2600);
  const dur2 = (await page.locator('[data-subagent-row]').first().locator('[data-tip*="总活跃耗时"]').first().innerText()).trim();
  check('子智能体没在跑时,执行时长定住不涨(不再按 wall-clock 递增)', dur1 === dur2, `${dur1} → ${dur2}`);
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
  await page.locator('.subagent-pane').first().waitFor({ timeout: 10000 });
  check('点 catalog 一行在主对话区打开子智能体',
    (await page.locator('.subagent-pane').count()) === 1);
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

  // ---- 行尾按钮:与行点击同一条路(产品决定见 docs/task-session-topbar-dsh-parity.md:
  //      「子智能体走侧栏的那条路不该再进侧栏」)——不出现右侧栏,也不重复开一份 ----
  console.log('\n[子智能体行尾按钮]');
  await page.locator('[data-subagent-catalog="count"]').first().click();
  await page.locator('[data-subagent-menu]').first().waitFor({ timeout: 8000 });
  const asideBtn = page.locator('[data-subagent-aside]').first();
  await asideBtn.waitFor({ timeout: 20000 });
  check('catalog 行尾有第二个入口', await asideBtn.isVisible());

  await asideBtn.click();
  await page.waitForTimeout(400);
  check('行尾按钮同样在主对话区打开子会话(不开右侧栏)',
    (await page.locator('.subagent-pane').count()) === 1
    && !(await page.locator('.sidebar-right').first().isVisible()));
  // 打开的是同一份对话:任务/边界 + 工具行 + 结论 + 父会话那一个输入卡
  const pane = page.locator('.subagent-pane').first();
  const paneText = await pane.innerText();
  check('打开的是同一个子会话(任务与边界)', paneText.includes('任务目标') && paneText.includes('边界(必须遵守)'), paneText.slice(0, 160));
  check('对话里有子代理的工具行与结论',
    (await pane.locator('[data-tool="get_local_info"]').count()) > 0 && paneText.includes('结论:目录可读'), paneText.slice(-120));
  check('输入卡是父会话那一个(可继续发消息)', (await pane.locator('.composer-box textarea').count()) === 1);

  // ---- 子会话里「在新对话中分支」:把这个子智能体当成一个新的父对话克隆 ----
  // dsh: 分支动作作用于"当前正在看的那个会话"(`ui-chat/apply.ts` 的 forkAt → sessions.fork({sessionId})),
  // 子代理视图里 sessionId 就是子代理;产出的是 seed 了那份日志的普通会话。所以这里断言:
  // 分支按钮在子会话里可用 → 点击后退出子会话视图 → 主对话区是一条**普通的新会话**,
  // 内容来自子代理自己的对话(任务/工具/结论都在),父子会话都还在列表里。
  console.log('\n[子会话里分支 = 把子智能体当成新的父对话]');
  {
    const branch = pane.locator('[aria-label="在新对话中分支"]').first();
    await branch.waitFor({ timeout: 15000 });
    check('子会话里能找到「在新对话中分支」(与父会话同一个操作栏)', await branch.isVisible());
    const sessionsBefore = await page.locator('.session-item').count();
    await branch.click();
    // 分支成功后会退出子会话视图(新会话是普通会话,在主对话区打开)
    await page.waitForFunction(() => document.querySelectorAll('.subagent-pane').length === 0, null, { timeout: 15000 });
    check('分支后退出子会话视图(新会话在主对话区)', (await page.locator('.subagent-pane').count()) === 0);
    await page.waitForTimeout(600);
    const sessionsAfter = await page.locator('.session-item').count();
    check('会话列表里多出一条分支会话', sessionsAfter === sessionsBefore + 1, `${sessionsBefore} → ${sessionsAfter}`);
    check('新会话标题带(分支)', (await page.locator('.session-item .s-title').first().innerText()).includes('(分支)'),
      await page.locator('.session-item .s-title').first().innerText());
    const mainWrap = page.locator('.agent-slot:not(.hide) .chatwrap').first();
    const mainText = await mainWrap.innerText();
    check('新会话带着子代理那一段对话(任务与边界)',
      mainText.includes('任务目标') && mainText.includes('边界(必须遵守)'), mainText.slice(0, 160));
    check('新会话里子代理的结论也在', mainText.includes('结论:目录可读'), mainText.slice(-120));
    check('新会话是普通父会话(父会话专属控件回来了:工作区 chip / 附件按钮)',
      (await page.locator('.agent-slot:not(.hide) .composer-add').count()) > 0
      && (await page.locator('.agent-slot:not(.hide) .ws-chip').count()) > 0,
      JSON.stringify({
        add: await page.locator('.agent-slot:not(.hide) .composer-add').count(),
        chip: await page.locator('.agent-slot:not(.hide) .ws-chip').count()
      }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 用例异常:${e?.message || e}`);
} finally {
  try { await browser.close(); } catch { /* 忽略 */ }
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败, ${skipped} 跳过 ====`);
process.exit(fail > 0 ? 1 : 0);
