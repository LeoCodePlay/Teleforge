// 手动 /compact 的运行态记录必须活过会话切换(真浏览器)。
//
// 复现的就是用户报的那条:在对话 B 里执行 /compact,页面显示「正在压缩当前会话上下文…」,
// 切到对话 A 再切回 B,那条运行中的记录**不见了**,直到压缩完成才又冒出「已压缩 N 条早期消息」。
// 根因:压缩的运行态反馈都不落盘(手动 = 前端命令卡,自动 = 实时事件 compaction_start 插的运行行),
// 切回会话时历史整表重载把它们抹掉;旧补回逻辑只会补一条"上下文压缩"运行行 —— 那是自动压缩的
// 记录,不是用户点的那条 /compact,用户看到的就是"我的压缩记录丢了"。
//
// 断言的是可见结果(页面上那条命令卡在不在),不是实现:
//   1) 点 /compact 后出现运行态命令卡;
//   2) 切到 A 再切回 B,同一条「正在压缩当前会话上下文…」命令卡仍在(不是补成别的东西);
//   3) 切回 B 时不得冒出「上下文压缩」自动压缩运行行(手动压缩不能被显示成自动压缩);
//   4) 压缩完成后仍落成持久记录(标记行「已压缩 N 条早期消息」)。
//
// 环境要求:web/dist 已构建(npm run build)+ 本机有 Chrome/Edge(或 BROWSER_PREVIEW_EXECUTABLE)。
// 缺任一项则整段跳过并算通过 —— 那是环境问题,不是代码回归。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 预置:mock 模型(正常轮次立即回)、完全访问(免审批)、选中 mock 提供方
const DATA = mkdtempSync(path.join(tmpdir(), 'sshai-compact-switch-'));
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

