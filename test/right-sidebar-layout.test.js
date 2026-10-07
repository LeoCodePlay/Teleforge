// 右栏分栏引擎的单测(真引擎 = web/src/dsh/ui-dockkit/engine/*;宿主 = components/RightSidebar)
//
// 为什么这个引擎必须单测:布局是**可持久化**的状态 —— RightSidebar 把 dockkit 记下的
// LayoutOp[] 存进 localStorage(teleforge.sidebar-right.layout.v2),下次挂载时重放它。
// 坏数据/坏 op 会渲染出一棵破树,而破树的症状(标签消失、点不开、栏位挤没)在界面上极难定位;
// 纯函数能在这里穷举掉。重点锁定四条:
//   1. 内容身份 (kind, contentId) —— 重复打开只聚焦,不重复开标签;
//   2. 关掉最后一个标签要把空 pane 合并掉,不留空栏;
//   3. 每个 op 的**逆 op 必须真的能还原**(撤销 / 持久化回放都靠它);
//   4. 尺寸必须夹紧(分数、每侧不低于下限、和为 1)。
//
// 历史:本文件原先指向 components/RightSidebar/layout.ts(自研两栏引擎),那个模块最终由
// dockkit 的 engine 取代(分屏/浮动/拖拽/序列回放都在里面),所以这里改为直接测真引擎,
// 断言口径随引擎常量对齐:栏数上限 MAX_DOCK_PANES=4、每侧下限 MIN_PANE_FRACTION=0.12
// (见 engine/constraints.ts),不再假设"最多两栏/下限 0.2"。
// 运行:node test/right-sidebar-layout.test.js
const O = await import('../web/src/dsh/ui-dockkit/engine/operations.ts');
const P = await import('../web/src/dsh/ui-dockkit/engine/planner.ts');
const C = await import('../web/src/dsh/ui-dockkit/engine/constraints.ts');
const I = await import('../web/src/dsh/ui-dockkit/engine/initial.ts');
const T = await import('../web/src/dsh/ui-dockkit/engine/tree.ts');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

/** 引擎要求"新 id 由调用方铸造并写进 op 里"(这样回放才能逐字还原),测试里给个自增源 */
let seq = 0;
const mint = () => `x${++seq}`;
const tab = (id, kind, contentId, title = id) => ({ id, kind, contentId, title });
const apply = (s, op) => O.applyOp(s, op).state;
const fresh = () => I.createInitialState(I.createIdMinter(), undefined, 'push');
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
/** 规范化视图:引擎为了让逆 op 能还原,会把删掉的节点留成 null 占位,比较时只取真实存在的部分 */
const snapshot = (st) => JSON.stringify({
  root: st.rootId,
  active: st.activePaneId,
  expanded: st.expanded,
  mode: st.mode,
  panes: T.dockPaneIds(st).map((id) => ({ id, tabs: [...T.getPane(st, id).tabs], active: T.getPane(st, id).activeTabId })),
  splits: Object.values(st.nodes)
    .filter((n) => n && n.kind === 'split')
    .map((n) => ({ id: n.id, axis: n.axis, children: [...n.children], sizes: [...n.sizes] }))
    .sort((a, b) => (a.id < b.id ? -1 : 1)),
  tabs: Object.entries(st.tabs).filter(([, v]) => v).map(([k, v]) => [k, v.kind, v.contentId]).sort(),
});

console.log('\n[一] 初始状态');
{
  const s = fresh();
  check('恰好一个 pane', T.dockPaneIds(s).length === 1);
  check('没有标签', Object.keys(s.tabs).length === 0);
  check('默认折叠', s.expanded === false);
  check('root 就是活动栏', s.rootId === s.activePaneId);
}

