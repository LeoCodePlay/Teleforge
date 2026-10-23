// 过程收起时机(completion / next-input)的偏好逻辑单测。
//
// 对应上游 dsh 0.2.1-rc 的 collapseTiming(a0a9aef5ec 加档位 + 61112eab8f 持久化):
// 本项目把偏好放在 localStorage(与对话字号同一套形态:utils/procFold),
// 这里用最小桩在 Node 下验证"默认值、持久化格式、非法值回落、订阅通知"这几条规则;
// "哪一轮算最新一轮"那部分判定是纯函数,归 test/turn-tail.test.js 的 latestFoldOwner 一节。
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};

const {
  PROC_FOLD_TIMINGS, PROC_FOLD_DEFAULT, readProcFoldTiming, currentProcFoldTiming,
  applyProcFoldTiming, onProcFoldTimingChange
} = await import('../web/src/utils/procFold.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

console.log('\n[一] 档位与默认值');
check('默认是 dsh 的 completion(完成即收起)', PROC_FOLD_DEFAULT === 'completion');
check('可选档位与 dsh 的 COLLAPSE_TIMINGS 一致', PROC_FOLD_TIMINGS.join(',') === 'completion,next-input');
check('未写过 localStorage 时读默认', readProcFoldTiming() === 'completion');

console.log('\n[二] 持久化与当前值');
applyProcFoldTiming('next-input');
check('写到 localStorage', localStorage.getItem('teleforge.proc.fold.v1') === 'next-input');
check('读回来是 next-input', readProcFoldTiming() === 'next-input');
check('当前值同步', currentProcFoldTiming() === 'next-input');

console.log('\n[三] 非法值一律回落(手改 localStorage 不该把界面搞坏)');
localStorage.setItem('teleforge.proc.fold.v1', 'whatever');
check('非法存储值回落默认', readProcFoldTiming() === 'completion');
applyProcFoldTiming('bogus');
check('非法入参回落 completion', currentProcFoldTiming() === 'completion');

console.log('\n[四] 订阅通知');
{
  const seen = [];
  const off = onProcFoldTimingChange((t) => seen.push(t));
  applyProcFoldTiming('next-input');
  applyProcFoldTiming('completion');
  off();
  applyProcFoldTiming('next-input');
  check('每次切换都通知订阅者', seen.join(',') === 'next-input,completion', seen.join(','));
  check('退订后不再通知', seen.length === 2, String(seen.length));
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail === 0 ? 0 : 1);
