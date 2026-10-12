// mergeHistoryKeepingLiveTurn 单测:压缩成功后重拉历史时保住本轮正在流式的回复气泡。
//
// 线上现象:手动压缩(/compact)摘要还在生成时用户又发了一条任务(界面显示「等待执行」)。
// 压缩成功后那条任务确实离开了待执行队列、消息也上屏了,但 agent 再也没回复 —— 等多久都没有。
// 根因:服务端 compactNow 的 finally 在压缩结束的那一刻就把排队的消息派发出去(pending -> inbox
// -> drive),`start` 已经发出、本轮用户消息已经落盘;而同一个 finally 之前广播的
// history_compacted 让前端重拉 get_history 并**整表替换**消息数组 —— 此刻服务端投影里还没有
// 本轮的 assistant 行(模型还没吐出任何内容),替换把 start 刚推入的流式气泡一起抹掉了。
// 之后 text/reasoning/tool/收尾都只认「末尾 assistant」(tailAssistantIndex),末尾成了本轮那条
// 用户消息 → 整轮增量被静默丢弃:消息在、回复永远不来。
//
// 不变量:重拉历史之后,若本轮仍在流式(当前列表里有流式回复气泡、且本轮未收尾),
// tailAssistantIndex(合并结果) 必须仍然指向本轮的回复气泡(后续增量有落点)。
import { mergeHistoryKeepingLiveTurn } from '../web/src/utils/liveTurn.ts';
import { mergeTrailingCommandCards } from '../web/src/utils/commandCard.ts';
import { tailAssistantIndex } from '../web/src/utils/compactionOrder.ts';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

const user = (content, extra = {}) => ({ role: 'user', content, time: 1, ...extra });
const assistant = (content, extra = {}) => ({ role: 'assistant', segments: content ? [{ kind: 'text', text: content }] : [], ...extra });
const live = (content = '') => assistant(content, { streaming: true });
const marker = { role: 'user', content: '【上下文已手动压缩】…', compaction: { dropCount: 833, manual: true } };
const card = (cmdId, state = 'ok') => ({ role: 'command', cmdId, command: { name: 'compact', state, text: '已压缩 833 条早期消息' } });
// 压缩发生前的历史(服务端投影)
const early = [user('早1'), assistant('回答1'), user('早2'), assistant('回答2')];

// ---- 1. 本次故障时序:压缩结束就派发了排队的消息,重拉回来的历史还没有本轮 assistant 行 ----
{
  const queued = '下一条任务:把刚才的改动补上测试';
  const hist = [...early, marker, user(queued)];        // 重拉结果:有本轮用户行,还没有回复行
  const cur = [...early, marker, user(queued), live()];  // 实时列表:start 已推入用户气泡 + 流式回复气泡
  const out = mergeHistoryKeepingLiveTurn(hist, cur, { turnClosed: false });
  check('合并结果仍以本轮的流式回复气泡结尾', out[out.length - 1]?.role === 'assistant' && out[out.length - 1].streaming === true,
    JSON.stringify(out.map((m) => [m.role, m.streaming === true])));
  check('后续增量有落点(tailAssistantIndex >= 0)', tailAssistantIndex(out) === out.length - 1, String(tailAssistantIndex(out)));
  check('新的历史内容(含压缩标记行)都在', out.some((m) => m.compaction) && out.filter((m) => m.role === 'user').length === 4);
  check('用户行没有被重复塞进去', out.filter((m) => m.role === 'user' && m.content === queued).length === 1);
  // 对照:旧行为(只合并命令卡)会把流式气泡抹掉,增量无处可落 —— 这正是线上"永远不回复"的样子
  check('【对照】旧行为确实把流式气泡抹掉了(增量会被静默丢弃)',
    tailAssistantIndex(mergeTrailingCommandCards(hist, cur)) < 0);
}

// ---- 2. 历史里已经有本轮的回复行(模型已吐出过内容):接着它往下流,不重复生成一行 ----
{
  const queued = '排队的那条';
  const hist = [...early, marker, user(queued), assistant('已经流了一些')];
  const cur = [...early, marker, user(queued), live('已经流了一些')];
  const out = mergeHistoryKeepingLiveTurn(hist, cur, { turnClosed: false });
  check('末尾回复行被标回流式', out[out.length - 1].role === 'assistant' && out[out.length - 1].streaming === true);
  check('没有多出一行 assistant', out.filter((m) => m.role === 'assistant').length === 3,
    String(out.filter((m) => m.role === 'assistant').length));
}

// ---- 3. 重拉响应早于派发(历史里连本轮用户行都没有):整段本轮一起接回 ----
{
  const queued = '刚发的任务';
  const hist = [...early, marker];                     // 还没投影出本轮
  const cur = [...early, marker, user(queued), live('')];
  const out = mergeHistoryKeepingLiveTurn(hist, cur, { turnClosed: false });
  check('本轮的用户行被接回(回复不脱离提问)', out[out.length - 2]?.role === 'user' && out[out.length - 2].content === queued,
    JSON.stringify(out.map((m) => m.role)));
  check('本轮的流式回复气泡被接回', out[out.length - 1]?.streaming === true);
  check('尾部仍是回复行,增量有落点', tailAssistantIndex(out) === out.length - 1);
}

// ---- 4. 本轮已收尾:不做保活(陈旧重放不能让已完成的气泡再亮起来) ----
{
  const queued = '排队的那条';
  const hist = [...early, marker, user(queued)];
  const cur = [...early, marker, user(queued), live('')];
  const out = mergeHistoryKeepingLiveTurn(hist, cur, { turnClosed: true });
  check('已收尾时返回的就是新历史', out === mergeTrailingCommandCards(hist, cur) && !out.some((m) => m.streaming));
}

// ---- 5. 没有在跑的轮(普通重拉):与旧行为完全等价 ----
{
  const hist = [...early, marker];
  const cur = [...early, marker, card(7)];
  const out = mergeHistoryKeepingLiveTurn(hist, cur, { turnClosed: true });
  check('无流式气泡时=原有合并结果', JSON.stringify(out) === JSON.stringify(mergeTrailingCommandCards(hist, cur)));
  check('无流式气泡 + 未收尾也=原有合并结果',
    JSON.stringify(mergeHistoryKeepingLiveTurn(hist, cur, { turnClosed: false })) === JSON.stringify(mergeTrailingCommandCards(hist, cur)));
}

// ---- 6. 命令卡规则不回归(新历史已含压缩标记行 → 命令卡让位)----
{
  const hist = [...early, marker];
  const cur = [...early, marker, card(7)];
  const out = mergeHistoryKeepingLiveTurn(hist, cur, { turnClosed: false });
  check('命令卡不再接回(避免两条压缩记录)', !out.some((m) => m.command));
  check('压缩标记行保留', out[out.length - 1] === marker);
}

// ---- 7. 纯函数:不改写入参 ----
{
  const queued = '排队的那条';
  const hist = [...early, marker, user(queued)];
  const cur = [...early, marker, user(queued), live('')];
  const beforeHist = JSON.stringify(hist), beforeCur = JSON.stringify(cur);
  mergeHistoryKeepingLiveTurn(hist, cur, { turnClosed: false });
  check('历史入参未被改写', JSON.stringify(hist) === beforeHist);
  check('当前列表入参未被改写', JSON.stringify(cur) === beforeCur);
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