console.log('\n[二] 内容身份 (kind, contentId) 幂等');
{
  let s = fresh();
  const p1 = s.activePaneId;
  s = apply(s, { type: 'openTab', paneId: p1, tab: tab('t1', 'file', 'a.md'), index: 0 });
  check('开一个标签', Object.keys(s.tabs).length === 1);
  check('active 指向它', T.getPane(s, s.activePaneId).activeTabId === 't1');
  check('按内容身份能找到它', P.findContentTab(s, 'a.md', 'file') === 't1', String(P.findContentTab(s, 'a.md', 'file')));
  check('同内容同 kind 查到的是同一个(调用方据此只聚焦、不新增)',
    P.findContentTab(s, 'a.md', 'file') === 't1');
  check('同 contentId 不同 kind 是不同内容', P.findContentTab(s, 'a.md', 'diff') === undefined);
  check('分栏内查找同样命中', P.findPaneContentTab(s, p1, 'a.md', 'file') === 't1');
  check('未知内容查不到', P.findContentTab(s, 'nope.md', 'file') === undefined);

  s = apply(s, { type: 'openTab', paneId: p1, tab: tab('t2', 'file', 'b.md'), index: 1 });
  check('不同内容新增标签', Object.keys(s.tabs).length === 2);
  check('最新打开的成为 active', T.getPane(s, s.activePaneId).activeTabId === 't2');
}

console.log('\n[三] 关闭标签:退位与空栏合并');
{
  let s = fresh();
  const p1 = s.activePaneId;
  s = apply(s, { type: 'openTab', paneId: p1, tab: tab('t1', 'file', 'a.md'), index: 0 });
  s = apply(s, { type: 'openTab', paneId: p1, tab: tab('t2', 'file', 'b.md'), index: 1 });
  s = apply(s, { type: 'openTab', paneId: p1, tab: tab('t3', 'file', 'c.md'), index: 2 });
  s = apply(s, { type: 'closeTab', tabId: 't3' });
  check('关掉 active → 退到左侧邻居', T.getPane(s, p1).activeTabId === 't2', String(T.getPane(s, p1).activeTabId));
  s = apply(s, { type: 'closeTab', tabId: 't1' });
  check('关掉非 active 不影响 active', T.getPane(s, p1).activeTabId === 't2');
  check('标签被真正移除', !s.tabs.t1);
  check('剩下的标签还在', !!s.tabs.t2 && !s.tabs.t3);
}
{
  // 两栏:左栏关光 → planSettle 给出 merge,应用后不留空栏,标签不丢
  let s = fresh();
  const left = s.activePaneId;
  s = apply(s, { type: 'openTab', paneId: left, tab: tab('a1', 'file', 'a.md'), index: 0 });
  s = apply(s, {
    type: 'split', paneId: left, axis: 'row', direction: 'after',
    newPaneId: 'paneR', newSplitId: 'splitX',
  });
  check('分栏后有两个 pane', T.dockPaneIds(s).length === 2, JSON.stringify(T.dockPaneIds(s)));
  s = apply(s, { type: 'openTab', paneId: 'paneR', tab: tab('b1', 'file', 'b.md'), index: 0 });
  check('新标签开在指定栏', T.getPane(s, 'paneR').tabs.includes('b1'));
  s = apply(s, { type: 'closeTab', tabId: 'a1' });
  check('closeTab 只清标签,由 settle 决定树怎么收', T.dockPaneIds(s).length === 2 && T.getPane(s, left).tabs.length === 0);

  const plan = P.planSettle(s, mint);
  check('planSettle 给出"合并空栏"的 op',
    plan.some((op) => op.type === 'merge' && op.paneId === left), JSON.stringify(plan));
  let merged = s;
  for (const op of plan) merged = apply(merged, op);
  check('空栏被合并(不留空栏)', T.dockPaneIds(merged).length === 1, JSON.stringify(T.dockPaneIds(merged)));
  check('root 指向幸存的栏', merged.rootId === 'paneR', merged.rootId);
  check('幸存栏的标签还在', !!merged.tabs.b1 && T.getPane(merged, 'paneR').tabs.length === 1);
  check('活动栏跟着落到幸存栏', T.dockPaneIds(merged).includes(merged.activePaneId));
}

