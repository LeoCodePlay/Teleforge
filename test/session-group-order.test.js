// 任务列表「工作区分组」排序测试:排序键必须是「用户最后发消息的时间」(lastUserAt),
// 不能用 updatedAt(AI 回复也会推进),否则每轮回复工作区分组就重排;刚聊过的工作区要浮到最前。
import { orderGroups, groupActiveAt, sessionActiveAt } from '../web/src/utils/sessionGroupOrder.ts';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const UNGROUPED = '__ungrouped__';
const t0 = Date.now() - 60_000;
const sess = (id, lastUserAt, updatedAt) => ({ id, lastUserAt, updatedAt });
const wsOf = (s) => s.id; // 测试里用会话 id 冒充工作区路径

// 三个工作区分组:A 用户消息最早,B 其次,C 最新
const groups = () => ([
  [`l:F:\\wsA`, [sess('A', t0, t0 + 5000)]],
  [`l:F:\\wsB`, [sess('B', t0 + 1000, t0 + 1000)]],
  [`l:F:\\wsC`, [sess('C', t0 + 2000, t0 + 2000)]]
]);
const ids = (gs) => gs.map(([k]) => k);

let out = orderGroups(groups(), { sectionId: 'l', orderMap: {}, wsOf, ungrouped: UNGROUPED });
check('刚发消息的工作区排最前(C > B > A)',
  JSON.stringify(ids(out)) === JSON.stringify(['l:F:\\wsC', 'l:F:\\wsB', 'l:F:\\wsA']), JSON.stringify(ids(out)));

// 模拟 A 的 AI 回复:updatedAt 变得最新,但 lastUserAt 不变 → 顺序必须保持
const withAiReply = () => ([
  [`l:F:\\wsA`, [sess('A', t0, t0 + 9999)]],
  [`l:F:\\wsB`, [sess('B', t0 + 1000, t0 + 1000)]],
  [`l:F:\\wsC`, [sess('C', t0 + 2000, t0 + 2000)]]
]);
out = orderGroups(withAiReply(), { sectionId: 'l', orderMap: {}, wsOf, ungrouped: UNGROUPED });
check('AI 回复(updatedAt 推进)不改变工作区顺序',
  JSON.stringify(ids(out)) === JSON.stringify(['l:F:\\wsC', 'l:F:\\wsB', 'l:F:\\wsA']), JSON.stringify(ids(out)));

// 「未指定工作区」固定最后,即使它的会话最新
const withUngrouped = () => ([
  [`l:F:\\wsA`, [sess('A', t0, t0)]],
  [`l:${UNGROUPED}`, [sess('X', t0 + 9999, t0 + 9999)]]
]);
out = orderGroups(withUngrouped(), { sectionId: 'l', orderMap: {}, wsOf, ungrouped: UNGROUPED });
check('「未指定工作区」固定最后',
  JSON.stringify(ids(out)) === JSON.stringify(['l:F:\\wsA', `l:${UNGROUPED}`]), JSON.stringify(ids(out)));

// 用户拖拽过该分区:手动顺序优先,活跃度不再影响
const orderMap = { l: ['l:F:\\wsA', 'l:F:\\wsB', 'l:F:\\wsC'] };
out = orderGroups(groups(), { sectionId: 'l', orderMap, wsOf, ungrouped: UNGROUPED });
check('拖拽过的分区按手动顺序(不被活跃度重排)',
  JSON.stringify(ids(out)) === JSON.stringify(['l:F:\\wsA', 'l:F:\\wsB', 'l:F:\\wsC']), JSON.stringify(ids(out)));

// 拖拽过 + 新工作区:新分组接在已记录分组之后
const withNew = () => ([
  [`l:F:\\wsA`, [sess('A', t0, t0)]],
  [`l:F:\\wsB`, [sess('B', t0, t0)]],
  [`l:F:\\wsNew`, [sess('N', t0 + 9999, t0 + 9999)]]
]);
out = orderGroups(withNew(), { sectionId: 'l', orderMap: { l: ['l:F:\\wsB', 'l:F:\\wsA'] }, wsOf, ungrouped: UNGROUPED });
check('拖拽后新出现的工作区接在末尾',
  ids(out)[0] === 'l:F:\\wsB' && ids(out)[1] === 'l:F:\\wsA' && ids(out)[2] === 'l:F:\\wsNew', JSON.stringify(ids(out)));

// 都没有用户消息(旧数据/空会话):回退 updatedAt,再同值按路径字典序
const legacy = () => ([
  [`l:F:\\wsZ`, [{ id: 'Z', updatedAt: t0 }]],
  [`l:F:\\wsA`, [{ id: 'A', updatedAt: t0 }]],
  [`l:F:\\wsM`, [{ id: 'M', updatedAt: t0 + 5000 }]]
]);
out = orderGroups(legacy(), { sectionId: 'l', orderMap: {}, wsOf, ungrouped: UNGROUPED });
check('无 lastUserAt 时回退 updatedAt(最新的在前)',
  ids(out)[0] === 'l:F:\\wsM', JSON.stringify(ids(out)));
check('活跃度相同按工作区路径字典序稳定',
  ids(out)[1] === 'l:F:\\wsA' && ids(out)[2] === 'l:F:\\wsZ', JSON.stringify(ids(out)));

// 分组活跃度 = 组内会话活跃键最大值(组里只要有一条刚发过消息就算活跃)
check('分组活跃度取组内最大值',
  groupActiveAt([sess('a', t0, t0), sess('b', t0 + 3000, t0)]) === t0 + 3000);
check('会话活跃键优先 lastUserAt', sessionActiveAt(sess('a', t0, t0 + 5000)) === t0);
check('会话活跃键缺 lastUserAt 时回退 updatedAt', sessionActiveAt({ id: 'a', updatedAt: t0 + 7 }) === t0 + 7);

console.log(`\nsession-group-order: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
