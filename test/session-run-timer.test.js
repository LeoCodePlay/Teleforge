// 多会话并行时「Agent 正在运行 X…」的计时必须**各算各的**(真浏览器)。
//
// 复现的就是用户报的那条:两个对话同时运行,切换会话后两个会话后面跟着**同一个**已跑时长。
// 根因:切会话那一帧视图里还挂着**上一个会话**的 messages(新会话历史是异步回载的),
// 旧逻辑把它当成本会话本轮起点,而此后只肯把起点往早里调 —— 于是从"先跑起来的 A"切到
// "后跑起来的 B"时,A 的起点被永久留下,B 一路显示 A 的时长。
//
// 断言的是可见结果(状态行里的秒数),不是实现:
//   1) 从 A 切到 B 后,B 的秒数明显小于 A 的(不是同一个数);
//   2) 切回 A 后,A 的秒数只增不减(A 自己的账没被 B 覆盖、也没被清零);
//   3) 同一时刻两个会话的秒数差 ≈ 两者开跑的时间差。
//
// 环境要求:web/dist 已构建(npm run build)+ 本机有 Chrome/Edge(或 BROWSER_PREVIEW_EXECUTABLE)。
// 缺任一项则整段跳过并算通过 —— 那是环境问题,不是代码回归。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 预置:mock 模型(无需 API Key)+ 完全访问(免审批)+ 选中 mock 提供方
const DATA = mkdtempSync(path.join(tmpdir(), 'sshai-run-timer-'));
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

const WORK_WS = mkdtempSync(path.join(tmpdir(), 'sshai-run-timer-ws-'));

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

/** 状态行文案 → 秒数(「Agent 正在运行 1分3秒…」/「…12秒…」) */
function secondsOf(text) {
  const m = /(?:(\d+)分)?(\d+)秒/.exec(text || '');
  return m ? Number(m[1] || 0) * 60 + Number(m[2]) : null;
}

let app = null;
try {
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
  await page.waitForTimeout(1200); // 等前端把 mock 模型下发到服务端

  // 把 mock 模型卡在闸门上:两轮都停在"运行中",计时才有时间差可比
  const { agent } = await import('../server/agent/agent.ts');
  const proto = Object.getPrototypeOf(agent.llm);
  const realChat = proto.chat;
  let release = () => {};
  const gate = new Promise((r) => { release = r; });
  proto.chat = async function (o) { await gate; return realChat.call(this, o); };

  const runningRow = page.locator('.agent-slot:not(.hide) .running-text').first();
  const itemByText = (t) => page.locator('.s-panel .session-item').filter({ hasText: t }).first();
  /** 读当前视图状态行里的秒数(取两次间隔 1.2s 的读数,以后一次为准:等历史回载与刻度都落定) */
  const readSec = async (label) => {
    await runningRow.waitFor({ timeout: 15000 });
    const first = (await runningRow.innerText()).trim();
    await page.waitForTimeout(1300);
    const text = (await runningRow.innerText()).trim();
    const sec = secondsOf(text);
    console.log(`  · ${label}:「${first}」→「${text}」= ${sec}s`);
    return sec;
  };

  console.log('\n[两个会话同时运行:切会话后各算各的账]');
  try {
    // A 先跑起来(草稿会话第一条消息 = 创建会话 A)
    await input.fill('会话甲:先跑起来');
    await input.press('Enter');
    await runningRow.waitFor({ timeout: 20000 });
    const aItem = itemByText('会话甲');
    await aItem.waitFor({ timeout: 15000 });
    const aSec0 = await readSec('A 刚开跑');

    // 让 A 跑一段(这段时长后面必须能在切换后认出来)
    await page.waitForTimeout(5000);

    // 新建草稿 → 发送 = 创建会话 B(A 在后台继续跑)
    await page.locator('.s-panel .panel-title button.sm').first().click();
    await page.waitForTimeout(400);
    await input.fill('会话乙:后跑起来');
    await input.press('Enter');
    await runningRow.waitFor({ timeout: 20000 });
    const bSec0 = await readSec('B 刚开跑');

    // 切到 A(先跑的那个):A 的时长必须已经明显更长
    await itemByText('会话甲').click();
    const aSec1 = await readSec('切回 A');
    check('A 的时长随自己跑的时间增长(不是从 0 重新起算)',
      aSec1 !== null && aSec1 >= aSec0 + 4, `A: ${aSec0}s → ${aSec1}s`);
    check('两个会话同时运行时,A 的时长明显大于 B',
      aSec0 !== null && bSec0 !== null && aSec1 > bSec0 + 3, `A=${aSec1}s B=${bSec0}s`);

    // 关键回归点:从 A(先开跑)切到 B(后开跑)——B 不能被 A 的起点钉死
    await itemByText('会话乙').click();
    const bSec1 = await readSec('切到 B(回归点)');
    check('切到后开跑的 B:B 的时长明显小于 A(不是同一个数)',
      bSec1 !== null && bSec1 + 3 <= aSec1, `A=${aSec1}s B=${bSec1}s`);
    check('切到 B 后 B 的时长没有跳到 A 的水平(没被上个会话的起点污染)',
      bSec1 !== null && Math.abs(bSec1 - aSec1) > 3, `A=${aSec1}s B=${bSec1}s`);

    // 切回 A:A 的账没被 B 覆盖,也不该清零
    await itemByText('会话甲').click();
    const aSec2 = await readSec('再切回 A');
    check('切回 A 后 A 的时长继续往前走(没被 B 的时长覆盖、也没清零)',
      aSec2 !== null && aSec2 >= aSec1, `A: ${aSec1}s → ${aSec2}s`);

    // 两个会话的时长差 ≈ 两者开跑的时间差(约 5s,这里只要求方向正确且拉开)
    check('两个会话的时长互不相等且差值合理',
      aSec2 !== null && bSec1 !== null && aSec2 >= bSec1 + 4, `A=${aSec2}s B=${bSec1}s`);
  } finally {
    release();
    proto.chat = realChat;
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 用例异常:${e?.message || e}`);
} finally {
  try { await browser.close(); } catch { /* 忽略 */ }
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败, ${skipped} 跳过 ====`);
process.exit(fail > 0 ? 1 : 0);
