// 每轮文件变更记录 + 单文件对比的测试
//
// 背景:对话里「N 个文件已更改」卡片点开后,右侧栏要展示**真正的** hunk 级对比。
// 之前服务端只记了 addLines/delLines(没有改动前后内容),前端只好把 old_string/new_string
// 假装成两侧。这一层是那块能力的唯一数据来源,所以下面这几条必须可靠:
//   - 记录**绝不能**影响写操作(store 自己吞异常);
//   - 二进制/超大文件按同一口径降级,不能把 GB 级内容塞进 data/;
//   - 同一文件同一轮只留最后一条(本轮开始 vs 最后一次);
//   - 行号/增删行数/coarse 退化都要能被 UI 直接消费。
// 运行:node test/changes-record.test.js
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'sshai-changes-'));

const store = await import('../server/changes/store.ts');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const SID = 's_changestest01';

console.log('\n[一] hunk 计算(纯函数)');
{
  const oldText = 'a\nb\nc\nd\ne\nf\ng\nh\n';
  const newText = 'a\nb\nc\nD\ne\nf\ng\nh\n';
  const { hunks, coarse } = store.computeHunks(oldText, newText);
  check('单行替换只产出一个 hunk', hunks.length === 1, `hunks=${hunks.length}`);
  check('非粗粒度', coarse === false);
  const h = hunks[0];
  check('hunk 带双侧行号区间', typeof h.oldStart === 'number' && typeof h.newStart === 'number' && h.oldLines > 0, JSON.stringify(h));
  check('上下文各留 3 行', h.lines.filter((l) => l[0] === ' ').length === 6, JSON.stringify(h.lines));
  check('删行带 - 前缀', h.lines.includes('-d'), JSON.stringify(h.lines));
  check('增行带 + 前缀', h.lines.includes('+D'), JSON.stringify(h.lines));
  check('每行前缀只有 +/-/空格 三种', h.lines.every((l) => l[0] === '+' || l[0] === '-' || l[0] === ' '), JSON.stringify(h.lines));
}
{
  const { hunks } = store.computeHunks('', 'x\ny\n');
  check('新建文件 = 一个全增 hunk', hunks.length === 1 && hunks[0].lines.every((l) => l[0] === '+'), JSON.stringify(hunks));
  check('新建文件旧侧行数为 0', hunks[0].oldLines === 0);
}
{
  const { hunks } = store.computeHunks('x\ny\n', '');
  check('删除文件 = 一个全删 hunk', hunks.length === 1 && hunks[0].lines.every((l) => l[0] === '-'), JSON.stringify(hunks));
}
{
  const { hunks, coarse } = store.computeHunks('same\n', 'same\n');
  check('内容未变化 = 无 hunk 且非粗粒度', hunks.length === 0 && coarse === false);
}
{
  const coarse = store.coarseHunks('a\nb\n', 'c\n');
  check('粗粒度退化 = 单 hunk 且先全删后全加', coarse.length === 1
    && coarse[0].lines.join('|') === '-a|-b|+c', JSON.stringify(coarse[0].lines));
}

console.log('\n[二] 记录与汇总');
store._resetChangesForTest();
{
  check('无记录时 summary 为 null', store.changesSummary(SID, 1) === null);
  store.recordFileChange(SID, 1, { path: '/w/a.ts', kind: 'edit', before: 'one\n', after: 'two\n', added: 1, deleted: 1 });
  store.recordFileChange(SID, 1, { path: '/w/b.txt', kind: 'create', before: '', after: 'hello\n', added: 1, deleted: 0 });
  const s = store.changesSummary(SID, 1);
  check('汇总含两条文件', s && s.total === 2, JSON.stringify(s));
  check('index 从 0 顺序编号', s && s.files[0].index === 0 && s.files[1].index === 1);
  check('增删行数累计', s && s.added === 2 && s.deleted === 1, JSON.stringify(s));
  check('同轮不同轮互不串', store.changesSummary(SID, 2) === null);
  check('未知会话返回 null', store.changesSummary('s_other', 1) === null);
}
{
  // 同一路径再改一次:本轮只保留最后一条(本轮开始 vs 最后一次)
  store.recordFileChange(SID, 3, { path: '/w/c.ts', kind: 'edit', before: 'A\n', after: 'B\n', added: 1, deleted: 1 });
  store.recordFileChange(SID, 3, { path: '/w/c.ts', kind: 'edit', before: 'A\n', after: 'Z\n', added: 1, deleted: 1 });
  const s = store.changesSummary(SID, 3);
  check('同路径同轮只留一条', s && s.total === 1, JSON.stringify(s));
  const d = store.changeFileDiff(SID, 3, 0);
  check('对比的是最早基线 vs 最后一次', d && d.kind === 'text' && d.hunks.some((h) => h.lines.includes('+Z')) && !d.hunks.some((h) => h.lines.includes('+B')), JSON.stringify(d));
}

