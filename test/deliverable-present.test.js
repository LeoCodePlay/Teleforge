// 成果物交付(present 工具)+ 投影 + 合并规则的测试
//
// 背景:用户要"已编辑文件的成果物显示"。这里要钉死三件事,任何一条错了都很难在界面上看出来:
//   1. **present 只接受真实存在的普通文件** —— 否则用户会拿到一张点开就失败的空卡片;
//   2. **投影时并入前一条 assistant 消息,不新增行** —— 多一行就会让消息面下标错位,
//      而 forkTail / 回退 / 删除都按下标工作(错位 = 分支切错消息,是难查的静默 bug);
//   3. **绝不进模型可见面** —— 成果物是纯展示信息;进了上下文既白烧 token,
//      又会让每步前缀多出内容、直接打断前缀缓存的命中。
// 运行:node test/deliverable-present.test.js
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-deliv-'));

const { ToolRegistry } = await import('../server/agent/registry.ts');
const { registerTools } = await import('../server/agent/tools.ts');
const { localFs } = await import('../server/core/local-fs.ts');
const { projectEvents, messageFaceIndexes } = await import('../server/agent/agent.ts');
const { mergeDeliverables } = await import('../web/src/utils/mergeAttachments.ts');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

// 本机工作区:放一个真实文件与一个子目录,用于"存在/不存在/是目录"三种情况
const ws = mkdtempSync(path.join(tmpdir(), 'sshai-deliv-ws-'));
writeFileSync(path.join(ws, '报告.md'), '# 报告');
writeFileSync(path.join(ws, 'data.csv'), 'a,b\n1,2');
mkdirSync(path.join(ws, 'sub'));
localFs.workspace = ws;

const registry = new ToolRegistry();
registerTools(registry);
const present = registry.tools.get('present');

/** 假会话:只记录 append 的事件(与 session.append 的返回形状一致) */
function fakeCtx() {
  const events = [];
  const emitted = [];
  return {
    events, emitted,
    ctx: {
      sid: 's1',
      session: { append: (type, data) => { const ev = { seq: events.length + 1, time: Date.now(), type, data }; events.push(ev); return ev; } },
      emit: (ns, payload) => emitted.push({ ns, payload })
    }
  };
}

console.log('\n[一] 注册与访问类别');
check('present 已注册', !!present);
check('access = meta(不写文件/不执行命令,与 todo_write 同级)', present?.access === 'meta', `实际=${present?.access}`);

console.log('\n[二] 正常交付');
{
  const { ctx, events, emitted } = fakeCtx();
  const text = await present.run({ files: [
    { path: path.join(ws, '报告.md'), description: '最终分析报告' },
    { path: path.join(ws, 'data.csv') }
  ] }, ctx);
  check('返回文本包含文件数', /已交付 2 个成果物/.test(text), text);
  check('落了一条 deliverable/presented 事件', events.length === 1 && events[0].type === 'deliverable/presented', JSON.stringify(events.map((e) => e.type)));
  const files = events[0]?.data?.files || [];
  check('事件里带两个文件', files.length === 2);
  check('保留了说明', files[0]?.description === '最终分析报告');
  check('省略的说明不写成空字符串', files[1] && !('description' in files[1]), JSON.stringify(files[1]));
  check('广播了 deliverable 实时事件', emitted.some((e) => e.payload?.event === 'deliverable' && e.payload?.files?.length === 2));
}

console.log('\n[三] 校验:坏输入必须报错,而不是照收');
{
  const bad = async (args, why) => {
    const { ctx, events } = fakeCtx();
    let threw = null;
    try { await present.run(args, ctx); } catch (e) { threw = e.message; }
    check(why, !!threw && events.length === 0, threw ? `(未拒绝)` : '未抛错');
  };
  await bad({ files: [] }, '空数组被拒绝');
  await bad({ files: 'not-an-array' }, '非数组被拒绝');
  await bad({ files: [{ path: '' }] }, '空路径被拒绝');
  await bad({ files: [{ path: path.join(ws, '不存在.txt') }] }, '不存在的文件被拒绝');
  await bad({ files: [{ path: path.join(ws, 'sub') }] }, '目录被拒绝(不能交付一个文件夹)');
  await bad({ files: Array.from({ length: 7 }, (_, i) => ({ path: path.join(ws, '报告.md'), description: String(i) })) },
    '超过上限(6 个)被拒绝');
}
{
  // 上限内正常通过
  const { ctx } = fakeCtx();
  const six = Array.from({ length: 6 }, () => ({ path: path.join(ws, '报告.md') }));
  let ok = true;
  try { await present.run({ files: six }, ctx); } catch { ok = false; }
  check('正好 6 个通过(上限含等于)', ok);
}
{
  // 同路径重复声明:去重而不是报错(模型偶尔会重复)
  const { ctx, events } = fakeCtx();
  await present.run({ files: [{ path: path.join(ws, '报告.md') }, { path: path.join(ws, '报告.md') }] }, ctx);
  check('重复路径自动去重为 1 个', events[0]?.data?.files?.length === 1, JSON.stringify(events[0]?.data?.files));
}
{
  // 没有会话上下文:必须报错(而不是静默什么都不做)
  let threw = null;
  try { await present.run({ files: [{ path: path.join(ws, '报告.md') }] }, {}); } catch (e) { threw = e.message; }
  check('缺少会话上下文时报错', !!threw, String(threw));
}

