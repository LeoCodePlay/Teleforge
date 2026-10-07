// 变更对比「行模型」的测试(纯函数,无 DOM):
// 行号编号、并排配对、行数预算这三条是 diff 视图正确性的全部底座,而且都容易在边界上出错,
// 所以穷举在测试里,组件里只负责画。
// 运行:node test/changes-diff-rows.test.js
import {
  MAX_RENDERED_LINES, diffCounts, hunkHeader, hunkRows, renderPlan, splitRows
} from '../web/src/components/ChangesReview/diffRows.ts';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

// hunk 构造器:lines 已带前缀
const hunk = (oldStart, newStart, lines) => ({
  oldStart, newStart,
  oldLines: lines.filter((l) => l[0] !== '+').length,
  newLines: lines.filter((l) => l[0] !== '-').length,
  lines
});

console.log('\n[一] 统一视图行号');
{
  const h = hunk(3, 3, [' a', '-b', '+B', ' c']);
  const rows = hunkRows(h);
  check('行数不变', rows.length === 4);
  check('上下文两侧行号一致', rows[0].old === 3 && rows[0].new === 3 && rows[0].kind === 'context', JSON.stringify(rows[0]));
  check('删除只占旧侧', rows[1].kind === 'del' && rows[1].old === 4 && rows[1].new === undefined, JSON.stringify(rows[1]));
  check('新增只占新侧', rows[2].kind === 'add' && rows[2].new === 4 && rows[2].old === undefined, JSON.stringify(rows[2]));
  check('后续上下文两侧都推进', rows[3].old === 5 && rows[3].new === 5, JSON.stringify(rows[3]));
  check('正文去掉前缀', rows[1].text === 'b' && rows[2].text === 'B', JSON.stringify(rows.map((r) => r.text)));
}
{
  const rows = hunkRows(hunk(1, 1, ['+x', '+y']));
  check('纯新增:旧侧全 undefined', rows.every((r) => r.old === undefined) && rows[1].new === 2);
}
{
  const rows = hunkRows(hunk(1, 1, ['-x', '-y']));
  check('纯删除:新侧全 undefined', rows.every((r) => r.new === undefined) && rows[1].old === 2);
}

console.log('\n[二] 并排配对');
{
  const rows = splitRows(hunk(1, 1, ['-a', '-b', '+A', '+B', ' k']));
  check('两删两增配成两行 + 一行上下文', rows.length === 3, JSON.stringify(rows));
  check('第一行左删右增', rows[0].left.kind === 'del' && rows[0].right.kind === 'add' && rows[0].left.text === 'a' && rows[0].right.text === 'A');
  check('第二行同样配对', rows[1].left.text === 'b' && rows[1].right.text === 'B');
  check('上下文两侧同排且行号相同', rows[2].left.kind === 'context' && rows[2].right.kind === 'context' && rows[2].left.no === 3 && rows[2].right.no === 3, JSON.stringify(rows[2]));
}
{
  const rows = splitRows(hunk(1, 1, ['-a', '-b', '+A']));
  check('删多增少:短侧留空(undefined)', rows.length === 2 && rows[1].right === undefined && rows[1].left.text === 'b', JSON.stringify(rows));
}
{
  const rows = splitRows(hunk(1, 1, ['-a', '+A', '+B']));
  check('增多少删:多出来的一格只在右', rows.length === 2 && rows[1].left === undefined && rows[1].right.text === 'B', JSON.stringify(rows));
}
{
  const rows = splitRows(hunk(1, 1, ['-a', ' x', '+b']));
  check('删除与新增被上下文隔开时不跨行配对', rows.length === 3
    && rows[0].right === undefined && rows[1].left.kind === 'context' && rows[2].left === undefined, JSON.stringify(rows));
}

console.log('\n[三] 行号起点(拿真实 hunk 形状核对)');
{
  // @@ -10,3 +20,3 @@ 的形态:起点分别是 10 / 20
  const rows = hunkRows(hunk(10, 20, [' a', '-b', '+B']));
  check('旧侧从 oldStart 起', rows[0].old === 10 && rows[1].old === 11);
  check('新侧从 newStart 起', rows[0].new === 20 && rows[2].new === 21);
}

console.log('\n[四] 行数预算(5000 行,头尾各留一半)');
{
  check('上限常量与 dsh 一致', MAX_RENDERED_LINES === 5000);
  const small = [hunk(1, 1, ['+a', '+b'])];
  const plan = renderPlan(small);
  check('未超限:原样渲染且不标截断', plan.truncated === false && plan.omitted === 0 && plan.hunks === small);

  const many = Array.from({ length: 600 }, (_, i) => hunk(1, 1, ['+line' + i]));
  const p2 = renderPlan(many, 100);
  const rendered = p2.hunks.reduce((n, h) => n + h.lines.length, 0);
  check('超限:渲染行数不超过预算', rendered <= 100, `rendered=${rendered}`);
  check('超限被标记且给出省略行数', p2.truncated === true && p2.omitted === 500, `omitted=${p2.omitted}`);
  check('头部保留第一行', p2.hunks[0].lines[0] === '+line0');
  check('尾部保留最后一行', p2.hunks[p2.hunks.length - 1].lines.slice(-1)[0] === '+line599');
}
{
  // 单个 hunk 自身就超预算:必须能切进预算内,而不是整块塞进去
  const huge = [hunk(1, 1, Array.from({ length: 50 }, (_, i) => '+' + i))];
  const p = renderPlan(huge, 10);
  check('单个超大 hunk 也被切到预算内', p.hunks.reduce((n, h) => n + h.lines.length, 0) <= 10 && p.truncated === true);
}

console.log('\n[五] 头文案与增删统计');
{
  check('hunk 头与统一 diff 同形', hunkHeader(hunk(3, 3, [' a', '-b', '+B'])) === '@@ -3,2 +3,2 @@', hunkHeader(hunk(3, 3, [' a', '-b', '+B'])));
  const c = diffCounts([hunk(1, 1, [' a', '-b', '+B', '+C'])]);
  check('增删行数只看前缀', c.added === 2 && c.deleted === 1, JSON.stringify(c));
  check('空 hunk 统计为 0', JSON.stringify(diffCounts([])) === '{"added":0,"deleted":0}');
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
