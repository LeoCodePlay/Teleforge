// 过程组纯逻辑测试(web/src/utils/processGroups.ts)
//
// 为什么必须单测:分组与标题是"看起来像不像 dsh"的决定因素,而它们的规则全是从 dsh 源码
// 逐条抄来的(活动分类表、共享前缀去重、正文关组、去重计数)。这些规则一旦抄错,界面上
// 只会表现为"标题怪怪的"这种极难定位的观感问题,不会有任何报错。
// 所以这里把每条规则都钉成断言。
// 运行:node test/process-groups.test.js
const P = await import('../web/src/utils/processGroups.ts');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);

// 工具调用构造器。默认代表**已完成**(实时路径里 tool_result 必填 ok;历史回放也填 ok)。
// 要造"还在跑"的调用用 { live: true } —— 对应实时路径 tool_call 起始的
// { ok: undefined, ms: undefined, result: undefined }(见 ChatPanel 的 newCall)。
const tool = (id, name, args = '{}', opts = {}) => ({
  id, tool: name, args,
  ok: opts.live ? undefined : (opts.ok ?? true),
  ms: opts.live ? undefined : ('ms' in opts ? opts.ms : 12),
  result: opts.live ? undefined : (opts.result ?? '')
});

console.log('\n[一] 工具名 → 活动分类(逐条对齐 dsh 的 activity())');
{
  eq('read_file → read', P.activityOf('read_file'), 'read');
  eq('read_local_file → read(两套工具必须归一类)', P.activityOf('read_local_file'), 'read');
  eq('read_image → readImage', P.activityOf('read_image'), 'readImage');
  eq('grep → search', P.activityOf('grep'), 'search');
  eq('glob_local → search', P.activityOf('glob_local'), 'search');
  eq('*_inspect 后缀 → search', P.activityOf('thing_inspect'), 'search');
  eq('write_file → write', P.activityOf('write_file'), 'write');
  eq('edit_local_file → edit', P.activityOf('edit_local_file'), 'edit');
  eq('apply_patch → edit', P.activityOf('apply_patch'), 'edit');
  eq('run_command → commands', P.activityOf('run_command'), 'commands');
  eq('run_local_command → commands', P.activityOf('run_local_command'), 'commands');
  eq('terminal_* 前缀 → commands', P.activityOf('terminal_open'), 'commands');
  eq('write_stdin → commands', P.activityOf('write_stdin'), 'commands');
  eq('web_search → webSearch', P.activityOf('web_search'), 'webSearch');
  eq('web_fetch → webFetch', P.activityOf('web_fetch'), 'webFetch');
  eq('subagent → subagents', P.activityOf('subagent'), 'subagents');
  eq('subagent_* 前缀 → subagents', P.activityOf('subagent_kill'), 'subagents');
  eq('todo_write → plan', P.activityOf('todo_write'), 'plan');
  eq('update_goal → plan', P.activityOf('update_goal'), 'plan');
  eq('ask_user_question → questions', P.activityOf('ask_user_question'), 'questions');
  eq('未知工具 → tools', P.activityOf('browser_click'), 'tools');
  eq('空名不崩', P.activityOf(''), 'tools');
}

