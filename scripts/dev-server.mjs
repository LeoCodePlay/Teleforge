// 开发模式服务器热重启脚本
// 背景:node --watch 会向 node-pty 的 conout worker 广播 watch:require 消息(worker
// 不识别 → 刷屏 Unexpected ConoutWorkerMessage),且 worker 加载的文件被 watch 视为
// 依赖变化,触发意外重启直至进程退出。故自研 watch:只递归监听 server/ 源码目录,
// 排除 node_modules/依赖、data/output 运行产物与 *.log。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(root, 'server', 'index.ts');
const WATCH = path.join(root, 'server');

const SKIP_DIRS = new Set(['node_modules', 'data', 'output', '.git', 'skills']);
const SKIP_EXT = new Set(['.log', '.map', '.tmp']);

let child = null;
let restarting = false;
let timer = null;

function log(...args) {
  console.log(`[dev-server] ${args.join(' ')}`);
}

function start() {
  log(`启动 server/index.ts (pid 待定)`);
  child = spawn(process.execPath, [ENTRY], {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '1' }
  });
  log(`server 已启动 pid=${child.pid} (Ctrl+C 退出)`);
  child.on('exit', (code, signal) => {
    if (restarting) return; // 主动重启,不打印
    if (code !== 0 && code !== null) {
      log(`server 异常退出 code=${code} signal=${signal},5s 后重启…`);
      setTimeout(() => {
        if (stillWatching) start();
      }, 5000);
    }
  });
}

let stillWatching = true;

// 正在跑对话时不重启:agent 的一轮可能持续几十分钟,中途 kill 掉进程会让这一轮从对话里
// 直接消失(连用户刚发的那句话都只剩"未正常结束"的痕迹)。最多等 BUSY_MAX_WAIT_MS,
// 之后仍然重启,避免改完代码迟迟不生效。服务没起来/端口不通时照常重启。
const PORT = Number(process.env.PORT || 4000);
const BUSY_MAX_WAIT_MS = 120000;

async function agentBusy() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j && j.agentBusy === true);
  } catch { return false; }
}

function scheduleRestart(changePath, waitedMs = 0) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (!child || child.killed) return;
    if (await agentBusy()) {
      if (waitedMs < BUSY_MAX_WAIT_MS) {
        log(`agent 正在跑对话,延后重启(已等 ${Math.round(waitedMs / 1000)}s):${changePath}`);
        scheduleRestart(changePath, waitedMs + 1000);
        return;
      }
      log(`agent 忙碌已超过 ${Math.round(BUSY_MAX_WAIT_MS / 1000)}s,仍按计划重启:${changePath}`);
    }
    restarting = true;
    log(`检测到变更 ${changePath} → 重启`);
    child.kill();
    if (process.platform === 'win32') {
      // 子进程可能还有 conout worker 等孙进程,直接杀树。
      // 注意:本文件是 ESM,没有 require —— 旧写法 `require('node:child_process')` 会抛
      // ReferenceError 被 catch 吞掉,taskkill 实际从未执行:旧服务可能活着占着端口,
      // 新实例启动即 EADDRINUSE 退出 → 前端那边就是"服务突然没了、对话停在半路"。
      try {
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      } catch { /* 已退出 */ }
    }
    child.once('exit', () => {
      restarting = false;
      start();
    });
    // 兜底:若 exit 事件漏接,强制继续
    setTimeout(() => { restarting = false; if (stillWatching && (!child || child.exitCode !== null)) start(); }, 1500);
  }, 200);
}

function shouldSkip(p) {
  const parts = p.split(path.sep);
  if (parts.some((x) => SKIP_DIRS.has(x))) return true;
  if (SKIP_EXT.has(path.extname(p).toLowerCase())) return true;
  return false;
}

function watchTree(rootDir, onChange) {
  const watchers = [];
  function walk(dir) {
    let w;
    try {
      w = fs.watch(dir, { recursive: false }, (_evt, name) => {
        if (!name) return;
        onChange(path.join(dir, String(name)));
      });
    } catch { return; }
    watchers.push(w);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (shouldSkip(ent.name)) continue;
      const sub = path.join(dir, ent.name);
      if (path.relative(WATCH, sub).split(path.sep).some((x) => SKIP_DIRS.has(x))) continue;
      walk(sub);
    }
  }
  walk(rootDir);
  return () => { for (const w of watchers) try { w.close(); } catch {} };
}

log(`监听 ${WATCH}`);
const closeWatch = watchTree(WATCH, (p) => {
  if (shouldSkip(p)) return;
  scheduleRestart(path.relative(WATCH, p));
});
start();

function shutdown() {
  log('退出');
  stillWatching = false;
  closeWatch();
  if (child) { try { child.kill(); } catch {} }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);