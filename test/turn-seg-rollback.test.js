// 本步半成品回滚测试(前端纯函数):模型请求中途失败自动重发这一步之前,必须精确切掉
// 「本步已流出但尚未落盘」的段——既不能留下半句导致重试后正文重复,也不能误删前面步骤
// 已经落定的正文与工具卡片。
const { rollbackPartialSegments } = await import('../web/src/utils/rollbackPartial.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const shape = (segs) => segs.map((s) => (s.kind === 'tools' ? `tools(${s.tools.length})` : `${s.kind}:${s.text}`)).join(' | ');

console.log('== 本步半成品回滚 ==');

// 1) 第二步(工具步之后)流了一半正文就中断:起点=2,只切掉这半句
{
  const msg = {
    stepSegBase: 2,
    segments: [
      { kind: 'reasoning', text: '第一步思考' },
      { kind: 'tools', tools: [{ id: 'c1' }, { id: 'c2' }] },
      { kind: 'text', text: '重试后会重新生成的半句' }
    ]
  };
  const got = rollbackPartialSegments(msg);
  check('切掉本步半成品正文', shape(got) === 'reasoning:第一步思考 | tools(2)', shape(got));
}

// 2) 第二步只流了思考就被掐断(reasoning 先行的真实故障形态):也要切掉
{
  const msg = {
    stepSegBase: 2,
    segments: [
      { kind: 'text', text: '第一步正文' },
      { kind: 'tools', tools: [{ id: 'c1' }] },
      { kind: 'reasoning', text: '本步已流出的思考' }
    ]
  };
  check('切掉本步半成品思考', shape(rollbackPartialSegments(msg)) === 'text:第一步正文 | tools(1)', shape(rollbackPartialSegments(msg)));
}

// 3) 本步还没流出任何内容:原样返回,不动前面已落定的段
{
  const msg = {
    stepSegBase: 2,
    segments: [{ kind: 'text', text: '上一步正文' }, { kind: 'tools', tools: [{ id: 'c1' }] }]
  };
  check('无增量时不动已落定段', shape(rollbackPartialSegments(msg)) === 'text:上一步正文 | tools(1)', shape(rollbackPartialSegments(msg)));
}

// 4) 每一步只要有工具调用就必然以 tools 段收尾:跨多步连续重试也只切本步
{
  const msg = {
    stepSegBase: 4,
    segments: [
      { kind: 'reasoning', text: 's1' },
      { kind: 'tools', tools: [{ id: 'a' }] },
      { kind: 'text', text: 's2' },
      { kind: 'tools', tools: [{ id: 'b' }] },
      { kind: 'reasoning', text: '本步半成品思考' },
      { kind: 'text', text: '本步半成品正文' }
    ]
  };
  check('多步会话只回滚最后一步', shape(rollbackPartialSegments(msg)) === 'reasoning:s1 | tools(1) | text:s2 | tools(1)', shape(rollbackPartialSegments(msg)));
}

// 5) 缺起点(历史回放等):退化为丢掉尾部所有非 tools 段
{
  const msg = { segments: [{ kind: 'text', text: '已落定正文' }, { kind: 'tools', tools: [{ id: 'a' }] }, { kind: 'text', text: '半成品' }] };
  check('缺起点时丢尾部非 tools 段', shape(rollbackPartialSegments(msg)) === 'text:已落定正文 | tools(1)', shape(rollbackPartialSegments(msg)));
}

// 6) 脏数据/空消息不应抛错
{
  check('空 segments 返回空数组', rollbackPartialSegments({}).length === 0);
  check('起点越界走兜底而非报错', shape(rollbackPartialSegments({ stepSegBase: 99, segments: [{ kind: 'tools', tools: [{ id: 'a' }] }, { kind: 'text', text: 'x' }] })) === 'tools(1)');
  check('起点为 0 时清空本步全部增量', rollbackPartialSegments({ stepSegBase: 0, segments: [{ kind: 'text', text: 'x' }] }).length === 0);
}

console.log(`\n== 结果:${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
