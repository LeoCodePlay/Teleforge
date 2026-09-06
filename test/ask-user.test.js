// 用户提问(ask-user)契约测试:
// - ask_user_list 返回全部挂起提问(前端刷新后恢复面板的数据源)
// - 作答/取消后从挂起清单移除,并广播 ask_user_cancelled
// - 断开宽限:arm 后宽限期内 pending 保留(disarm 解除则不作废),到点统一作废
import {
  askUserQuestion, answerAskUser, rejectAskUser,
  listPendingAsks, armAskUserDisconnectGrace, disarmAskUserDisconnectGrace
} from '../server/agent/ask-user.ts';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. 提出 -> 挂起清单可见(含 sid 与规范化题面) ----
const events = [];
const p1 = askUserQuestion({
  questions: [{ id: 'a', question: '发布到哪个环境?', options: [{ label: 'prod' }, { label: 'staging' }] }],
  sid: 's1',
  emit: (type, m) => events.push({ type, m })
});
await sleep(0);
check('提出后广播 ask_user 事件', events.some((e) => e.type === 'agent' && e.m.event === 'ask_user' && e.m.sid === 's1'));
const listed = listPendingAsks();
check('ask_user_list 返回该挂起提问', listed.length === 1 && listed[0].askId === events[0].m.askId && listed[0].sid === 's1' && listed[0].questions.length === 1, JSON.stringify(listed));

// ---- 2. 作答 -> resolve + 移除 + 广播 cancelled ----
let answered = null;
p1.then((v) => { answered = v; });
const hit = answerAskUser(events[0].m.askId, [{ id: 'a', selected: ['prod'] }]);
await sleep(0);
check('answerAskUser 命中并 resolve', hit === true && Array.isArray(answered) && answered[0]?.selected?.[0] === 'prod');
check('作答后挂起清单为空', listPendingAsks().length === 0);
check('作答后广播 ask_user_cancelled', events.some((e) => e.type === 'agent' && e.m.event === 'ask_user_cancelled' && e.m.askId === events[0].m.askId));

// ---- 3. 取消 -> reject + 移除 ----
const p2 = askUserQuestion({ questions: [{ question: '端口?' }], sid: 's2', emit: () => {} });
await sleep(0);
const listed2 = listPendingAsks();
check('第二个提问进入挂起清单', listed2.length === 1 && listed2[0].sid === 's2');
let err2 = null;
p2.catch((e) => { err2 = e; });
const hit2 = rejectAskUser(listed2[0].askId);
await sleep(0);
check('rejectAskUser 命中并 reject', hit2 === true && err2 instanceof Error && listPendingAsks().length === 0);

// ---- 4. 断开宽限:arm 后到点作废;disarm 解除则保留 ----
const p3 = askUserQuestion({ questions: [{ question: '等待恢复' }], sid: 's3', emit: () => {} });
await sleep(0);
armAskUserDisconnectGrace('测试宽限到期', 40);
disarmAskUserDisconnectGrace();
await sleep(80);
check('disarm 解除后宽限到点不作废', listPendingAsks().length === 1);
let err3 = null;
p3.catch((e) => { err3 = e; });
armAskUserDisconnectGrace('测试宽限到期', 40);
await sleep(90);
check('宽限到点统一作废挂起提问', listPendingAsks().length === 0 && err3 instanceof Error && /测试宽限到期/.test(err3.message));

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
