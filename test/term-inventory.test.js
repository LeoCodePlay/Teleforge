// termInventory 单测:共享终端清单的缓存语义(等价 dsh 0.2.1-rc 的 0ae278b935)。
// 关键行为:一次成功/一次失败都被缓存、并发读共享在途请求、在途期间的 start/exit 增量
// 不被更早发出的旧响应盖回去、显式 refresh 才重取。这里直接替换 api 单例的 request/on,
// 不建连接、不依赖浏览器环境。
const { api } = await import('../web/src/api/index.ts');
let listCalls = 0;
let nextResult = { terms: [] };
let nextError = null;
let openHold = null; // 手动控制 response 何时到达
const handlers = new Map();
api.request = async (name) => {
  if (name !== 'ai_term_list') return {};
  listCalls += 1;
  if (openHold) await openHold;
  if (nextError) throw nextError;
  return nextResult;
};
api.on = (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name); };

const {
  readTermInventory, retryTermInventory, upsertTermInventory, removeTermInventory,
  subscribeTermInventory, termInventory, resetTermInventoryForTest
} = await import('../web/src/utils/termInventory.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const term = (id, sid = 's1') => ({ id, sid, label: id, state: 'running', exitCode: null });

function reset() {
  resetTermInventoryForTest();
  listCalls = 0;
  nextError = null;
  nextResult = { terms: [] };
  openHold = null;
}

// ---- 1. 两个消费方共享一次请求;结果被缓存 ----
reset();
nextResult = { terms: [term('t1'), term('t2')] };
{
  const a = await readTermInventory();
  const b = await readTermInventory();
  check('只发了一次 ai_term_list', listCalls === 1, String(listCalls));
  check('两次读到同一份清单', a === b && a.length === 2);
  check('缓存可同步取', termInventory()?.length === 2);
}

// ---- 2. 并发读共享同一次在途请求 ----
reset();
{
  let release;
  openHold = new Promise((r) => { release = r; });
  const p1 = readTermInventory();
  const p2 = readTermInventory();
  check('并发读拿到同一个 promise', p1 === p2);
  release();
  await p1;
  openHold = null;
  check('仍然只发一次', listCalls === 1, String(listCalls));
}

// ---- 3. 失败被缓存,只有显式 refresh 才重试 ----
reset();
nextError = new Error('offline');
{
  const first = await readTermInventory().catch((e) => e);
  const second = await readTermInventory().catch((e) => e);
  check('失败被缓存(错误对象复用)', first === second && first.message === 'offline');
  check('没有重复请求', listCalls === 1, String(listCalls));
  nextError = null;
  nextResult = { terms: [term('t9')] };
  const retried = await retryTermInventory();
  check('显式 refresh 才重取', listCalls === 2 && retried.length === 1, String(listCalls));
  check('refresh 后失败清除', termInventory()?.length === 1);
}

// ---- 4. 在途期间的增量覆盖旧响应 ----
reset();
{
  let release;
  openHold = new Promise((r) => { release = r; });
  const pending = readTermInventory();
  upsertTermInventory(term('fresh'));      // 在途期间新拉起
  removeTermInventory('gone');             // 在途期间已结束
  nextResult = { terms: [term('gone'), term('stale')] };
  release();
  const list = await pending;
  openHold = null;
  const ids = list.map((t) => t.id).sort();
  check('新增项在结果里', ids.includes('fresh'), ids.join(','));
  check('已结束项被剔除', !ids.includes('gone'), ids.join(','));
  check('旧响应里的其它项保留', ids.includes('stale'), ids.join(','));
}

// ---- 5. 缓存就绪后的增量直接生效并广播 ----
reset();
{
  nextResult = { terms: [term('a')] };
  await readTermInventory();
  const seen = [];
  const off = subscribeTermInventory((l) => seen.push(l.map((t) => t.id).join(',')));
  upsertTermInventory(term('b'));
  removeTermInventory('a');
  check('广播了两次变更', seen.length === 2, JSON.stringify(seen));
  check('广播内容正确', seen[0] === 'a,b' && seen[1] === 'b', JSON.stringify(seen));
  off();
  upsertTermInventory(term('c'));
  check('退订后不再广播', seen.length === 2, String(seen.length));
}

// ---- 6. start 事件缺字段不该污染缓存 ----
reset();
{
  nextResult = { terms: [] };
  await readTermInventory();
  upsertTermInventory(undefined);
  upsertTermInventory({ label: '无名' });
  check('无效条目被忽略', termInventory().length === 0);
}

console.log(`\n结果:${pass} 通过,${fail} 失败`);
if (fail > 0) process.exitCode = 1;
