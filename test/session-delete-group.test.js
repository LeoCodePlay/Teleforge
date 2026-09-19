// 工作区分组批量删除测试(任务列表分组头右键 / 触屏长按 →「删除分组」):
// - deleteSessions 一次删掉整组会话,返回实际删除的 id
// - 组内任一会话在运行 → 整组拒绝,且一个都不删(不做删一半的中间态)
// - 删掉活跃会话所在分组:活跃收敛到剩余会话;全删光则自动新建空会话接住
// - 空列表 / 非数组入参是空操作,不会把活跃会话挤掉
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-delgroup-'));
const { Agent } = await import('../server/agent/agent.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

const events = [];
const agent = new Agent({ emit: (e, p) => events.push([e, p]) });
const saw = (ev) => events.some(([e, p]) => e === 'agent' && p && p.event === ev);
const ids = (list) => list.map((s) => s.id);

// 场景 1:一次删掉整组 3 个会话中的 2 个,返回实际删除的 id
const a = agent.createSession('A');
const b = agent.createSession('B');
const c = agent.createSession('C');
agent.switchSession(a.id);
const before = ids(agent.listSessions());
const removed = agent.deleteSessions([a.id, b.id]);
check('批量删除返回实际删除的 id', JSON.stringify(removed) === JSON.stringify([a.id, b.id]), JSON.stringify(removed));
check('组内会话已全部删除', !agent.listSessions().some((s) => [a.id, b.id].includes(s.id)));
check('未列入该组的会话保留', agent.listSessions().some((s) => s.id === c.id));
check('其余会话数量不变', agent.listSessions().length === before.length - 2, `${before.length} -> ${agent.listSessions().length}`);
check('删掉活跃会话后活跃收敛到剩余会话', agent.listSessions().some((s) => s.id === agent.getSessionId()), String(agent.getSessionId()));
check('批量删除广播 sessions_changed', saw('sessions_changed'));

// 场景 2:组内有运行中的会话 → 整组拒绝,一个都不删
const d = agent.createSession('D');
agent._runtimes.get(d.id).busy = true;
let busyErr = '';
try { agent.deleteSessions([c.id, d.id]); } catch (e) { busyErr = e.message; }
check('组内有运行中会话时整组拒绝', /进行中/.test(busyErr), busyErr);
check('拒绝后整组一个都没删',
  agent.listSessions().some((s) => s.id === c.id) && agent.listSessions().some((s) => s.id === d.id),
  JSON.stringify(ids(agent.listSessions())));
agent._runtimes.get(d.id).busy = false;

// 场景 3:删光当前列表里的全部会话(含活跃)→ 自动新建空会话接住活跃,不收敛到 null
agent.switchSession(d.id);
agent.deleteSessions(ids(agent.listSessions()));
const left = agent.listSessions();
check('全删光后自动新建空会话接住活跃',
  left.length === 1 && (left[0].msgCount ?? 0) === 0 && agent.getSessionId() === left[0].id,
  JSON.stringify(left));

// 场景 4:空列表是空操作(前端在分组为空时不发起,这里兜底)
const keep = agent.getSessionId();
check('空 id 列表返回空数组', JSON.stringify(agent.deleteSessions([])) === '[]');
check('空列表不影响活跃会话', agent.getSessionId() === keep);

// 场景 5:非数组入参不炸(防御:RPC 消息体可能缺字段)
check('非数组入参按空处理', JSON.stringify(agent.deleteSessions(undefined)) === '[]');

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
