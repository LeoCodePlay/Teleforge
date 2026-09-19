// 任务列表活跃排序测试:排序必须按"用户最后发消息的时间",而不是最后一次事件落盘时间。
// 否则 AI 每回复一轮就把会话顶到最前,列表顺序一直变来变去。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-order-'));
const sessions = await import('../server/store/session-store.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

const t0 = Date.now() - 60_000;
const userMsg = (time, text) => ({ seq: 0, time, type: 'user/message', data: { source: 'user', display: text, content: text } });
const asstMsg = (time) => ({ seq: 1, time, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: '回复' } } });

const A = sessions.create('会话A', 'local');
const B = sessions.create('会话B', 'local');

// A 先发消息(t0),B 后发(t0+1000):B 应排在 A 前
const aUser = userMsg(t0, 'A 的提问');
const bUser = userMsg(t0 + 1000, 'B 的提问');
sessions.saveEvents(A.id, [aUser]);
sessions.saveEvents(B.id, [bUser]);
let order = sessions.list('local').map((s) => s.id);
check('后发消息的会话排在前', order.indexOf(B.id) < order.indexOf(A.id), JSON.stringify(order));

// 模拟 A 的 AI 回复:追加更晚的 assistant 事件后再次落盘(A 的 updatedAt 变成最新)。
// 修复前 A 会因此被顶到最前;修复后排序键(lastUserAt)不变,顺序必须保持。
sessions.saveEvents(A.id, [aUser, asstMsg(t0 + 2000)]);
order = sessions.list('local').map((s) => s.id);
check('AI 回复不改变排序(A 仍在 B 后)', order.indexOf(B.id) < order.indexOf(A.id), JSON.stringify(order));
check('A 的活跃排序键未被 AI 回复推进',
  sessions.list().find((s) => s.id === A.id)?.lastUserAt === t0,
  JSON.stringify(sessions.list().find((s) => s.id === A.id)));

// 用户再次给 A 发消息:A 应立刻回到最前
const aUser2 = userMsg(t0 + 3000, 'A 的新提问');
sessions.saveEvents(A.id, [aUser, asstMsg(t0 + 2000), aUser2]);
order = sessions.list('local').map((s) => s.id);
check('用户再次发消息后 A 回到最前', order.indexOf(A.id) < order.indexOf(B.id), JSON.stringify(order));

// 运行中注入(steer)不是用户发消息,不应推进排序键
sessions.saveEvents(A.id, [aUser, asstMsg(t0 + 2000), aUser2, userMsg(t0 + 4000, '注入')].map((e, i) =>
  i === 3 ? { ...e, data: { ...e.data, source: 'steer' } } : e));
check('steer 注入不推进活跃排序键',
  sessions.list().find((s) => s.id === A.id)?.lastUserAt === t0 + 3000,
  JSON.stringify(sessions.list().find((s) => s.id === A.id)));

console.log(`\nsession-order: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
