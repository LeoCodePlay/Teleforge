// 右侧栏分栏纯引擎的测试(web/src/components/RightSidebar/layout.ts)
//
// 为什么这个模块必须单测:布局是**可持久化**的状态,坏数据/坏 op 会渲染出一棵破树,
// 而破树的症状(标签消失、点不开、栏位挤没)在界面上极难定位。纯函数能在这里穷举掉。
// 重点锁定四条:
//   1. 内容身份 (kind, contentId) —— 重复打开只聚焦,不重复开标签;
//   2. 关掉最后一个标签要把空 pane 合并掉,不留空栏;
//   3. 每个 op 的**逆 op 必须真的能还原**(撤销/持久化回放都靠它);
//   4. 尺寸必须夹紧(分数、每侧不低于下限、和为 1)。
// 运行:node test/right-sidebar-layout.test.js
const L = await import('../web/src/components/RightSidebar/layout.ts');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const tab = (id, kind, contentId, title = id) => ({ id, kind, contentId, title });
const apply = (s, op) => L.applyOp(s, op).state;

console.log('\n[一] 初始状态');
{
  const s = L.initialLayout();
  check('恰好一个 pane', L.paneIds(s).length === 1);
  check('没有标签', Object.keys(s.tabs).length === 0);
  check('默认折叠', s.expanded === false);
  check('初始状态自洽', L.validateLayout(s) === null, String(L.validateLayout(s)));
}

console.log('\n[二] 打开标签 / 内容身份幂等');
{
  let s = L.initialLayout();
  s = apply(s, { type: 'openTab', tab: tab('t1', 'file', 'a.md') });
  check('开一个标签', Object.keys(s.tabs).length === 1);
  check('active 指向它', L.activeTabOf(s, s.activePaneId)?.id === 't1');

  // 同一内容再开:必须只聚焦,不新增(否则同一个文件会被开出无数个标签)
  s = apply(s, { type: 'openTab', tab: tab('t2', 'file', 'a.md') });
  check('同内容重复打开不新增标签', Object.keys(s.tabs).length === 1, JSON.stringify(Object.keys(s.tabs)));
  check('幂等后 active 仍是原标签', L.activeTabOf(s, s.activePaneId)?.id === 't1');

  // 同 contentId 但不同 kind:是不同标签(身份是 kind + contentId)
  s = apply(s, { type: 'openTab', tab: tab('t3', 'diff', 'a.md') });
  check('同 contentId 不同 kind 视为不同标签', Object.keys(s.tabs).length === 2, JSON.stringify(Object.keys(s.tabs)));

  // 新内容:新增并聚焦
  s = apply(s, { type: 'openTab', tab: tab('t4', 'file', 'b.md') });
  check('不同内容新增标签', Object.keys(s.tabs).length === 3);
  check('最新打开的成为 active', L.activeTabOf(s, s.activePaneId)?.id === 't4');
  check('状态自洽', L.validateLayout(s) === null, String(L.validateLayout(s)));
}

console.log('\n[三] 关闭标签:退位与空栏合并');
{
  let s = L.initialLayout();
  s = apply(s, { type: 'openTab', tab: tab('t1', 'file', 'a.md') });
  s = apply(s, { type: 'openTab', tab: tab('t2', 'file', 'b.md') });
  s = apply(s, { type: 'openTab', tab: tab('t3', 'file', 'c.md') }); // active = t3
  s = apply(s, { type: 'closeTab', tabId: 't3' });
  check('关掉 active → 退到左侧邻居 t2', L.activeTabOf(s, s.activePaneId)?.id === 't2', String(L.activeTabOf(s, s.activePaneId)?.id));
  s = apply(s, { type: 'closeTab', tabId: 't1' });
  check('关掉非 active 不影响 active', L.activeTabOf(s, s.activePaneId)?.id === 't2');
  check('标签被真正移除', !s.tabs.t1);
}
{
  // 两栏:左栏关光 → 空栏合并,右栏顶上来当 root
  let s = L.initialLayout();
  s = apply(s, { type: 'openTab', tab: tab('a1', 'file', 'a.md') });
  const left = s.activePaneId;
  s = L.applyOp(s, { type: 'split', paneId: left, newPaneId: 'paneR', splitId: 'splitX' }).state;
  check('分栏后有两个 pane', L.paneIds(s).length === 2);
  s = apply(s, { type: 'openTab', tab: tab('b1', 'file', 'b.md') });
  check('新标签开在新 pane', L.activeTabOf(s, s.activePaneId)?.id === 'b1');
  // 关掉左栏唯一的标签
  s = apply(s, { type: 'closeTab', tabId: 'a1' });
  check('空 pane 被合并(不留空栏)', L.paneIds(s).length === 1, JSON.stringify(L.paneIds(s)));
  check('root 指向幸存的 pane', s.rootId === s.activePaneId);
  check('幸存 pane 的标签还在', Object.keys(s.tabs).length === 1 && !!s.tabs.b1);
  check('状态自洽', L.validateLayout(s) === null, String(L.validateLayout(s)));
}

