// 回归:扩展必须能**同时**连上多个 Teleforge 服务端。
//
// 修的是这个现象:桌面端与开发用的网页端(npm run dev)同时在这台机器上跑,
// 各占 4000-4019 里的一个端口。旧版扩展只持一条 WebSocket,后连的会把先连的顶掉 ——
// "连上网页端之后桌面端就再也用不了"。
//
// 做法:真起两个 Teleforge 实例(一个带 TELEFORGE_SHELL=desktop),用桩替换 chrome 扩展 API
// 后把 extension/background.js 当普通模块加载,驱动它的 popup 消息通道,
// 再从两个服务端各自的配对接口回读 status.online —— 两边都为 true 才算通过。
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const check = (n, c, e = '') => { if (c) { pass++; log(`✓ ${n}`); } else { fail++; log(`✗ ${n} ${e}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 桩:chrome 扩展 API ----------------

const msgListeners = [];
const store = new Map();

function installChromeStub() {
  const noop = () => {};
  const addListener = { addListener: noop };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: 'test' }),
      onMessage: { addListener: (fn) => msgListeners.push(fn) },
      onInstalled: addListener,
      onStartup: addListener
    },
    storage: {
      local: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        set: async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
        remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k); }
      }
    },
    tabs: {
      onCreated: addListener, onRemoved: addListener, onActivated: addListener, onUpdated: addListener,
      query: async () => [], get: async () => null, create: async () => ({ id: 1 }),
      update: async () => ({}), remove: async () => {}
    },
    windows: { update: async () => ({}) },
    alarms: { create: noop, onAlarm: addListener },
    debugger: {
      onDetach: addListener,
      getTargets: async () => [],
      attach: async () => {}, detach: async () => {}, sendCommand: async () => ({})
    }
  };
  if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' } });
}

/** 把 popup → background 的 sendMessage 通道包成 Promise */
function send(type, extra = {}) {
  return new Promise((resolve) => {
    const fn = msgListeners[0];
    if (!fn) return resolve({ ok: false, error: 'background 没注册 onMessage' });
    const ret = fn({ type, ...extra }, {}, resolve);
    if (ret !== true) resolve({ ok: false, error: 'onMessage 没有异步回复' });
  });
}

/** 等条件成立(WebSocket 握手是异步的,scan/connect 返回时可能还在 connecting) */
async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await send('status');
    last = r.status || { servers: [] };
    if (fn(last)) return last;
    await sleep(100);
  }
  return last;
}

// ---------------- 起两个服务端实例 ----------------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** 在扩展固定扫描区间 4000-4019 里挑两个空端口 */
async function pickPorts() {
  const ports = [];
  for (let p = 4000; p <= 4019 && ports.length < 2; p++) {
    const srv = net.createServer();
    const free = await new Promise((resolve) => {
      srv.once('error', () => resolve(false));
      srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (free) ports.push(p);
  }
  if (ports.length < 2) throw new Error('4000-4019 里找不到两个空闲端口');
  return ports;
}

const servers = [];
const logs = new Map();

function startServer(port, extraEnv) {
  const dataDir = mkdtempSync(join(tmpdir(), `tf-ext-bridge-${port}-`));
  const proc = spawn(process.execPath, ['server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, HOST: '127.0.0.1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  logs.set(port, '');
  proc.stdout.on('data', (d) => logs.set(port, logs.get(port) + d));
  proc.stderr.on('data', (d) => logs.set(port, logs.get(port) + d));
  servers.push({ port, proc, dataDir });
}

async function waitHealth(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  return false;
}

/** 服务端侧的真相:扩展是否真的连在这台服务端上 */
async function serverSide(port) {
  const r = await fetch(`http://127.0.0.1:${port}/api/browser-bridge/pair`, { headers: { 'X-Bridge-Pair': '1' } });
  if (!r.ok) throw new Error(`pair ${port} → ${r.status}`);
  return r.json();
}

function killTree(proc) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else proc.kill('SIGKILL');
  } catch { /* 已退出 */ }
}

// ---------------- 跑起来 ----------------

