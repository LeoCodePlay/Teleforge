// 会话删除测试(修复:新会话草稿态下,历史列表最后一个会话删不掉):
// - 允许删除当前活跃会话:删除后服务端活跃收敛到本作用域最近剩余会话,无剩余则自动新建空会话接住
//   (前端删除正打开的会话后进入新会话草稿态,不采纳服务端收敛结果)
// - 运行中的会话仍禁止删除(防破坏进行中的事件写入)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-del-'));
const { Agent } = await import('../server/agent/agent.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

const events = [];
const agent = new Agent({ emit: (e, p) => events.push([e, p]) });
const saw = (ev) => events.some(([e, p]) => e === 'agent' && p && p.event === ev);

// 场景 1:删除非活跃会话(原有行为,回归保护)
const x = agent.createSession('X');
const y = agent.createSession('Y');
agent.switchSession(x.id);
agent.deleteSession(y.id);
check('删除非活跃会话仍正常', !agent.listSessions().some((s) => s.id === y.id) && agent.getSessionId() === x.id);

// 场景 2:删除当前活跃会话 -> 成功,活跃收敛到剩余会话
agent.deleteSession(x.id);
const after = agent.listSessions();
check('删除活跃会话成功', !after.some((s) => s.id === x.id), JSON.stringify(after));
check('删除后活跃收敛到剩余会话', after.some((s) => s.id === agent.getSessionId()));
check('删除活跃会话广播 session_switched', saw('session_switched'));
check('删除广播 sessions_changed', saw('sessions_changed'));

// 场景 3:删光真实会话(每次都删当前活跃)-> 服务端始终自动新建空会话接住活跃(不收敛到 null)
agent.deleteSession(agent.getSessionId());
const mine = agent.listSessions();
check('删光后自动新建空会话接住活跃', mine.length === 1 && mine[0].msgCount === 0 && agent.getSessionId() === mine[0].id, JSON.stringify(mine));

// 场景 4:运行中的会话仍禁止删除
const rt = agent._runtimes.get(agent.getSessionId());
rt.busy = true;
let busyErr = '';
try { agent.deleteSession(agent.getSessionId()); } catch (e) { busyErr = e.message; }
check('运行中会话禁止删除', /进行中/.test(busyErr), busyErr);
rt.busy = false;

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