console.log('\n[三] 单文件对比');
{
  const d = store.changeFileDiff(SID, 1, 0);
  check('文本对比返回 hunks', d && d.kind === 'text' && d.hunks.length >= 1, JSON.stringify(d));
  check('左右两侧内容都在', d && d.before === true && d.after === true);
  check('路径回传', d && d.path === '/w/a.ts');
  const created = store.changeFileDiff(SID, 1, 1);
  check('新建文件 oldStart 为 1 且全增', created && created.hunks[0].lines.every((l) => l[0] === '+'));
  check('越界 index 返回 null', store.changeFileDiff(SID, 1, 99) === null);
  check('错误轮号返回 null', store.changeFileDiff(SID, 0, 0) === null && store.changeFileDiff(SID, -1, 0) === null);
}

console.log('\n[四] 降级:二进制 / 超大 / 目录删除');
store._resetChangesForTest();
{
  store.recordFileChange(SID, 10, { path: '/w/bin', kind: 'write', before: 'ok\n', after: 'a\u0000b', added: 1, deleted: 1 });
  const d = store.changeFileDiff(SID, 10, 0);
  check('含 NUL 的文件标记 binary', d && d.kind === 'binary', JSON.stringify(d));
  check('汇总里带 binary 标记', store.changesSummary(SID, 10).files[0].binary === true);

  const big = 'x'.repeat(2 * 1024 * 1024 + 16);
  store.recordFileChange(SID, 11, { path: '/w/big', kind: 'write', before: 'y\n', after: big, added: 1, deleted: 1 });
  const bigDiff = store.changeFileDiff(SID, 11, 0);
  check('超过 2MB 标记 oversized', bigDiff && bigDiff.kind === 'oversized', JSON.stringify(bigDiff));
  check('超大文件不落 blob', !fs.existsSync(path.join(process.env.DATA_DIR, 'changes', SID, big.slice(0, 8))));

  store.recordFileChange(SID, 12, { path: '/w/del.txt', kind: 'delete', before: 'gone\n', after: null, added: 0, deleted: 1 });
  const del = store.changeFileDiff(SID, 12, 0);
  check('删除文件:after=false 且全删', del && del.after === false && del.hunks[0].lines.every((l) => l[0] === '-'), JSON.stringify(del));
}

console.log('\n[五] 防御:坏输入不得影响写操作');
{
  let threw = false;
  try {
    store.recordFileChange(null, 1, { path: '/x', kind: 'edit', before: 'a', after: 'b', added: 1, deleted: 1 });
    store.recordFileChange(SID, NaN, { path: '/x', kind: 'edit', before: 'a', after: 'b', added: 1, deleted: 1 });
    store.recordFileChange(SID, -3, { path: '/x', kind: 'edit', before: 'a', after: 'b', added: 1, deleted: 1 });
    store.recordFileChange('../../etc/passwd', 1, { path: '/x', kind: 'edit', before: 'a', after: 'b', added: 1, deleted: 1 });
    store.recordFileChange(SID, 20, { path: '', kind: 'edit', before: 'a', after: 'b', added: 1, deleted: 1 });
    store.recordFileChange(SID, 20, { path: '/x', kind: 'edit', before: 'a', after: 'b', added: NaN, deleted: -5 });
  } catch (e) { threw = true; }
  check('坏输入一律不抛(写操作不受影响)', threw === false);
  check('会话 id 越界(路径穿越)被拒绝', store.changesSummary('../../etc/passwd', 1) === null);
  const e = store.changesSummary(SID, 20);
  check('非数字增删行数夹到 0', e && e.files[0].added === 0 && e.files[0].deleted === 0, JSON.stringify(e));
}

console.log('\n[六] 持久化:重新载入后历史轮仍可对比');
{
  const before = store.changeFileDiff(SID, 12, 0);
  store._resetChangesForTest(); // 模拟进程重启(内存态清空,磁盘保留)
  const after = store.changeFileDiff(SID, 12, 0);
  check('重启后仍能读到上一轮的 diff', after && after.kind === 'text' && JSON.stringify(after.hunks) === JSON.stringify(before.hunks), JSON.stringify(after));
  check('重启后 summary 结构一致', store.changesSummary(SID, 12)?.total === 1);
}

