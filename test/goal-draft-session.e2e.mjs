// 真协议 e2e:草稿态(没有会话)直接发 /目标 <描述> —— 必须自己建会话、创建目标、并立刻排第 1 轮。
// 走的是与前端完全相同的 WebSocket RPC 三条消息:set_local_workspace → session_create → goal_command。
// (前端 ChatPanel 的 ensureCommandSession 就是前两条;本脚本验证这三步的服务端语义与顺序。)
import { WebSocket } from 'ws';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.VERIFY_PORT || 8791);
const DATA = process.env.VERIFY_DATA || '';
const WORK_WS = mkdtempSync(path.join(tmpdir(), 'sshai-e2e-ws-'));

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

function rpc(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const reqId = `req-${Math.random().toString(36).slice(2)}`;
    const t = setTimeout(() => { ws.close(); reject(new Error(`${type} 超时`)); }, 10000);
    ws.on('open', () => ws.send(JSON.stringify({ type, reqId, ...payload })));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.reqId !== reqId) return;
      clearTimeout(t); ws.close(); resolve(m);
    });
    ws.on('error', reject);
  });
}

/** 轮询等待条件成立(服务端的续跑调度是异步的) */
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

console.log(`[e2e] 目标服务器 127.0.0.1:${PORT}`);
const ws1 = await rpc('set_local_workspace', { path: WORK_WS });
check('前置:本地工作区已设定', ws1.type === 'ok' || !ws1.error, JSON.stringify(ws1).slice(0, 160));

// 前端进入页面时下发的模型配置(草稿态不带 sid = 全局默认)。没有这一步 agent.llm 为空,
// 续跑调度会被 `if (!this.llm) return` 挡掉 —— 那是"界面没连上"而不是命令的问题。
const llm = await rpc('llm', { llm: { baseUrl: 'http://127.0.0.1:1', apiKey: 'x', model: 'mock' } });
check('前置:模型已下发(llm RPC)', llm.type === 'ok', JSON.stringify(llm).slice(0, 160));

// 草稿态 = 还没有任何会话。用 connection.status 确认一下(拿不到 active 也不影响)
const created = await rpc('session_create', {});
const sid = created?.active;
check('草稿态命令的第一步:session_create 拿到真实会话 id', !!sid, JSON.stringify(created).slice(0, 200));

const goal = await rpc('goal_command', { input: ' 把三件事做完', sid });
check('第二步:目标创建成功', goal?.kind === 'success' && /已创建目标/.test(goal?.text || ''), JSON.stringify(goal).slice(0, 220));
check('目标阶段 active 且已授权', goal?.goal?.phase === 'active' && goal?.goal?.activation === 'armed', JSON.stringify(goal?.goal));

// 第 1 轮续跑由服务端异步排入;等它落到会话日志(与 harness"命令建目标→立刻开第 1 轮"一致)
const sessionsDir = path.join(DATA, 'sessions');
const roundSeen = await until(() => {
  let files = [];
  try { files = readdirSync(sessionsDir).filter((f) => f.endsWith('.json')); } catch { return null; }
  for (const f of files) {
    let doc; try { doc = JSON.parse(readFileSync(path.join(sessionsDir, f), 'utf8')); } catch { continue; }
    const ev = doc.events || [];
    const rounds = ev.filter((e) => e.type === 'user/message' && e.data?.source === 'goal');
    if (rounds.length > 0) return { rounds, events: ev };
  }
  return null;
});
check('第三步:命令后立刻排了第 1 轮目标续跑(roundsStarted=1)', !!roundSeen, '等了 8s 没等到目标轮');
if (roundSeen) {
  check('第 1 轮带 <goal_round> 提示词', /<goal_round>/.test(roundSeen.rounds[0]?.data?.content || ''));
  check('第 1 轮归属当前目标(round=1)', roundSeen.rounds[0]?.data?.round === 1 && !!roundSeen.rounds[0]?.data?.goalId);
  const changes = roundSeen.events.filter((e) => e.type === 'goal/change');
  // roundsStarted 是"折叠得出的值"(不逐条重写进 goal/change),所以这里只断言日志事实:
  // 目标轮已进入历史(round=1、source=goal、带 <goal_round>)且与目标绑定。
  check('会话日志里目标轮与目标绑定(goalId 一致)', roundSeen.rounds[0]?.data?.goalId === changes[0]?.data?.goal?.id,
    `${roundSeen.rounds[0]?.data?.goalId} vs ${changes[0]?.data?.goal?.id}`);
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