console.log('\n[四] 尺寸夹紧');
{
  check('正常比例原样保留', JSON.stringify(C.clampSizes([0.3, 0.7])) === JSON.stringify([0.3, 0.7]));
  const c1 = C.clampSizes([0.05, 0.95]);
  check('过小的一侧被抬到下限', Math.abs(c1[0] - C.MIN_PANE_FRACTION) < 1e-9, JSON.stringify(c1));
  check('抬升后仍和为 1', Math.abs(sum(c1) - 1) < 1e-9, JSON.stringify(c1));
  const c2 = C.clampSizes([2, 1]);
  check('未归一化的输入被归一化', Math.abs(sum(c2) - 1) < 1e-9 && Math.abs(c2[0] - 2 / 3) < 1e-9, JSON.stringify(c2));
  check('非法输入回落到对半', JSON.stringify(C.clampSizes([NaN, NaN])) === JSON.stringify([0.5, 0.5]));
  check('零和回落到对半', JSON.stringify(C.clampSizes([0, 0])) === JSON.stringify([0.5, 0.5]));
  check('长度为 1 时也自洽(单栏铺满)', Math.abs(sum(C.clampSizes([1])) - 1) < 1e-9, JSON.stringify(C.clampSizes([1])));

  // 拖分隔条提交的就是 planResizeSplit:它必须走同一套夹紧(否则能把一栏拖成 0 宽)
  let s = fresh();
  const p1 = s.activePaneId;
  s = apply(s, { type: 'openTab', paneId: p1, tab: tab('a1', 'file', 'a.md'), index: 0 });
  s = apply(s, {
    type: 'split', paneId: p1, axis: 'row', direction: 'after',
    newPaneId: 'paneR', newSplitId: 'splitX',
  });
  const ops = P.planResizeSplit('splitX', [0.01, 0.99]);
  check('planResizeSplit 把过小的比例夹紧',
    Math.abs(ops[0].sizes[0] - C.MIN_PANE_FRACTION) < 1e-9, JSON.stringify(ops[0].sizes));
  const rs = apply(s, ops[0]);
  check('resize 后的比例被夹紧',
    Math.abs(T.getSplit(rs, 'splitX').sizes[0] - C.MIN_PANE_FRACTION) < 1e-9,
    JSON.stringify(T.getSplit(rs, 'splitX').sizes));
  check('resize 不改标签归属', T.dockPaneIds(rs).length === 2 && !!rs.tabs.a1);
}

console.log('\n[五] 逆 op 必须能还原(撤销 / 持久化回放的基石)');
{
  const start = fresh();
  const base = start.activePaneId;
  const ops = [
    { type: 'openTab', paneId: base, tab: tab('t1', 'file', 'a.md'), index: 0 },
    { type: 'openTab', paneId: base, tab: tab('t2', 'file', 'b.md'), index: 1 },
    { type: 'focusTab', tabId: 't1' },
    { type: 'split', paneId: base, axis: 'row', direction: 'after', newPaneId: 'paneR', newSplitId: 'splitX' },
    { type: 'resize', splitId: 'splitX', sizes: [0.35, 0.65] },
    { type: 'setExpanded', expanded: true },
    { type: 'closeTab', tabId: 't2' },
  ];
  let s = start;
  const inverses = [];
  for (const op of ops) {
    const r = O.applyOp(s, op);
    s = r.state;
    inverses.unshift(...r.inverse);
  }
  check('前进后状态确实变了', s !== start && Object.keys(s.tabs).length === 1 && s.expanded === true,
    JSON.stringify({ tabs: Object.keys(s.tabs), expanded: s.expanded }));
  check('每条 op 都给出逆 op', inverses.length >= ops.length, String(inverses.length));

  let back = s;
  for (const op of inverses) back = O.applyOp(back, op).state;
  check('逆 op 倒序应用能还原初始状态', snapshot(back) === snapshot(start),
    `\n    还原后 ${snapshot(back).slice(0, 200)}\n    初始   ${snapshot(start).slice(0, 200)}`);

  // 持久化回放:RightSidebar 存的就是这串 ops,回放结果必须与用户当时看到的一模一样
  const replayed = O.replay(start, ops);
  check('replay 与逐条 applyOp 的结果一致(布局持久化靠它)', snapshot(replayed) === snapshot(s));
  check('replay 不改动原状态', snapshot(start) === snapshot(fresh()));
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail > 0 ? 1 : 0);