console.log('\n[二] 实时详情:从参数里挑一句话');
{
  // 键优先级:title > description > command > path
  eq('取 title', P.liveToolDetail('x', JSON.stringify({ title: '构建项目', command: 'npm run build' })), '构建项目');
  eq('title 缺失时退到 command', P.liveToolDetail('x', JSON.stringify({ command: 'npm test' })), 'npm test');
  eq('取 path', P.liveToolDetail('read_file', JSON.stringify({ path: '/a/b.ts' })), '/a/b.ts');
  eq('questions 取第一个 question', P.liveToolDetail('ask_user_question', JSON.stringify({ questions: [{ question: '选哪个?' }] })), '选哪个?');
  eq('数组值用逗号连接', P.liveToolDetail('x', JSON.stringify({ queries: ['a', 'b'] })), 'a, b');
  eq('空白折叠', P.liveToolDetail('x', JSON.stringify({ command: 'a\n\n  b' })), 'a b');
  eq('没有可用字段 → 空串', P.liveToolDetail('x', JSON.stringify({ unrelated: 'zzz' })), '');
  eq('空参数 → 空串', P.liveToolDetail('x', ''), '');
  // 流式半截 JSON:必须走正则兜底,不能抛
  eq('半截 JSON 仍能取到已到达的字段', P.liveToolDetail('x', '{"command":"npm ru'), 'npm ru');
  eq('半截 JSON 无明显字段 → 空串', P.liveToolDetail('x', '{"unrel'), '');
  check('坏 JSON 不抛异常', (() => { try { P.liveToolDetail('x', '{oops'); return true; } catch { return false; } })());
}
{
  // 截断:dsh 的 160 字上限,超出加省略号;按码点切,不截断代理对
  const long = 'a'.repeat(200);
  const d = P.normalizeDetail(long);
  check('超长被截断到 160 字含省略号', Array.from(d).length === 160 && d.endsWith('…'), `len=${Array.from(d).length}`);
  check('刚好 160 不截断', P.normalizeDetail('a'.repeat(160)).length === 160);
  const emoji = '🙂'.repeat(200);
  const de = P.normalizeDetail(emoji);
  check('emoji 不被截成半个代理对', !/[\uD800-\uDBFF]$/.test(de), '尾部是孤立高代理');
}

console.log('\n[三] 汇总:计数降序 + 去重 + 正在跑什么');
{
  const items = [
    { kind: 'tool', call: tool('1', 'read_file') },
    { kind: 'tool', call: tool('2', 'read_file') },
    { kind: 'tool', call: tool('3', 'edit_file') },
    { kind: 'tool', call: tool('4', 'run_command') },
    { kind: 'tool', call: tool('5', 'read_file') }
  ];
  const s = P.summarize(items);
  eq('counts 按数量降序', s.counts, [{ kind: 'read', count: 3 }, { kind: 'edit', count: 1 }, { kind: 'commands', count: 1 }]);
  check('全部已结束 → 无 running', s.running === undefined);
}
{
  // 同一个 callId 重复投递只算一次(否则标题会出现「已读取文件并读取文件」)
  const items = [
    { kind: 'tool', call: tool('same', 'read_file') },
    { kind: 'tool', call: tool('same', 'read_file') },
    { kind: 'tool', call: tool('same', 'read_file') }
  ];
  eq('重复 callId 去重', P.summarize(items).counts, [{ kind: 'read', count: 1 }]);
}
{
  // 正在跑:取数组里**最后一次**没有结果的调用(数组顺序即发生顺序)
  const items = [
    { kind: 'tool', call: tool('1', 'read_file', '{"path":"/a"}') },
    { kind: 'tool', call: tool('2', 'edit_file', '{"path":"/b"}', { live: true }) }
  ];
  const s = P.summarize(items);
  eq('running 是最近那次未结束的调用', s.running, 'edit');
  eq('runningDetail 来自它的参数', s.runningDetail, '/b');
}
{
  // 服务端没上报耗时,但 ok 有值 = 已结束:不能一直当"在跑"(否则组头永远转圈)
  const items = [{ kind: 'tool', call: { id: '1', tool: 'run_command', args: '{"command":"x"}', ok: true, ms: null, result: '' } }];
  check('ok 有值即视为已结束(不依赖 ms)', P.summarize(items).running === undefined);
}
{
  // 失败的不算"正在跑"(否则会一直转圈)
  const items = [{ kind: 'tool', call: tool('1', 'run_command', '{"command":"x"}', { ok: false }) }];
  check('失败的调用不算 running', P.summarize(items).running === undefined);
}
{
  // 没有 running 时,详情回落到**最后一段思考**(dsh 的 liveReasoningDetail)
  const items = [
    { kind: 'reasoning', text: '先看目录结构\n\n再决定改哪里' },
    { kind: 'tool', call: tool('1', 'read_file', '{}', { ms: 5 }) }
  ];
  const s = P.summarize(items);
  check('无 running 时用思考兜底', s.runningDetail === '再决定改哪里', s.runningDetail);
  eq('思考兜底会去掉 markdown 粗体', P.summarize([
    { kind: 'reasoning', text: '**重点**:这样做' }
  ]).runningDetail, '重点:这样做');
  eq('已经没有任何 running 时思考兜底仍取最后一段', P.summarize([
    { kind: 'reasoning', text: 'aaa\n\nbbb' }
  ]).runningDetail, 'bbb');
}