let ports = [];
try {
  // 0) 静态一致性:popup 引用的元素 id / 发的消息,background 侧必须都有(改 UI 时最容易漏)
  const popupJs = fs.readFileSync('extension/popup.js', 'utf8');
  const popupHtml = fs.readFileSync('extension/popup.html', 'utf8');
  const backgroundJs = fs.readFileSync('extension/background.js', 'utf8');
  const ids = [...new Set([...popupJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  const missingIds = ids.filter((id) => !popupHtml.includes(`id="${id}"`));
  check('popup.html 覆盖了 popup.js 引用的全部 id', missingIds.length === 0, missingIds.join(', '));
  const handled = [...new Set([...backgroundJs.matchAll(/type === '([A-Za-z]+)'/g)].map((m) => m[1]))];
  const sent = [...new Set([...popupJs.matchAll(/act\('([A-Za-z]+)'|ask\('([A-Za-z]+)'/g)].map((m) => m[1] || m[2]))];
  const unhandled = sent.filter((t) => !handled.includes(t));
  check('popup 发的消息 background 都处理了', unhandled.length === 0, unhandled.join(', '));

  ports = await pickPorts();
  const [webPort, desktopPort] = ports;
  log(`使用端口 网页端=${webPort} 桌面端=${desktopPort}`);

  startServer(webPort, {});
  // 桌面端由 Tauri 外壳拉起时会注入这个环境变量(见 src-tauri/src/backend.rs)
  startServer(desktopPort, { TELEFORGE_SHELL: 'desktop' });

  for (const p of ports) {
    if (!await waitHealth(p)) throw new Error(`服务 ${p} 未就绪:\n${logs.get(p).slice(-2000)}`);
  }

  const webInfo = await serverSide(webPort);
  const deskInfo = await serverSide(desktopPort);
  check('配对接口回传 kind 用于区分两边', webInfo.kind === 'web' && deskInfo.kind === 'desktop', `${webInfo.kind} / ${deskInfo.kind}`);
  check('两端 token 是各自独立的', webInfo.token !== deskInfo.token);

  // 升级路径:旧版只存一个服务端(serverBase/token/wsUrl),先塞进去看会不会被迁移过来
  store.set('serverBase', `http://127.0.0.1:${webPort}`);
  store.set('token', webInfo.token);
  store.set('wsUrl', webInfo.wsUrl);
  store.set('paused', false);

  installChromeStub();
  await import('../extension/background.js');
  check('background 已注册 popup 消息通道', msgListeners.length === 1, `listeners=${msgListeners.length}`);

  // 1) 升级后自动恢复旧的那个服务端,并把旧键清掉
  const migrated = await waitFor((s) => (s.servers || []).some((x) => x.port === String(webPort) && x.connected));
  check('旧版单服务端配置被迁移并自动连上', (migrated.servers || []).some((s) => s.port === String(webPort) && s.connected), JSON.stringify(migrated.servers));
  check('旧版键已清理', !store.has('serverBase') && !store.has('token') && !store.has('wsUrl'));
  check('迁移后列表里只有迁移来的这一条', (migrated.servers || []).length === 1, JSON.stringify(migrated.servers));

  // 2) 扫描:两个服务端都要连上(旧版只会连第一个)
  const scanned = await send('scan');
  check('扫描成功返回', scanned.ok === true, JSON.stringify(scanned).slice(0, 300));
  check('扫描结果里含这次起的两个端口',
    (scanned.found || []).includes(`http://127.0.0.1:${webPort}`) && (scanned.found || []).includes(`http://127.0.0.1:${desktopPort}`),
    JSON.stringify(scanned.found));
  // 注意:测试机上也常有真正的 Teleforge 在跑(它们同样会被扫到),所以这里只断言我们这两个
  const status = await waitFor((s) => {
    const m = new Map(s.servers.map((x) => [x.port, x]));
    return m.get(String(webPort))?.connected && m.get(String(desktopPort))?.connected;
  });
  const byPort = new Map((status.servers || []).map((s) => [s.port, s]));
  check(`扫到并连上网页端 ${webPort}`, byPort.get(String(webPort))?.connected === true, JSON.stringify(status.servers));
  check(`扫到并连上桌面端 ${desktopPort}`, byPort.get(String(desktopPort))?.connected === true, JSON.stringify(status.servers));
  check('两边同时在线(不再互相顶掉)', status.online >= 2, `online=${status.online}`);
  check('kind 带到扩展侧', byPort.get(String(webPort))?.kind === 'web' && byPort.get(String(desktopPort))?.kind === 'desktop',
    `${byPort.get(String(webPort))?.kind} / ${byPort.get(String(desktopPort))?.kind}`);

  await sleep(300);
  check('服务端 A 也认为扩展在线', (await serverSide(webPort)).status.online === true);
  check('服务端 B 也认为扩展在线', (await serverSide(desktopPort)).status.online === true);

  // 3) 断开其中一个:另一个必须不受影响
  const removed = await send('remove', { base: `http://127.0.0.1:${webPort}` });
  check('断开网页端成功', removed.ok === true);
  const afterRemove = await waitFor((s) => (s.servers || []).some((x) => x.port === String(desktopPort) && x.connected));
  check('断开后桌面端仍在连接中', (afterRemove.servers || []).some((s) => s.port === String(desktopPort) && s.connected), JSON.stringify(afterRemove.servers));
  await sleep(300);
  check('网页端服务侧已看不到扩展', (await serverSide(webPort)).status.online !== true);
  check('桌面端服务侧仍在线', (await serverSide(desktopPort)).status.online === true);

  // 4) 手动指定端口(只填端口号)重新连上
  const reconnected = await send('connect', { serverBase: String(webPort) });
  check('只填端口号即可连接', reconnected.ok === true && reconnected.base === `http://127.0.0.1:${webPort}`, JSON.stringify(reconnected).slice(0, 200));
  const back = await waitFor((s) => (s.servers || []).some((x) => x.port === String(webPort) && x.connected));
  check('重新连接后扩展侧显示已连接', (back.servers || []).some((s) => s.port === String(webPort) && s.connected), JSON.stringify(back.servers));
  await sleep(300);
  check('重新连接后网页端服务侧在线', (await serverSide(webPort)).status.online === true);
  check('桌面端全程没掉', (await serverSide(desktopPort)).status.online === true);

  // 5) 断开全部
  const all = await send('disconnectAll');
  check('全部断开成功', all.ok === true && (all.status.servers || []).length === 0, JSON.stringify(all.status.servers));
  await sleep(300);
  check('两个服务端都不再有扩展', (await serverSide(webPort)).status.online !== true && (await serverSide(desktopPort)).status.online !== true);
} catch (e) {
  fail++;
  log(`✗ 异常:${(e && e.stack) || e}`);
} finally {
  for (const s of servers) killTree(s.proc);
  for (const s of servers) { try { rmSync(s.dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  await sleep(300);
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}:${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
