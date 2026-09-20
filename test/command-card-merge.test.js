// mergeTrailingCommandCards 单测:整表重拉历史时命令卡的去留规则。
// 背景 1:/compact 成功时服务端广播 history_compacted,前端重拉历史并整表替换消息数组
// (压缩后的 turns 里没有命令卡这一条)。命令卡是纯前端消息(不持久化),若直接丢掉,
// 「已压缩 N 条早期消息…」的完成反馈就没了,patchCmd 也变成空操作。
// 背景 2(线上回归):重拉出来的历史里已经带了持久压缩标记行(CompactionRow)时,再把命令卡
// 接回去,底部就会并排出现两条「已压缩 N 条早期消息」;而命令卡不持久化,切走会话再切回
// 又只剩标记行——同一件事的记录数量前后不一致。所以新历史已含压缩标记行时,命令卡让位。
import { mergeTrailingCommandCards } from '../web/src/utils/commandCard.ts';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

const card = (cmdId, state = 'running', text = '') => ({ role: 'command', cmdId, command: { name: 'compact', state, text } });
const msg = (content) => ({ role: 'user', content });
const compactionRow = { role: 'user', content: '【上下文已手动压缩】…', compaction: { dropCount: 833, manual: true } };
const hist = [msg('早1'), msg('早2'), { role: 'assistant', content: '回答' }];

// ---- 1. 新历史没有压缩标记行(兜底路径):尾部命令卡接回,顺序与内容都不变 ----
{
  const cur = [...hist, card(7)];
  const out = mergeTrailingCommandCards(hist, cur);
  check('历史原样在前', out.length === hist.length + 1 && out[0] === hist[0] && out[hist.length - 1] === hist[hist.length - 1]);
  check('命令卡接在末尾', out[out.length - 1] === cur[cur.length - 1]);
  check('cmdId/状态保留', out[out.length - 1].cmdId === 7 && out[out.length - 1].command.state === 'running');
}

// ---- 2. 新历史已含持久压缩标记行:命令卡让位,只留标记行一条记录 ----
{
  const histWithRow = [...hist, compactionRow];
  const cur = [...hist, card(7, 'ok', '已压缩 833 条早期消息,上下文空间已释放')];
  const out = mergeTrailingCommandCards(histWithRow, cur);
  check('命令卡不再接回(避免两条压缩记录)', !out.some((m) => m.command), JSON.stringify(out.map((m) => m.command ?? m.compaction ?? m.role)));
  check('压缩标记行原样保留', out[out.length - 1] === compactionRow);
  check('返回的就是新历史本身', out === histWithRow);
}

// ---- 3. 两种时序都不丢结果(无标记行的兜底路径) ----
{
  const cur = [...hist, card(7, 'ok', '已压缩 833 条早期消息,上下文空间已释放')];
  const out = mergeTrailingCommandCards(hist, cur);
  check('先 patch 后重拉:完成态文案保留', out[out.length - 1].command.state === 'ok' && out[out.length - 1].command.text.includes('已压缩 833 条'));

  const cur2 = [...hist, card(9)];
  const merged = mergeTrailingCommandCards(hist, cur2);
  const patched = merged.map((m) => (m.cmdId === 9 ? { ...m, command: { name: 'compact', state: 'ok', text: '已压缩 5 条早期消息,上下文空间已释放' } } : m));
  const last = patched[patched.length - 1];
  check('先重拉后 patch:patchCmd 仍命中 cmdId', last.command.state === 'ok' && last.command.text.includes('已压缩 5 条'));
}

// ---- 4. 不把历史遗留(非尾部)的命令卡翻出来 ----
{
  const cur = [card(1, 'ok', '上一轮结果'), msg('之后的用户消息'), card(2)];
  const out = mergeTrailingCommandCards(hist, cur);
  check('只取末尾连续段:旧卡不复活', out.length === hist.length + 1 && out[out.length - 1].cmdId === 2, JSON.stringify(out.map((m) => m.cmdId ?? m.role)));
}

// ---- 5. 没有命令卡:原样返回新历史(不追加空卡) ----
{
  const out = mergeTrailingCommandCards(hist, hist);
  check('无命令卡时返回新历史本身', out === hist && out.length === hist.length);
  check('空输入不抛错', mergeTrailingCommandCards([], []).length === 0);
  check('null 输入不抛错', mergeTrailingCommandCards(null, null).length === 0 && mergeTrailingCommandCards(hist, null) === hist);
}

// ---- 6. 纯函数:不改写入参 ----
{
  const cur = [...hist, card(3)];
  const before = JSON.stringify(cur);
  mergeTrailingCommandCards(hist, cur);
  check('入参未被改写', JSON.stringify(cur) === before);
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