console.log('\n[四] 分栏上限与合并');
{
  let s = L.initialLayout();
  s = apply(s, { type: 'openTab', tab: tab('a1', 'file', 'a.md') });
  const p1 = s.activePaneId;
  s = L.applyOp(s, { type: 'split', paneId: p1, newPaneId: 'paneR', splitId: 'splitX' }).state;
  check('分栏成功', L.paneIds(s).length === 2);

  // 已达上限:再分栏应被忽略
  const r = L.applyOp(s, { type: 'split', paneId: 'paneR', newPaneId: 'paneZ', splitId: 'splitZ' });
  check('超过上限的分栏被忽略', L.paneIds(r.state).length === 2);
  check('被忽略时逆 op 为空(不会错误地合并掉东西)', r.inverse.length === 0, JSON.stringify(r.inverse));

  // 合并
  s = apply(s, { type: 'merge', paneId: 'paneR' });
  check('合并后只剩一个 pane', L.paneIds(s).length === 1);
  check('状态自洽', L.validateLayout(s) === null, String(L.validateLayout(s)));

  // 只剩一个 pane 时合并无效
  const r2 = L.applyOp(s, { type: 'merge', paneId: s.rootId });
  check('单栏时合并不生效', r2.state === s && r2.inverse.length === 0);
}
{
  // 合并"装着标签的栏":标签必须移交给兄弟栏,**不能丢**(合并两栏 ≠ 关掉标签)
  let s = L.initialLayout();
  s = apply(s, { type: 'openTab', tab: tab('a1', 'file', 'a.md') });
  s = L.applyOp(s, { type: 'split', paneId: s.activePaneId, newPaneId: 'paneR', splitId: 'splitX' }).state;
  s = apply(s, { type: 'openTab', tab: tab('b1', 'file', 'b.md') }); // 开在 paneR
  check('分栏两侧各有一个标签', Object.keys(s.tabs).length === 2);
  s = apply(s, { type: 'merge', paneId: 'paneR' });
  check('合并后只剩一个 pane', L.paneIds(s).length === 1);
  check('被合并栏的标签没有丢失', Object.keys(s.tabs).length === 2, JSON.stringify(Object.keys(s.tabs)));
  check('两个标签都在幸存栏里', s.nodes[s.rootId].tabs.length === 2, JSON.stringify(s.nodes[s.rootId].tabs));
  check('状态自洽', L.validateLayout(s) === null, String(L.validateLayout(s)));
}

console.log('\n[五] 尺寸夹紧');
{
  check('正常比例原样保留', JSON.stringify(L.clampSizes([0.3, 0.7])) === JSON.stringify([0.3, 0.7]));
  const c1 = L.clampSizes([0.05, 0.95]);
  check('过小的一侧被抬到下限 0.2', c1[0] === 0.2, JSON.stringify(c1));
  check('抬升后仍和为 1', Math.abs(c1[0] + c1[1] - 1) < 1e-9);
  const c2 = L.clampSizes([2, 1]);
  check('未归一化的输入被归一化', Math.abs(c2[0] - 2 / 3) < 1e-9, JSON.stringify(c2));
  check('非法输入回落到对半', JSON.stringify(L.clampSizes([NaN, NaN])) === JSON.stringify([0.5, 0.5]));
  check('零和回落到对半', JSON.stringify(L.clampSizes([0, 0])) === JSON.stringify([0.5, 0.5]));
  check('长度不为 2 回落到对半', JSON.stringify(L.clampSizes([1, 2, 3])) === JSON.stringify([0.5, 0.5]));

  // resize op 必须走夹紧
  let s = L.initialLayout();
  s = apply(s, { type: 'openTab', tab: tab('a1', 'file', 'a.md') });
  s = L.applyOp(s, { type: 'split', paneId: s.activePaneId, newPaneId: 'paneR', splitId: 'splitX' }).state;
  s = apply(s, { type: 'resize', splitId: 'splitX', sizes: [0.01, 0.99] });
  const sp = s.nodes.splitX;
  check('resize 后的比例被夹紧', sp.sizes[0] === 0.2 && Math.abs(sp.sizes[1] - 0.8) < 1e-9, JSON.stringify(sp.sizes));
}

