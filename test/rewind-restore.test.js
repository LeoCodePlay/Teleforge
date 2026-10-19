// 「回到本轮对话发起前」的两条回归(真浏览器;都是用户上报的现场):
//
//   1) 粘贴的图片没有回到输入框:发消息时图片随消息上行(气泡里正常显示),点回退后消息被移除,
//      输入框只回填了文字,@引用也回了,唯独**附件没回**——用户想改一改再发,却得重新粘一次图。
//      修法:回退时把该条消息的附件按服务端 id 一并还原到输入框上方的草稿轨道(不必重新上传)。
//
//   2) 只有一个任务对话时,回退把它截断成空,内容回到输入框;一切换会话,这条会话从任务列表里
//      **消失了**(连列表行都没了)——草稿按会话 id 存着,却再也点不回去继续发。
//      修法:任务列表的可见性规则放行"曾经有过用户消息"的会话(见 web/src/utils/sessionVisibility.ts)。
//
// 断言的是用户看到的结果,不是实现:
//   a) 回退后消息气泡消失、输入框文字回来了、**草稿轨道上又出现了那张图**(带缩略图);
//   b) 切到另一个会话后,被回退成空的会话仍在任务列表里,点它还能回到自己的草稿。
//
// 环境要求:web/dist 已构建(npm run build)+ 本机有 Chrome/Edge(或 BROWSER_PREVIEW_EXECUTABLE)。
// 缺任一项则整段跳过并算通过 —— 那是环境问题,不是代码回归。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 预置:mock 模型(正常轮次立即回,且标了多模态 —— 否则图片入口会被闸门拦住)、
// 完全访问(免审批)、选中 mock 提供方
const DATA = mkdtempSync(path.join(tmpdir(), 'sshai-rewind-'));
process.env.DATA_DIR = DATA;
mkdirSync(DATA, { recursive: true });
writeFileSync(path.join(DATA, 'ai-providers.json'), JSON.stringify([
  { id: 'u_mock', name: 'Mock', baseUrl: 'http://mock', models: ['mock'], apiKey: '', modelConfig: { mock: { multimodal: true } } }
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

const WORK_WS = mkdtempSync(path.join(tmpdir(), 'sshai-rewind-ws-'));

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
  const rpcCall = (payload, expectReqId = 'rpc') => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const t = setTimeout(() => { ws.close(); reject(new Error(`RPC 超时:${payload.type}`)); }, 15000);
    ws.on('open', () => ws.send(JSON.stringify({ ...payload, reqId: expectReqId })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.reqId === expectReqId) { clearTimeout(t); ws.close(); resolve(m); }
    });
    ws.on('error', reject);
  });

  // 前置:设好本地工作区(前端 canSend 需要 workspace 或 localWorkspace)
  await rpcCall({ type: 'set_local_workspace', path: WORK_WS }, 'ws');

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [页面异常]', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });

  const input = page.locator('textarea').first();
  await input.waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200); // 等前端把 mock 模型下发到服务端

  const { agent } = await import('../server/agent/agent.ts');
  const sessionItem = (t) => page.locator('.s-panel .session-item').filter({ hasText: t }).first();
  const railItem = page.locator('.att-rail .att-item');
  const rewindBtn = page.getByLabel('回到本轮对话发起前').first();
  /** 等当前活跃会话这一轮跑完(回退要求会话空闲,否则服务端会拒绝) */
  const waitIdle = async () => {
    for (let i = 0; i < 200; i++) {
      const rt = agent._runtimes.get(String(agent.sessionId));
      if (!rt || !rt.busy) return true;
      await page.waitForTimeout(200);
    }
    return false;
  };
  /** 点「回到本轮对话发起前」并确认(失败时把页面上的提示带出来,便于定位) */
  const doRewind = async () => {
    await page.locator('.msg.user').first().hover();
    await rewindBtn.click();
    await page.locator('.confirm-modal button.danger').click();
    try {
      await page.locator('.msg.user').first().waitFor({ state: 'detached', timeout: 15000 });
    } catch {
      const toasts = await page.locator('.toast-content').allInnerTexts().catch(() => []);
      throw new Error(`回退后消息没消失(页面提示:${JSON.stringify(toasts)})`);
    }
  };

  console.log('\n[粘贴图片 → 发送 → 回到消息发送前:图片必须回到输入框]');
  // 粘贴一张图(等价于用户 Ctrl+V:直接给 textarea 派发带文件的 paste 事件)
  await page.evaluate(async () => {
    const res = await fetch('/logo-256.png');
    const buf = await res.arrayBuffer();
    const file = new File([buf], '粘贴图片.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ta = document.querySelector('textarea');
    ta.focus();
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await railItem.first().waitFor({ timeout: 15000 }); // 附件已进草稿轨道(上传中→完成)
  await page.waitForTimeout(800);
  check('粘贴的图片进了草稿轨道', await railItem.count() === 1, `实际 ${await railItem.count()} 项`);

  await input.fill('第一条消息');
  await input.press('Enter');
  // 消息随附件上行:用户气泡里出现图片,且服务端建了会话(任务列表出现该会话行)
  await page.locator('.msg.user .msg-att img').first().waitFor({ timeout: 20000 });
  await sessionItem('第一条消息').waitFor({ timeout: 20000 });
  check('发送后:消息气泡里带着图片', await page.locator('.msg.user .msg-att img').count() === 1);
  check('发送后:草稿轨道已清空(附件随消息上行)', await railItem.count() === 0);
  check('发送后:这一轮跑完(回退要求会话空闲)', await waitIdle());

  // 点「回到本轮对话发起前」并确认
  await doRewind();
  await page.waitForTimeout(400);

  check('回退后:对话里的用户消息已移除', await page.locator('.msg.user').count() === 0);
  check('回退后:文字回填到输入框', (await input.inputValue()) === '第一条消息', await input.inputValue());
  check('回退后:粘贴的图片回到草稿轨道', await railItem.count() === 1, `实际 ${await railItem.count()} 项`);
  check('回退后:轨道上那张图有缩略图(服务端附件地址)', await page.locator('.att-rail .att-item img').count() === 1);
  check('回退后:轨道项不是"上传中"状态', await page.locator('.att-rail .att-spin').count() === 0);

  // 回退的附件必须能再次发出去(元数据是服务端 id,不需要重新上传)
  await input.press('Enter');
  await page.locator('.msg.user .msg-att img').first().waitFor({ timeout: 20000 });
  check('再发一次:图片随消息重新发出', await page.locator('.msg.user .msg-att img').count() === 1);
  check('再发一次:这一轮跑完', await waitIdle());

  console.log('\n[只剩一条消息的会话被回退清空后,切换会话不得让它从任务列表消失]');
  // 再回退成空(回到用户上报的那一刻)
  await doRewind();
  await page.waitForTimeout(800);
  const rewound = await rpcCall({ type: 'session_list' }, 'list');
  const rowA = (rewound.sessions || []).find((s) => s.title === '第一条消息');
  check('服务端现场:该会话 msgCount 归零但 lastUserAt 仍在(可见性依据)',
    (rowA?.msgCount ?? -1) === 0 && (rowA?.lastUserAt ?? 0) > 0, JSON.stringify(rowA));

  // 新建另一个会话并发一条消息 —— 它成为服务端活跃会话,前端随之切走(等价于用户点别的会话)
  const created = await rpcCall({ type: 'session_create', title: '另一个会话' }, 'new');
  const sidB = created?.created?.id;
  await rpcCall({ type: 'speak', sid: sidB, text: '另一个会话的消息', reasoning: 'default' }, 'speak');
  for (let i = 0; i < 60; i++) {
    const rt = agent._runtimes.get(String(sidB));
    if (!rt || !rt.busy) break;
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(1000); // 等前端跟着切到新会话(服务端 active 变化 → 列表刷新 + 视图切换)

  check('切走后:被回退成空的会话仍在任务列表里', await sessionItem('第一条消息').count() === 1);
  await sessionItem('第一条消息').click();
  await page.waitForTimeout(1200);
  check('点回去:草稿(回退回填的文字)还在输入框', (await input.inputValue()) === '第一条消息', await input.inputValue());
} catch (e) {
  fail++;
  console.log(`  ✗ 用例异常:${e?.stack || e}`);
} finally {
  try { await browser.close(); } catch { /* 忽略 */ }
  try { await app?.app?.close(); } catch { /* 忽略 */ }
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败, ${skipped} 跳过 ====`);
process.exit(fail ? 1 : 0);