const WORK_WS = mkdtempSync(path.join(tmpdir(), 'sshai-compact-switch-ws-'));

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
let release = () => {};
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

  const { agent } = await import('../server/agent/agent.ts');
  const runningRow = page.locator('.agent-slot:not(.hide) .running-text').first();
  const itemByText = (t) => page.locator('.s-panel .session-item').filter({ hasText: t }).first();
  /** 走 RPC 新建一个会话(等价于点会话面板的「＋」,但不依赖面板按钮的悬浮态结构) */
  const rpcCall = (payload, expectReqId = 'rpc') => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const t = setTimeout(() => { ws.close(); reject(new Error(`RPC 超时: ${payload.type}`)); }, 15000);
    ws.on('open', () => ws.send(JSON.stringify({ ...payload, reqId: expectReqId })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.reqId === expectReqId) { clearTimeout(t); ws.close(); resolve(m); }
    });
    ws.on('error', reject);
  });
  const createSession = (title) => rpcCall({ type: 'session_create', title }, 'new');
  /** 直接给某个会话发一条消息(用于让新建的空会话有内容 —— 空会话不占会话列表位) */
  const speakTo = (sid, text) => rpcCall({ type: 'speak', sid, text, reasoning: 'default' }, 'speak');
  /** 等该会话这一轮跑完(服务端 busy 复位) */
  const waitIdle = async (sid) => {
    for (let i = 0; i < 150; i++) {
      const rt = agent._runtimes.get(String(sid));
      if (!rt || (!rt.busy && !rt.compacting)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`会话未在预期时间内空闲: ${sid}`);
  };
  // 手动压缩的命令卡(CommandCard):/compact + 「正在压缩当前会话上下文…」
  const runningCmd = page.locator('.dsh-command[data-state="running"] .dsh-summary').first();
  // 自动压缩的运行行(CompactionRow data-state=running):手动压缩绝不该补成它
  const autoRunningRow = page.locator('.dsh-compaction[data-state="running"]');
  const cmdText = '正在压缩当前会话上下文…';

  /** 发一条消息并等这一轮收尾(状态行重新隐藏) */
  const sendAndSettle = async (text) => {
    await input.fill(text);
    await input.press('Enter');
    await runningRow.waitFor({ timeout: 20000 });
    await runningRow.waitFor({ state: 'hidden', timeout: 30000 });
  };

  console.log('\n[手动 /compact 的运行记录必须活过「切走再切回」]');
  try {
    // 会话 A:第一条消息创建会话 A
    await sendAndSettle('会话甲:你好');
    await itemByText('会话甲').waitFor({ timeout: 15000 });

    // 新建会话乙并直接喂一条消息(空会话不占会话列表位),再从列表切过去 —— 真实的多会话切换路径
    const created = await createSession('会话乙');
    const sidB = created?.created?.id;
    check('新建会话乙成功', !!sidB, JSON.stringify(created).slice(0, 200));
    await speakTo(sidB, '会话乙:第一轮,请简单回一句');
    await waitIdle(sidB);
    await speakTo(sidB, '会话乙:第二轮,请简单回一句');
    await waitIdle(sidB);
    await itemByText('会话乙').waitFor({ timeout: 20000 });
    await itemByText('会话乙').click();
    await page.waitForTimeout(600);

    // 手动压缩要真的走摘摘要(非 mock)才有"正在压缩"的静默期:把 agent 的模型换成假模型,
    // 摘要请求卡在闸门上,于是命令卡会一直停在运行态,够时间做切换断言。
    const gate = new Promise((r) => { release = r; });
    const isSummaryCall = (o) => {
      const last = Array.isArray(o?.messages) ? o.messages[o.messages.length - 1] : null;
      return /压缩引擎/.test(String(last?.content || ''));
    };
    const fakeLlm = {
      isMock: false, model: 'fake-summary', contextWindow: 200000, maxTokens: 1024,
      async chat(o) {
        if (isSummaryCall(o)) await gate; // 摘要生成中:模拟几十秒的真实 LLM 往返
        return { content: '【checkpoint 摘要】测试用摘要:目标、已完成、待办。', toolCalls: [], reasoning: '' };
      }
    };
    agent.llm = fakeLlm;
    // 会话级模型快照也指向假模型:前端切会话时可能刚下发过 mock 客户端,只改全局会被它盖住
    agent._llmBySid.clear();
    agent._llmBySid.set(String(sidB), fakeLlm);

    // 在会话 B 里执行 /compact
    await input.fill('/compact');
    await input.press('Enter');
    const cmdCard = page.locator('.dsh-command').first();
    let cmdAppeared = false;
    try { await cmdCard.waitFor({ timeout: 15000 }); cmdAppeared = true; } catch { /* 见下面的断言语义 */ }
    const cmdState = cmdAppeared ? await cmdCard.getAttribute('data-state') : 'none';
    const cmdShown = cmdAppeared ? (await cmdCard.innerText()).trim() : '';
    console.log(`  · 命令卡:state=${cmdState} text=「${cmdShown}」`);
    check('执行 /compact 后出现运行态命令卡「正在压缩当前会话上下文…」',
      cmdAppeared && cmdState === 'running' && cmdShown.includes(cmdText),
      `state=${cmdState} text=「${cmdShown}」`);

    // 切到 A(压缩在后台继续),再切回 B
    await itemByText('会话甲').click();
    await page.waitForTimeout(600);
    await itemByText('会话乙').click();

    // 回归点:切回 B 后,同一条运行态命令卡必须还在
    let stillThere = false;
    try { await runningCmd.waitFor({ timeout: 8000 }); stillThere = true; } catch { /* 没等到 = 记录丢了 */ }
    const txt = stillThere ? (await runningCmd.innerText()).trim() : '';
    check('切走再切回后,运行态命令卡仍在(不是"记录不见了")', stillThere && txt.includes(cmdText), `got「${txt}」`);
    check('切回后没有冒出「上下文压缩」自动压缩运行行(手动压缩没被显示成自动压缩)',
      (await autoRunningRow.count()) === 0, `autoRunningRows=${await autoRunningRow.count()}`);

    // 放行摘要 → 压缩完成:运行态记录收尾为持久标记行
    release();
    const doneRow = page.locator('.dsh-compaction .dsh-summary').filter({ hasText: '已压缩' }).first();
    let done = false;
    try { await doneRow.waitFor({ timeout: 30000 }); done = true; } catch { /* 失败态另行断言 */ }
    check('压缩完成后落成持久记录(标记行「已压缩 N 条早期消息」)', done,
      done ? '' : await page.locator('.dsh-compaction').first().innerText().catch(() => 'no-compaction-row'));
  } finally {
    release();
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 用例异常:${e?.message || e}`);
} finally {
  try { await browser.close(); } catch { /* 忽略 */ }
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败, ${skipped} 跳过 ====`);
process.exit(fail > 0 ? 1 : 0);