console.log('\n[六] 逆 op 必须能还原(撤销 / 持久化回放的基石)');
{
  const steps = [
    { name: 'openTab', op: { type: 'openTab', tab: tab('t1', 'file', 'a.md') } },
    { name: 'openTab(第二)', op: { type: 'openTab', tab: tab('t2', 'file', 'b.md') } },
    { name: 'focusTab(回到 t1)', op: { type: 'focusTab', tabId: 't1' } },
    { name: 'split', op: { type: 'split', paneId: 'pane1', newPaneId: 'paneR', splitId: 'splitX' } },
    { name: 'resize', op: { type: 'resize', splitId: 'splitX', sizes: [0.35, 0.65] } },
    { name: 'setExpanded(true)', op: { type: 'setExpanded', expanded: true } },
    { name: 'closeTab(t2)', op: { type: 'closeTab', tabId: 't2' } },
    { name: 'merge(paneR)', op: { type: 'merge', paneId: 'paneR' } }
  ];
  let s = L.initialLayout();
  for (const st of steps) {
    const before = JSON.stringify(s);
    const { state, inverse } = L.applyOp(s, st.op);
    // 逆 op 依次应用应回到 before
    let back = state;
    for (const inv of inverse) back = L.applyOp(back, inv).state;
    check(`逆 op 还原「${st.name}」`, JSON.stringify(back) === before,
      JSON.stringify(back) === before ? '' : `\n     before=${before}\n     back  =${JSON.stringify(back)}`);
    s = state;
  }
  check('走完所有 op 后状态自洽', L.validateLayout(s) === null, String(L.validateLayout(s)));
}

console.log('\n[七] 回放可复现 + 数据校验');
{
  const ops = [
    { type: 'openTab', tab: tab('t1', 'file', 'a.md') },
    { type: 'openTab', tab: tab('t2', 'file', 'b.md') },
    { type: 'split', paneId: 'pane1', newPaneId: 'paneR', splitId: 'splitX' },
    { type: 'openTab', tab: tab('t3', 'file', 'c.md'), paneId: 'paneR' }
  ];
  const a = L.replay(L.initialLayout(), ops);
  const b = L.replay(L.initialLayout(), ops);
  check('同一串 op 回放出同一状态(纯函数、无时钟无随机)', JSON.stringify(a) === JSON.stringify(b));
  check('回放结果自洽', L.validateLayout(a) === null, String(L.validateLayout(a)));
  check('回放真的建了 2 个 pane', L.paneIds(a).length === 2);
  check('回放真的开了 3 个标签', Object.keys(a.tabs).length === 3);
  check('指定 paneId 的标签开在那一栏', !!a.tabs.t3 && (a.nodes.paneR).tabs.includes('t3'));

  // 坏数据必须被识别出来(持久化跨版本/手改)
  check('非对象被拒', L.validateLayout(null) === '不是对象');
  check('没有 pane 被拒', L.validateLayout({ nodes: {}, tabs: {}, rootId: 'x', activePaneId: 'x' }) === '没有任何 pane');
  const good = L.replay(L.initialLayout(), ops);
  check('rootId 悬空被拒', !!L.validateLayout({ ...good, rootId: 'nope' }));
  check('activePaneId 非 pane 被拒', !!L.validateLayout({ ...good, activePaneId: 'splitX' }));
  check('标签被两个 pane 引用被拒', !!L.validateLayout({
    ...good,
    nodes: { ...good.nodes, pane1: { ...good.nodes.pane1, tabs: ['t1', 't2', 't3'] } }
  }));
  check('孤儿标签被拒', !!L.validateLayout({ ...good, tabs: { ...good.tabs, orphan: tab('orphan', 'file', 'z.md') } }));
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