console.log('\n[四] 标题:运行中 / 已结束(含共享前缀去重)');
{
  const mk = (names) => P.summarize(names.map((n, i) => ({ kind: 'tool', call: tool(String(i), n, '{}', { ms: 1 }) })));
  eq('单类:已读取文件', P.doneTitle(mk(['read_file'])), '已读取文件');
  eq('两类共享「已」前缀 → 去重', P.doneTitle(mk(['read_file', 'search_code'])), '已读取文件并搜索代码');
  eq('两类不共享前缀 → 保留', P.doneTitle(mk(['read_file', 'edit_file'])), '已读取文件并修改了文件');
  eq('三类共享前缀', P.doneTitle(mk(['read_file', 'search_code', 'write_file'])), '已读取文件，搜索代码，写入文件');
  eq('超过三类加「等」', P.doneTitle(mk(['read_file', 'search_code', 'write_file', 'run_command'])), '已读取文件，搜索代码，写入文件等');
  eq('空组 → 已完成分析', P.doneTitle(P.summarize([])), '已完成分析');
  // 排序影响标题:数量多的排前面
  eq('按数量降序决定第一个标签', P.doneTitle(mk(['edit_file', 'read_file', 'read_file'])), '已读取文件并修改了文件');
}
{
  const live = P.summarize([{ kind: 'tool', call: tool('1', 'read_file', '{"path":"/a.ts"}', { live: true }) }]);
  eq('运行中带详情', P.groupTitle(live, false), '正在读取文件 · /a.ts');
  const noDetail = P.summarize([{ kind: 'reasoning', text: '' }, { kind: 'tool', call: tool('1', 'read_file', '{}', { live: true }) }]);
  eq('无详情时只有前半句', P.groupTitle(noDetail, false), '正在读取文件');
  eq('准备中', P.liveLabel({ counts: [], running: 'edit', runningDetail: '', preparing: true }), '准备编辑文件');
  eq('准备中且 thinking → 归到 tools', P.liveLabel({ counts: [], running: undefined, runningDetail: '', preparing: true }), '准备调用工具');
  eq('无任何活动 → 正在分析请求', P.liveLabel({ counts: [], running: undefined, runningDetail: '' }), '正在分析请求');
  const done = P.summarize([{ kind: 'tool', call: tool('1', 'read_file', '{}', { ms: 3 }) }]);
  eq('已结束标题忽略 runningDetail', P.groupTitle(done, true), '已读取文件');
}

console.log('\n[五] 分组:正文关组(最关键的一条)');
{
  // 思考+工具 → 正文 → 工具:必须分成两组,正文在中间
  const segs = [
    { kind: 'reasoning', text: '想一下' },
    { kind: 'tools', tools: [tool('1', 'read_file')] },
    { kind: 'text', text: '我读完了,现在改' },
    { kind: 'tools', tools: [tool('2', 'edit_file', '{}', { ms: 2 })] }
  ];
  const units = P.planGroups(segs);
  eq('单元类型序列 = 组,正文,组', units.map((u) => u.kind), ['group', 'text', 'group']);
  eq('第一组成员 = 思考段 + 工具段', units[0].memberIndexes, [0, 1]);
  eq('正文段下标正确', units[1].index, 2);
  eq('第二组只含正文之后的工具段', units[2].memberIndexes, [3]);
  eq('第一组含 1 次工具 + 1 段思考', units[0].items.length, 2);
  eq('第二组只含 1 次工具', units[2].items.length, 1);
}
{
  // 没有正文:整条消息只有一个组
  const units = P.planGroups([
    { kind: 'tools', tools: [tool('1', 'read_file')] },
    { kind: 'tools', tools: [tool('2', 'read_file')] }
  ]);
  eq('连续工具段合成一个组', units.length, 1);
  eq('组成员是两个段', units[0].memberIndexes, [0, 1]);
  eq('组内两次调用', units[0].items.length, 2);
}
{
  // 只有正文:没有组
  const units = P.planGroups([{ kind: 'text', text: '你好' }]);
  eq('只有正文 → 无组', units.map((u) => u.kind), ['text']);
  eq('空 segments 不产组', P.planGroups([]).length, 0);
}
{
  // 正文把工具段切成三组
  const units = P.planGroups([
    { kind: 'tools', tools: [tool('1', 'read_file')] },
    { kind: 'text', text: 'a' },
    { kind: 'tools', tools: [tool('2', 'edit_file')] },
    { kind: 'text', text: 'b' },
    { kind: 'tools', tools: [tool('3', 'run_command')] }
  ]);
  eq('正文分段产生三组两组正文', units.map((u) => u.kind), ['group', 'text', 'group', 'text', 'group']);
}
{
  // 未知段型:既不参与分组也不丢(避免将来加段型时内容凭空消失)
  const units = P.planGroups([{ kind: 'tools', tools: [tool('1', 'read_file')] }, { kind: 'weird' }]);
  eq('未知段型不破坏分组', units.map((u) => u.kind), ['group']);
}
{
  // 组的 summary 必须已经算好(渲染时直接读)
  const units = P.planGroups([
    { kind: 'tools', tools: [tool('1', 'read_file'), tool('2', 'read_file')] }
  ]);
  eq('组的 summary 已预计算', units[0].summary.counts, [{ kind: 'read', count: 2 }]);
}

