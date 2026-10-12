// status 快照的本地工作区隔离回归测试(用户上报的现场):
//   本地模式下有两个本地工作区分组 A / B,用户在 B 的界面看 B 的任务;
//   此时 A 分组里的会话仍在后台跑(它会在自己的运行作用域里产生 agent status 事件,
//   生产路径就是子代理 notify:c.emit('agent', { event:'status' }) 在父轮的作用域内执行),
//   服务端 ws 层据此 emitStatus() —— 如果它读**作用域感知**的 localFs.workspace,
//   广播出去的 status.localWorkspace 就会是 A 的工作区,前端输入框下方的本地工作区 chip
//   会在 B 的界面上跳成 A。
// 期望:emitStatus 永远上报「全局(非作用域)」的本地工作区。
// 运行:node test/status-scope-isolation.test.js
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-status-scope-'));
const { WebSocket } = await import('ws');
const { startApp } = await import('../server/index.ts');
const { agent } = await import('../server/agent/agent.ts');
const { localFs, runWithLocalWorkspace, runWithLocalNoWorkspace } = await import('../server/core/local-fs.ts');

const APP_PORT = 4391;
const DIR_A = mkdtempSync(path.join(tmpdir(), 'sshai-ws-A-'));
const DIR_B = mkdtempSync(path.join(tmpdir(), 'sshai-ws-B-'));
mkdirSync(DIR_A, { recursive: true });
mkdirSync(DIR_B, { recursive: true });

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await startApp({ port: APP_PORT, host: '127.0.0.1', quiet: true });

const ws = new WebSocket(`ws://127.0.0.1:${APP_PORT}/ws`);
const pending = new Map();
let seq = 0;
const statuses = [];
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type === 'status') statuses.push(m);
  if (m.reqId && pending.has(m.reqId)) {
    const { resolve, t } = pending.get(m.reqId);
    clearTimeout(t); pending.delete(m.reqId); resolve(m);
  }
});
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
const request = (type, payload = {}) => new Promise((resolve, reject) => {
  const reqId = ++seq;
  const t = setTimeout(() => { pending.delete(reqId); reject(new Error(`${type} 超时`)); }, 20000);
  pending.set(reqId, { resolve, t });
  ws.send(JSON.stringify({ type, ...payload, reqId }));
});

// 两个本地工作区各建一个会话;当前查看的是 B(全局本地工作区 = DIR_B)
const a = await request('session_create', { title: 'A 分组会话' });
await request('set_local_workspace', { path: DIR_A, sid: a.active });
const b = await request('session_create', { title: 'B 分组会话' });
await request('set_local_workspace', { path: DIR_B, sid: b.active });
await request('session_switch', { id: b.active });
await sleep(200);

check('前置:全局本地工作区 = B', localFs.globalWorkspace() === DIR_B, JSON.stringify(localFs.globalWorkspace()));
check('前置:最近一次 status.localWorkspace = B', statuses[statuses.length - 1]?.localWorkspace === DIR_B,
  JSON.stringify(statuses[statuses.length - 1]?.localWorkspace));

// ---- 场景 1:后台会话 A 的运行作用域内产生一个 agent status 事件(子代理 notify 的真实条件)----
{
  const before = statuses.length;
  runWithLocalWorkspace(DIR_A, () => {
    agent.emit('agent', { event: 'status', sid: a.active, status: 'running' });
  });
  await sleep(300);
  const pushed = statuses.slice(before);
  check('作用域内触发 status 时确实推送了 status 快照', pushed.length > 0, `条数=${pushed.length}`);
  check('推送的 localWorkspace 仍是 B(不是后台会话 A 的工作区)',
    pushed.length > 0 && pushed.every((s) => s.localWorkspace === DIR_B),
    JSON.stringify(pushed.map((s) => s.localWorkspace)));
}

// ---- 场景 2:同样条件下,「不在工作区对话」(全盘标记)也不得取作用域值 ----
{
  const before = statuses.length;
  runWithLocalNoWorkspace(true, () => {
    agent.emit('agent', { event: 'status', sid: a.active, status: 'idle' });
  });
  await sleep(300);
  const pushed = statuses.slice(before);
  check('推送的 localNoWorkspace 是全局值 false,不是作用域内的 true',
    pushed.length > 0 && pushed.every((s) => s.localNoWorkspace === false),
    JSON.stringify(pushed.map((s) => s.localNoWorkspace)));
  check('推送的 localWorkspace 依旧没有变成 A',
    pushed.length > 0 && pushed.every((s) => s.localWorkspace !== DIR_A),
    JSON.stringify(pushed.map((s) => s.localWorkspace)));
}

// ---- 场景 3:作用域外触发时,行为不变(仍然上报全局值)----
{
  const before = statuses.length;
  agent.emit('agent', { event: 'status', sid: b.active, status: 'idle' });
  await sleep(300);
  const pushed = statuses.slice(before);
  check('作用域外触发同样上报全局本地工作区 B',
    pushed.length > 0 && pushed.every((s) => s.localWorkspace === DIR_B), JSON.stringify(pushed.map((s) => s.localWorkspace)));
}

ws.close();
console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
