// 多服务器切换下的会话归属回归测试(证明并锁定两条不该发生的行为):
//   S1 排队轮次必须留在它自己的服务器上:服务器 A 的会话在「用户已切到 B」后开始的
//      下一轮,工具仍然只能作用于 A(不得写到 B 的连接/磁盘)。
//   S2 断开服务器 B 不得中断属于服务器 A 的会话:A 的后台运行不能被 B 的断开连带停止。
// 运行:npm run test:binding (node test/multi-server-binding.test.js)
import { mkdtempSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-bind-dd-'));
const { WebSocket } = await import('ws');
const { startMockSsh, makeFixture } = await import('./mock-ssh-server.js');
const { startApp } = await import('../server/index.ts');

const APP_PORT = 4399;
const PORT_A = 2499;
const PORT_B = 2498;
const ROOT_A = mkdtempSync(path.join(tmpdir(), 'sshai-bind-a-'));
const ROOT_B = mkdtempSync(path.join(tmpdir(), 'sshai-bind-b-'));
const KEY_A = `127.0.0.1:${PORT_A}:tester`;
const KEY_B = `127.0.0.1:${PORT_B}:tester`;
const NOTES_A = path.join(ROOT_A, 'src', 'ai-notes.md');
const NOTES_B = path.join(ROOT_B, 'src', 'ai-notes.md');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name} ${extra}`); }
};
const waitFor = async (fn, timeout = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 60));
  }
  return fn();
};

function wsClient(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const events = [];
  let seq = 0;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    events.push(m);
    if (m.reqId && pending.has(m.reqId)) {
      const { resolve, t } = pending.get(m.reqId);
      clearTimeout(t); pending.delete(m.reqId); resolve(m);
    }
  });
  return {
    ready: new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    send: (type, payload = {}) => ws.send(JSON.stringify({ type, ...payload })),
    request: (type, payload = {}) => new Promise((resolve, reject) => {
      const reqId = ++seq;
      const t = setTimeout(() => { pending.delete(reqId); reject(new Error(`${type} 超时`)); }, 25000);
      pending.set(reqId, { resolve, t });
      ws.send(JSON.stringify({ type, ...payload, reqId }));
    }),
    events,
    close: () => ws.close()
  };
}

const connArgs = (port) => ({ ssh: { host: '127.0.0.1', port, username: 'tester', auth: { type: 'password', password: 'pass' }, autoReconnect: true } });
const agentEv = (ws, ev, sid, from = 0) => ws.events.slice(from).filter((e) => e.type === 'agent' && e.event === ev && e.sid === sid);
const rmQuiet = (p) => { try { unlinkSync(p); } catch {} };

async function main() {
  makeFixture(ROOT_A);
  makeFixture(ROOT_B);
  const mockA = startMockSsh({ port: PORT_A, rootDir: ROOT_A });
  const mockB = startMockSsh({ port: PORT_B, rootDir: ROOT_B });
  await startApp({ port: APP_PORT, host: '127.0.0.1', quiet: true });

  const ws = wsClient(`ws://127.0.0.1:${APP_PORT}/ws`);
  await ws.ready;
  ws.send('llm', { llm: { baseUrl: 'http://mock', apiKey: '', model: 'mock' } });
  await new Promise((r) => setTimeout(r, 120));

  // 连上 A 并把当前会话的工作区绑到 A 的 /src(会话自此属于服务器 A)
  await ws.request('connect', connArgs(PORT_A));
  await waitFor(() => ws.events.find((e) => e.type === 'status' && e.port === PORT_A && e.status === 'connected'));
  const s0 = await ws.request('session_list', {});
  const sidA = s0.active;
  await ws.request('set_workspace', { path: '/src', sid: sidA });
  check('前置:会话已绑定服务器 A 的工作区 /src', Boolean(sidA), JSON.stringify(s0));

  // ---- S1:排队轮次在「切到 B 之后」开始,工具必须仍作用于 A ----
  console.log('== S1 A 的排队轮次切到 B 后开始:工具不得串到 B ==');
  rmQuiet(NOTES_A); rmQuiet(NOTES_B);
  const mark1 = ws.events.length;
  ws.send('speak', { text: '第一轮:检查 A 的工作区' });
  await waitFor(() => agentEv(ws, 'start', sidA, mark1).length >= 1);
  ws.send('speak', { text: '第二轮:排队消息,当前轮结束后自动执行' }); // 进待执行队列
  await new Promise((r) => setTimeout(r, 120));
  // 用户切到服务器 B(排队轮尚未开始)
  await ws.request('connect', connArgs(PORT_B));
  await waitFor(() => ws.events.find((e) => e.type === 'status' && e.port === PORT_B && e.status === 'connected'));
  const done1 = await waitFor(() => agentEv(ws, 'done', sidA, mark1).length >= 2, 25000);
  check('A 的两轮都在切换后正常完成', Boolean(done1), 'done 数=' + agentEv(ws, 'done', sidA, mark1).length);
  const wroteB = existsSync(NOTES_B);
  const wroteA = existsSync(NOTES_A);
  check('A 会话的写入落在服务器 A', wroteA, `A=${wroteA} B=${wroteB}`);
  check('服务器 B 没有被 A 的会话写入(未串台)', !wroteB, `B 上出现 ${NOTES_B}`);

  // ---- S2:属于 A 的运行中会话,不能被「断开 B」连带停止 ----
  console.log('== S2 断开服务器 B 不得中断属于 A 的会话 ==');
  await ws.request('conn_switch', { id: KEY_A });
  await new Promise((r) => setTimeout(r, 150));
  const mark2 = ws.events.length;
  ws.send('speak', { text: 'A 继续第三轮' });
  await waitFor(() => agentEv(ws, 'start', sidA, mark2).length >= 1);
  ws.send('speak', { text: 'A 的排队第四轮' });
  await new Promise((r) => setTimeout(r, 120));
  await ws.request('conn_switch', { id: KEY_B });              // 切到 B
  await waitFor(() => agentEv(ws, 'start', sidA, mark2).length >= 2, 25000); // A 的下一轮已开始
  const t0 = Date.now();
  await ws.request('conn_disconnect', { id: KEY_B });          // 断开 B(A 的会话不该受影响)
  const stopped = await waitFor(() => agentEv(ws, 'stopped', sidA, mark2).length >= 1, 1500);
  const done2 = agentEv(ws, 'done', sidA, mark2).length >= 2;
  check(`断开 B 之后 A 的会话仍在跑并正常收尾(${Date.now() - t0}ms)`, done2 && !stopped,
    stopped ? 'A 收到了 stopped(被 B 的断开连带中断)' : `done=${agentEv(ws, 'done', sidA, mark2).length}`);

  ws.close();
  mockA.close(); mockB.close();
  console.log(`\n结果:通过 ${pass},失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(2); });
