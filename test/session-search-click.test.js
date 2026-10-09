// 任务列表「分区搜索」里点搜索结果必须真的跳转(真浏览器回归)。
//
// 曾经的 bug:搜索展开时按在会话行上,输入框先失焦 → onBlur 里当场收起搜索 →
// 过滤结果先一步换位(未命中的会话重新插回上面)/折叠,按住那一刻行就从指针下面挪走了,
// 抬起时的 click 落到别的元素(公共祖先)上,注册在会话行上的 onClick 永远不触发 ——
// 用户看到的就是「点了什么反应都没有,只有搜索框缩回去了」。
//
// 环境要求:web/dist 已构建(npm run build)+ 本机有 Chrome/Edge(或 BROWSER_PREVIEW_EXECUTABLE)。
// 缺任一项则整段跳过并算通过 —— 那是环境问题,不是代码回归。
//
// 用例按真人时序走:mousedown → 停顿 80ms → mouseup(收起/换位就发生在这段停顿里),
// 而不是 Playwright 那种瞬时 click —— 瞬时 click 恰好会掩盖这个 bug。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DATA = mkdtempSync(path.join(tmpdir(), 'sshai-search-'));
process.env.DATA_DIR = DATA;
mkdirSync(path.join(DATA, 'sessions'), { recursive: true });
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

// ---- 预置会话数据:同一本地工作区两个会话 ----
// 服务端按「用户最后发消息时间」倒序下发:A 在上、B 在下。搜索只命中 B,于是结果里只剩 B 一行;
// 搜索一收起,A 会重新插回 B 上面,行的位置立刻变 —— 正是点不中的那种局面(不依赖任何动画时序)。
const WS = mkdtempSync(path.join(tmpdir(), 'sshai-search-ws-'));
const SA = 's_srcha1', SB = 's_srchb1';
const TA = '晨会纪要待办', TB = '咖啡机保养记录';
const now = Date.now();
writeFileSync(path.join(DATA, 'sessions.json'), JSON.stringify({
  version: 1,
  active: null,
  sessions: [
    { id: SA, title: TA, connKey: 'local', createdAt: now - 60000, updatedAt: now, msgCount: 3, lastUserAt: now, localWorkspace: WS },
    { id: SB, title: TB, connKey: 'local', createdAt: now - 120000, updatedAt: now - 120000, msgCount: 3, lastUserAt: now - 120000, localWorkspace: WS }
  ]
}));
for (const id of [SA, SB]) {
  writeFileSync(path.join(DATA, 'sessions', `${id}.json`), JSON.stringify({ version: 2, ts: now, events: [] }));
}

const { chromium } = await import('playwright-core');
const { startApp } = await import('../server/index.ts');

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

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('  [页面异常]', e.message); });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });

  await page.locator('.s-panel').first().waitFor({ timeout: 20000 });
  await page.locator('.session-item').first().waitFor({ state: 'attached', timeout: 20000 });
  await page.waitForTimeout(600);

  const activeTitle = async () => {
    const row = page.locator('.session-item.active .s-title').first();
    if ((await row.count()) === 0) return '';
    return (await row.innerText()).trim();
  };
  // 真人时序点一下某行:mousedown 之后停一会儿再抬 —— 收起/换位就发生在这一段里
  const humanClick = async (locator) => {
    const box = await locator.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(80);
    await page.mouse.up();
    await page.waitForTimeout(400);
  };

  console.log('\n[一] 打开本地工作区搜索,只留命中项');
  check('搜索前两个会话都在 DOM 里', (await page.locator('.session-item').count()) === 2,
    String(await page.locator('.session-item').count()));
  await page.locator('.s-search-btn').first().click();
  const input = page.locator('.s-search-input').first();
  await input.waitFor({ timeout: 5000 });
  await input.fill(TB.slice(0, 2)); // 「咖啡」:只命中 B
  await page.waitForTimeout(300);
  check('分区搜索已展开(有 query 时)',
    (await page.locator('.s-search.open').count()) === 1 && (await input.inputValue()) === TB.slice(0, 2));
  check('命中的分组被强制展开,结果是可见的', await page.locator('.session-item').first().isVisible());
  check('结果只剩命中的那一条', (await page.locator('.session-item').count()) === 1,
    String(await page.locator('.session-item').count()));
  check('命中的正是目标会话', (await page.locator('.session-item').first().innerText()).includes(TB));

  console.log('\n[二] 点搜索结果:要真的切过去');
  await humanClick(page.locator('.session-item').first());
  const after = await activeTitle();
  check('点击后目标会话成为当前会话(真的跳转了)', after.includes(TB), after || '(没有任何会话被激活)');
  check('点击后搜索框照常收起', (await page.locator('.s-search.open').count()) === 0);
  check('搜索框已清空(收起即复位)', (await input.inputValue()) === '');

  // 第二轮刻意点「不是当前会话」的那一个:否则点在已经激活的会话上,断言会因为
  // 「本来就在这儿」而假通过,bug 也就漏过去了
  console.log('\n[三] 换个会话再点一次:不是一次性的');
  const cur = await activeTitle();
  const target = cur.includes(TB) ? TA : TB;
  await page.locator('.s-search-btn').first().click();
  await input.waitFor({ timeout: 5000 });
  await input.fill(target.slice(0, 2)); // 「晨会」或「咖啡」:只命中目标那一条
  await page.waitForTimeout(300);
  check('第二次搜索同样只剩命中项', (await page.locator('.session-item').count()) === 1,
    String(await page.locator('.session-item').count()));
  await humanClick(page.locator('.session-item').first());
  const back = await activeTitle();
  check(`第二次点击也真的跳到了「${target}」`, back.includes(target), back || '(没有任何会话被激活)');

  console.log('\n[四] 搜索展开时,行内既有交互没被带坏');
  // 挡掉的是「按下时把焦点挪走」这一个默认动作,不该影响行内按钮自己的 click —— 这里一并守住
  await page.locator('.s-search-btn').first().click();
  await input.waitFor({ timeout: 5000 });
  await input.fill(TB.slice(0, 2));
  await page.waitForTimeout(250);
  await page.locator('.session-item').first().locator('.s-more').click();
  await page.waitForTimeout(250);
  check('搜索展开时点行尾「⋮」仍弹出菜单', (await page.locator('.ctxmenu').count()) === 1,
    String(await page.locator('.ctxmenu').count()));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('Escape 关掉菜单', (await page.locator('.ctxmenu').count()) === 0);
  check('Escape 同时收起搜索(既有语义:输入框自己也接 Esc)', (await page.locator('.s-search.open').count()) === 0);

  console.log('\n[五] 没有搜索时,老路径照旧');
  const t2 = (await activeTitle()).includes(TB) ? TA : TB;
  await page.locator('.session-item').filter({ hasText: t2 }).first().click();
  await page.waitForTimeout(400);
  const afterPlain = await activeTitle();
  check('普通点击(无搜索)照样切会话', afterPlain.includes(t2), afterPlain || '(没有激活会话)');
  await page.locator('.s-group-header').first().click();
  await page.waitForTimeout(400);
  check('分组头点击仍能折叠', (await page.locator('.s-group-body-wrap.open').count()) === 0,
    String(await page.locator('.s-group-body-wrap.open').count()));
  await page.locator('.s-group-header').first().click();
  await page.waitForTimeout(400);
  check('再点一次仍能展开', (await page.locator('.s-group-body-wrap.open').count()) >= 1);

  console.log('\n[六] 没有 JS 异常');
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