console.log('\n[四] 投影:并入前一条 assistant,不新增行');
{
  const base = [
    { seq: 1, time: 1, type: 'user/message', data: { content: '帮我生成报告' } },
    { seq: 2, time: 2, type: 'assistant/message', data: { message: { content: '做好了' } } }
  ];
  const withDeliv = [...base, { seq: 3, time: 3, type: 'deliverable/presented', data: { files: [{ path: '报告.md', description: '最终报告' }] } }];
  const a = projectEvents(base);
  const b = projectEvents(withDeliv);
  check('投影行数不变(关键:不能新增行)', a.length === b.length, `${a.length} → ${b.length}`);
  check('成果物挂到了 assistant 行', b[1]?.role === 'assistant' && b[1]?.deliverables?.length === 1, JSON.stringify(b[1]));
  check('assistant 正文没被改动', b[1]?.content === '做好了', String(b[1]?.content));
  check('user 行未受影响', b[0]?.content === '帮我生成报告');
}
{
  // 没有任何 assistant 行时(极端情况):补一行承载卡片,而不是丢掉
  const out = projectEvents([
    { seq: 1, time: 1, type: 'deliverable/presented', data: { files: [{ path: 'x.txt' }] } }
  ]);
  check('无 assistant 行时补一行承载', out.length === 1 && out[0].role === 'assistant' && out[0].deliverables?.length === 1, JSON.stringify(out));
}
{
  // 空 files 不产生任何东西(不制造空卡片)
  const out = projectEvents([
    { seq: 1, time: 1, type: 'assistant/message', data: { message: { content: 'x' } } },
    { seq: 2, time: 2, type: 'deliverable/presented', data: { files: [] } }
  ]);
  check('空 files 不挂字段', out.length === 1 && !('deliverables' in out[0]), JSON.stringify(out));
}

console.log('\n[五] 绝不进模型可见面(前缀缓存的硬约束)');
{
  const base = [
    { seq: 1, time: 1, type: 'user/message', data: { content: 'hi' } },
    { seq: 2, time: 2, type: 'assistant/message', data: { message: { content: 'ok' } } }
  ];
  const withDeliv = [...base, { seq: 3, time: 3, type: 'deliverable/presented', data: { files: [{ path: 'a.txt' }] } }];
  const a = JSON.stringify(messageFaceIndexes(base));
  const b = JSON.stringify(messageFaceIndexes(withDeliv));
  check('messageFaceIndexes 完全不变', a === b, `${a} vs ${b}`);
}

console.log('\n[六] 合并规则(同一轮多次 present)');
{
  check('两批都空 → undefined', mergeDeliverables(undefined, undefined) === undefined);
  check('只有新批 → 返回新批', mergeDeliverables(undefined, [{ path: 'a' }])?.length === 1);
  check('只有旧批且新批为空 → 保留旧批', mergeDeliverables([{ path: 'a' }], [])?.length === 1);
  const m = mergeDeliverables([{ path: 'a', description: '旧' }], [{ path: 'b' }]);
  check('不同路径累加', m?.length === 2);
  const u = mergeDeliverables([{ path: 'a', description: '旧' }], [{ path: 'a', description: '新' }]);
  check('同路径取后一次的说明(后一次通常更准确)', u?.length === 1 && u[0].description === '新', JSON.stringify(u));
  const k = mergeDeliverables([{ path: 'a', description: '旧' }], [{ path: 'a' }]);
  check('同路径且新批没给说明 → 保留旧说明', k?.length === 1 && k[0].description === '旧', JSON.stringify(k));
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
