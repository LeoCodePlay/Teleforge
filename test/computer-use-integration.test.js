// computer-use 端到端集成测试(可选,默认跳过):
//   真起一个后端服务 -> 通过 WS RPC 开关 AI 电脑操控 -> 确认「AI 操控中」悬浮窗进程真的起来
//   -> 打 HTTP 急停接口(等价于用户点悬浮窗「停止」)-> 确认状态锁定且悬浮窗进程退出。
//
// 为什么默认跳过:它会真的在本机弹出悬浮窗、并占用一个端口,不适合放进无人值守的 CI;
// 本机验证时用:  TF_COMPUTER_USE_LIVE=1 node test/computer-use-integration.test.js
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.TF_COMPUTER_USE_LIVE !== '1' || process.platform !== 'win32') {
  console.log('跳过 computer-use 集成测试(设 TF_COMPUTER_USE_LIVE=1 且在 Windows 桌面会话下运行可开启)');
  process.exit(0);
}

const { default: WebSocket } = await import('ws');

const PORT = Number(process.env.TF_CU_TEST_PORT || 4399);
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-cu-srv-'));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; log(`✓ ${n}`); } else { fail++; log(`✗ ${n} ${e}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 只统计真正由本功能拉起的悬浮窗进程;排除查询自身(它的命令行里也含 overlay.ps1)
function overlayProcCount() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*teleforge-computer-use*overlay.ps1*' } | Measure-Object).Count"
  ], { encoding: 'utf8' });
  return Number(String(r.stdout || '').trim()) || 0;
}

const server = spawn(process.execPath, ['server/index.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), DATA_DIR, HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

async function waitHealth(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  return false;
}

let ws = null;
const events = [];
let reqId = 0;
const waiters = new Map();

function connectWs() {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    sock.on('error', reject);
    sock.on('open', () => { ws = sock; resolve(sock); });
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      events.push(m);
      if (m.reqId && waiters.has(m.reqId)) { waiters.get(m.reqId)(m); waiters.delete(m.reqId); }
    });
  });
}

const call = (type, payload = {}, timeout = 15000) => new Promise((resolve, reject) => {
  const id = ++reqId;
  const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`超时: ${type}`)); }, timeout);
  waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
  ws.send(JSON.stringify({ type, ...payload, reqId: id }));
});

try {
  if (!await waitHealth()) throw new Error('服务未就绪:\n' + serverLog.slice(-2000));
  await connectWs();
  await sleep(500);

  const status = await call('computer_use_status');
  check('默认未开启', status.type === 'computer_use' && status.active === false && status.supported === true, JSON.stringify(status));

  const tools = await call('tools_list');
  const names = (tools.tools || []).map((t) => t.name);
  check('computer_* 全部工具已进入模型可见工具集',
    ['computer_screenshot', 'computer_action', 'computer_control', 'computer_windows',
      'computer_launch', 'computer_ui', 'computer_ui_action', 'computer_ocr'].every((n) => names.includes(n)),
    names.filter((n) => n.startsWith('computer_')).join(','));

  const on = await call('computer_use_set', { enabled: true });
  check('用户开启:应答 active=true', on.active === true, JSON.stringify(on));
  check('用户开启:向所有界面广播状态', events.some((m) => m.type === 'computer_use' && m.active === true && !m.reqId));

  await sleep(3000);
  check('开启后悬浮窗进程存活', overlayProcCount() >= 1, `count=${overlayProcCount()}`);

  const httpStatus = await (await fetch(`http://127.0.0.1:${PORT}/api/computer-use/status`)).json();
  check('HTTP 状态接口反映 active=true', httpStatus.active === true, JSON.stringify(httpStatus));

  // 模拟用户点悬浮窗「停止」
  const stopRes = await (await fetch(`http://127.0.0.1:${PORT}/api/computer-use/stop`, { method: 'POST' })).json();
  check('急停:active=false 且 userLocked=true', stopRes.active === false && stopRes.userLocked === true, JSON.stringify(stopRes));
  await sleep(2000);
  check('急停后悬浮窗进程退出', overlayProcCount() === 0, `count=${overlayProcCount()}`);
  check('急停状态已广播', events.some((m) => m.type === 'computer_use' && m.userLocked === true));

  const again = await call('computer_use_status');
  check('急停后 AI 无法自行恢复(userLocked 保持)', again.active === false && again.userLocked === true, JSON.stringify(again));
} catch (e) {
  fail++;
  log('✗ 测试异常:', e.message);
  log('服务日志尾部:\n' + serverLog.slice(-3000));
} finally {
  try { ws?.close(); } catch { /* 已关闭 */ }
  server.kill();
  await sleep(500);
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
  log(`==== 结果: ${pass} 通过, ${fail} 失败 ====`);
  process.exit(fail > 0 ? 1 : 0);
}