console.log('\n[六] 组是否还在跑');
{
  check('有未结束调用 → live', P.isGroupLive([{ kind: 'tool', call: tool('1', 'read_file', '{}', { live: true }) }]));
  check('全部已结束 → 非 live', !P.isGroupLive([{ kind: 'tool', call: tool('1', 'read_file') }]));
  check('只有思考 → 非 live', !P.isGroupLive([{ kind: 'reasoning', text: 'x' }]));
  check('失败的调用 → 非 live(不然会一直转圈)', !P.isGroupLive([{ kind: 'tool', call: tool('1', 'x', '{}', { ok: false }) }]));
  check('一个在跑一个已完 → live', P.isGroupLive([
    { kind: 'tool', call: tool('1', 'read_file') },
    { kind: 'tool', call: tool('2', 'edit_file', '{}', { live: true }) }
  ]));
}

console.log('\n[七] 回合过程折叠行:时长格式与文案(对齐 dsh TurnProcessNodeView)');
{
  // 用户实测的这个例子必须逐字对上
  eq('139 秒 → 已完成，用时 2分19秒', P.turnProcessLabel('completed', 139_000), '已完成，用时 2分19秒');
  // 不足 1 分钟只出秒(不出「0分」)
  eq('45 秒 → 只出秒', P.turnProcessLabel('completed', 45_000), '已完成，用时 45秒');
  // 整分也要带秒(dsh 的 formatRunDuration 秒总是输出)
  eq('60 秒 → 1分0秒', P.turnProcessLabel('completed', 60_000), '已完成，用时 1分0秒');
  eq('2 分整 → 2分0秒', P.turnProcessLabel('completed', 120_000), '已完成，用时 2分0秒');
  // 小时级
  eq('1 小时 2 分 3 秒', P.turnProcessLabel('completed', 3_723_000), '已完成，用时 1小时2分3秒');
  // 中断 / 出错**不显示耗时**(dsh 的 duration 在这两种 reason 下为 undefined)
  eq('中断 → 已停止(无耗时)', P.turnProcessLabel('aborted', 139_000), '已停止');
  eq('出错 → 处理失败(无耗时)', P.turnProcessLabel('error', 139_000), '处理失败');
  // 没有耗时数据时只给「已完成」
  eq('无耗时 → 已完成', P.turnProcessLabel('completed', undefined), '已完成');
  eq('未知原因按完成处理', P.turnProcessLabel('max-iters', 5_000), '已完成，用时 5秒');
  // 负数/非法值夹到 0,不出现负时长
  eq('负数夹到 0', P.turnProcessLabel('completed', -5_000), '已完成，用时 0秒');
  // 片段结构:数字与单位分开(组件据此只给数字套等宽字体)
  const { prefix, parts } = P.turnProcessParts('completed', 139_000);
  eq('前缀含尾随空格(逐字对齐 dsh)', prefix, '已完成，用时 ');
  eq('片段 = 2/分/19/秒', parts.map((p) => p.text), ['2', '分', '19', '秒']);
  eq('只有数字片段标记 numeric', parts.map((p) => p.numeric), [true, false, true, false]);
}

