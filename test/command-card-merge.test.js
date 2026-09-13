// mergeTrailingCommandCards 单测:/compact 成功后重拉历史时,底部命令卡不能丢。
// 回归背景:history_compacted 处理会整表替换消息数组,而命令卡是纯前端消息(不持久化),
// 于是「/compact 正在压缩当前会话上下文…」被抹掉、底部再也看不到「已压缩 N 条早期消息…」
// ——命令卡的 ok 态 patchCmd 要么打在即将被替换的数组上,要么因 cmdId 已不存在变成空操作。
// 规则:重拉历史时把当前列表末尾连续的命令卡原样接回,保留 cmdId 与状态。
import { mergeTrailingCommandCards } from '../web/src/utils/commandCard.ts';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

const card = (cmdId, state = 'running', text = '') => ({ role: 'command', cmdId, command: { name: 'compact', state, text } });
const msg = (content) => ({ role: 'user', content });
const hist = [msg('早1'), msg('早2'), { role: 'assistant', content: '回答' }];

// ---- 1. 尾部命令卡接回:历史在前、命令卡在后,顺序与内容都不变 ----
{
  const cur = [...hist, card(7)];
  const out = mergeTrailingCommandCards(hist, cur);
  check('历史原样在前', out.length === hist.length + 1 && out[0] === hist[0] && out[hist.length - 1] === hist[hist.length - 1]);
  check('命令卡接在末尾', out[out.length - 1] === cur[cur.length - 1]);
  check('cmdId/状态保留', out[out.length - 1].cmdId === 7 && out[out.length - 1].command.state === 'running');
}

// ---- 2. 两种时序都不丢结果 ----
{
  // 先 patch(ok) 后重拉:接回的是完成态
  const cur = [...hist, card(7, 'ok', '已压缩 833 条早期消息,上下文空间已释放')];
  const out = mergeTrailingCommandCards(hist, cur);
  check('先 patch 后重拉:完成态文案保留', out[out.length - 1].command.state === 'ok' && out[out.length - 1].command.text.includes('已压缩 833 条'));

  // 先重拉后 patch:cmdId 还在,patchCmd 的 map 仍能命中并落完成态
  const cur2 = [...hist, card(9)];
  const merged = mergeTrailingCommandCards(hist, cur2);
  const patched = merged.map((m) => (m.cmdId === 9 ? { ...m, command: { name: 'compact', state: 'ok', text: '已压缩 5 条早期消息,上下文空间已释放' } } : m));
  const last = patched[patched.length - 1];
  check('先重拉后 patch:patchCmd 仍命中 cmdId', last.command.state === 'ok' && last.command.text.includes('已压缩 5 条'));
}

// ---- 3. 不把历史遗留(非尾部)的命令卡翻出来 ----
{
  const cur = [card(1, 'ok', '上一轮结果'), msg('之后的用户消息'), card(2)];
  const out = mergeTrailingCommandCards(hist, cur);
  check('只取末尾连续段:旧卡不复活', out.length === hist.length + 1 && out[out.length - 1].cmdId === 2, JSON.stringify(out.map((m) => m.cmdId ?? m.role)));
}

// ---- 4. 没有命令卡:原样返回新历史(不追加空卡) ----
{
  const out = mergeTrailingCommandCards(hist, hist);
  check('无命令卡时返回新历史本身', out === hist && out.length === hist.length);
  check('空输入不抛错', mergeTrailingCommandCards([], []).length === 0);
  check('null 输入不抛错', mergeTrailingCommandCards(null, null).length === 0 && mergeTrailingCommandCards(hist, null) === hist);
}

// ---- 5. 纯函数:不改写入参 ----
{
  const cur = [...hist, card(3)];
  const before = JSON.stringify(cur);
  mergeTrailingCommandCards(hist, cur);
  check('入参未被改写', JSON.stringify(cur) === before);
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