console.log('\n[七] 工具侧接线:写工具确实会把改动前后内容喂给记录器');
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sshai-changes-ws-'));
  const { localFs } = await import('../server/core/local-fs.ts');
  localFs.workspace = ws;
  const { registerTools } = await import('../server/agent/tools.ts');
  // registerTools 还会调用 setAliasFilter 等装配方法:这里只关心工具定义本身,
  // 用 Proxy 把未实现的方法兜成空函数(否则测试得跟着注册表接口一起改)。
  const defs = new Map();
  const registry = new Proxy({ register: (d) => defs.set(d.name, d) }, {
    get: (t, k) => (k in t ? t[k] : () => {})
  });
  registerTools(registry);
  const run = (name, args, ctx) => defs.get(name).run(args, ctx);

  const SMOKE = 's_smoke' + Date.now().toString(36);
  const ctx = { sid: SMOKE, turn: 5 };

  const w = await run('write_local_file', { path: 'a.txt', content: 'line1\nline2\n' }, ctx);
  check('写工具仍返回改动卡 meta', w?.meta?.card === 'diff' && w.meta.kind === 'create', JSON.stringify(w?.meta));
  check('新建文件进入记录', store.changesSummary(SMOKE, 5)?.total === 1);

  await run('edit_local_file', { path: 'a.txt', old_string: 'line2', new_string: 'LINE-TWO' }, ctx);
  const s = store.changesSummary(SMOKE, 5);
  check('同轮同文件仍只一条(编辑覆盖新建)', s && s.total === 1 && s.files[0].kind === 'edit', JSON.stringify(s));
  const d = store.changeFileDiff(SMOKE, 5, 0);
  check('对比是真 hunk:含 -line2 / +LINE-TWO',
    d && d.kind === 'text' && d.hunks.some((h) => h.lines.includes('-line2')) && d.hunks.some((h) => h.lines.includes('+LINE-TWO')),
    JSON.stringify(d));

  await run('delete_local_path', { path: 'a.txt' }, ctx);
  const afterDel = store.changeFileDiff(SMOKE, 5, 0);
  check('删除后条目变成 delete 且全删', afterDel && afterDel.after === false && afterDel.hunks[0].lines.every((l) => l[0] === '-'), JSON.stringify(afterDel));

  const noCtx = await run('write_local_file', { path: 'b.txt', content: 'x\n' }, undefined);
  check('缺 ctx(老调用方)不报错、也不记录', noCtx?.meta?.card === 'diff', JSON.stringify(noCtx?.meta));
}

console.log('\n[八] 按路径回找(findChange:变更卡点进来只带路径)');
{
  store._resetChangesForTest();
  const S = 's_find' + Date.now().toString(36);
  store.recordFileChange(S, 2, { path: '/w/a.ts', kind: 'edit', before: '1\n', after: '2\n', added: 1, deleted: 1 });
  store.recordFileChange(S, 4, { path: '/w/b.ts', kind: 'edit', before: 'x\n', after: 'y\n', added: 1, deleted: 1 });
  store.recordFileChange(S, 5, { path: '/w/a.ts', kind: 'edit', before: '2\n', after: '3\n', added: 1, deleted: 1 });
  store.recordFileChange(S, 5, { path: '/w/b.ts', kind: 'edit', before: 'y\n', after: 'z\n', added: 1, deleted: 1 });

  const a = store.findChange(S, '/w/a.ts');
  check('不带轮号:回找该文件最近一轮', a && a.turn === 5 && a.index === 0, JSON.stringify(a));
  const b = store.findChange(S, '/w/b.ts');
  check('同一轮里第二个文件的序号正确', b && b.turn === 5 && b.index === 1, JSON.stringify(b));
  const hinted = store.findChange(S, '/w/b.ts', 4);
  check('给了轮号就优先用那一轮', hinted && hinted.turn === 4, JSON.stringify(hinted));
  const drift = store.findChange(S, '/w/b.ts', 99);
  check('轮号对不上(分支/重放)时回落到能找到的轮', drift && drift.turn === 5, JSON.stringify(drift));
  check('文件不在记录里返回 null', store.findChange(S, '/w/none.ts') === null);
  check('坏路径返回 null', store.findChange(S, '') === null && store.findChange(S, null) === null);
  check('本机侧标记会带到清单里', (() => {
    store.recordFileChange(S, 6, { path: 'C:\\w\\l.ts', kind: 'edit', before: 'a\n', after: 'b\n', added: 1, deleted: 1, local: true });
    const s = store.changesSummary(S, 6);
    return s && s.files[0].local === true && (store.findChange(S, '/w/a.ts') || {}).local === undefined;
  })());
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