console.log('\n[八] 显示模式开关(对齐 dsh 的 TranscriptViewMode)');
{
  // standard(dsh 默认):总是折成一行 —— 运行中也只有那行扫光标题
  check('standard:运行中也折叠', P.groupedFor('standard', true) === true);
  check('standard:结束后也折叠', P.groupedFor('standard', false) === true);
  // detailed:进行中完全展开(能看着它一步步干),结束后才折叠
  check('detailed:运行中不折叠', P.groupedFor('detailed', true) === false);
  check('detailed:结束后折叠', P.groupedFor('detailed', false) === true);
  // verbose:从不折叠(诊断用)
  check('verbose:运行中不折叠', P.groupedFor('verbose', true) === false);
  check('verbose:结束后也不折叠', P.groupedFor('verbose', false) === false);
  check('默认模式就是 dsh 的默认值 standard', P.TRANSCRIPT_MODE === 'standard', P.TRANSCRIPT_MODE);
}

console.log('\n[九] 投影回填回合计时(不新增行 —— 下标口径必须不变)');
{
  const { projectEvents } = await import('../server/agent/agent.ts');
  const ev = (seq, time, type, data) => ({ seq, time, type, data });
  const base = [
    ev(1, 10_000, 'turn/start', { turn: 1 }),
    ev(2, 10_100, 'user/message', { content: '干活' }),
    ev(3, 12_000, 'assistant/message', { message: { content: '第一步' } }),
    ev(4, 15_000, 'assistant/message', { message: { content: '完成' } })
  ];
  const ended = [...base, ev(5, 149_000, 'turn/end', { turn: 1, reason: { kind: 'completed' } })];
  const a = projectEvents(base);
  const b = projectEvents(ended);
  check('回填不新增行', a.length === b.length, `${a.length} → ${b.length}`);
  check('回填前没有耗时', a[1].turnElapsedMs === undefined);
  // dsh 的取值:max(1000, end - start) = 149000 - 10000 = 139000
  check('耗时 = turn/end − turn/start', b[1].turnElapsedMs === 139_000, String(b[1].turnElapsedMs));
  check('文案正好是 2分19秒', P.turnProcessLabel(b[1].turnEndReason, b[1].turnElapsedMs) === '已完成，用时 2分19秒',
    P.turnProcessLabel(b[1].turnEndReason, b[1].turnElapsedMs));
  check('本轮所有 assistant 行都回填', b[1].turnElapsedMs === 139_000 && b[2].turnElapsedMs === 139_000);
  check('结束原因随行下发', b[1].turnEndReason === 'completed', String(b[1].turnEndReason));
  check('正文内容未被改动', b[1].content === '第一步' && b[2].content === '完成');
  check('user 行不带回合计时', a[0].turnElapsedMs === undefined && b[0].turnElapsedMs === undefined);
}
{
  const { projectEvents } = await import('../server/agent/agent.ts');
  const ev = (seq, time, type, data) => ({ seq, time, type, data });
  // 亚秒级回合:夹到 1000ms,不显示成 0 秒
  const out = projectEvents([
    ev(1, 10_000, 'turn/start', { turn: 1 }),
    ev(2, 10_200, 'assistant/message', { message: { content: 'x' } }),
    ev(3, 10_300, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  ]);
  check('亚秒级回合夹到 1 秒', out[0].turnElapsedMs === 1000, String(out[0].turnElapsedMs));
  // 中断:耗时照常下发,但文案不带耗时
  const ab = projectEvents([
    ev(1, 10_000, 'turn/start', { turn: 1 }),
    ev(2, 10_500, 'assistant/message', { message: { content: 'x' } }),
    ev(3, 60_000, 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  ]);
  check('中断的行带 aborted 原因', ab[0].turnEndReason === 'aborted', String(ab[0].turnEndReason));
  check('中断的折叠行只显示「已停止」', P.turnProcessLabel(ab[0].turnEndReason, ab[0].turnElapsedMs) === '已停止');
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
