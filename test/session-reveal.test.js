// 任务列表「当前会话行」可见性测试:
// - 组内切片:当前会话排在第 8 位时不能被「查看更多」压住(压住了它不在 DOM 里,滚也够不着);
// - 列表滚动:目标行在可视区外才滚,在区内不动(不打扰正在翻看别处的用户),
//   顶部还要让开 sticky 的分区工具行,否则「滚到了但被盖住」。
import { groupVisibleCount, revealScrollTop } from '../web/src/utils/sessionReveal.ts';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

// ---- 组内可见条数(水位线)----
check('当前会话在组内第 1 位:仍是基线 5 条', groupVisibleCount(5, 0) === 5);
check('当前会话在组内第 3 位:仍是基线 5 条', groupVisibleCount(5, 2) === 5);
check('当前会话在组内第 8 位:抬到 8 条(不被「查看更多」藏住)', groupVisibleCount(5, 7) === 8);
check('当前会话在组内第 12 位:抬到 12 条', groupVisibleCount(5, 11) === 12);
check('当前会话不在本组(focusIndex=-1):不抬水位线', groupVisibleCount(5, -1) === 5);
check('用户点过「查看更多」(15 条)时不低于已累积的条数', groupVisibleCount(15, 7) === 15);
check('用户点过「查看更多」但当前会话更靠后:取更大的那个', groupVisibleCount(15, 21) === 22);

// ---- 列表滚动 ----
// 可视区 100~400,顶部吸附工具行 30px → 有效区间 134(100+30+4) ~ 396(400-4)
const list = (rowTop, rowBottom, current = 0) => revealScrollTop(current, {
  viewTop: 100, viewBottom: 400, rowTop, rowBottom, stickyTop: 30
});

check('行在可视区中间:不动列表', list(200, 233) === null);
check('行正好贴在上边界的余量内:不动', list(134, 167) === null);
check('行正好贴在下边界的余量内:不动', list(363, 396) === null);
check('行在可视区上方:向上滚回行顶对齐', list(60, 93, 200) === 126, String(list(60, 93, 200)));
check('行在可视区下方:向下滚到行底对齐', list(500, 533) === 137);
check('行被 sticky 工具行盖住(在可视区内但顶到了吸附层):也要滚下来', list(110, 143, 100) === 76, String(list(110, 143, 100)));
check('滚动量不会算成负数(scrollTop 从 0 起)', revealScrollTop(3, {
  viewTop: 100, viewBottom: 400, rowTop: 20, rowBottom: 53, stickyTop: 30
}) === 0);

// 余量可调(组件按需传,默认 4)
check('余量为 0 时贴边即算可见', revealScrollTop(0, {
  viewTop: 100, viewBottom: 400, rowTop: 130, rowBottom: 163, stickyTop: 30, pad: 0
}) === null);
check('余量为 0 时超出 1px 就要滚', revealScrollTop(10, {
  viewTop: 100, viewBottom: 400, rowTop: 129, rowBottom: 162, stickyTop: 30, pad: 0
}) === 9, String(revealScrollTop(10, {
  viewTop: 100, viewBottom: 400, rowTop: 129, rowBottom: 162, stickyTop: 30, pad: 0
})));

console.log(`\nsession-reveal: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
