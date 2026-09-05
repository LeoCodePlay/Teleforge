// 上下文窗口自动压缩单元测试:
// - estimateTokens / resolveCompactSpec / selectCompactRange 纯函数行为
// - compactHistory:未配置不压缩、未超阈值不压缩、超限压缩为摘要+保留最近、摘要失败降级裁剪
// - Session 集成:squash 压缩区间替换后,deriveMessages 投影仍为合法消息序列(以 user 开头、tool 配对完整)
import { Session, eventsFromTurns } from '../server/agent/session.ts';
import {
  estimateTokens, messageTokens, measureMessages, resolveCompactSpec,
  selectCompactRange, compactHistory, compactionInstruction
} from '../server/agent/compact.ts';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

// 严格校验 OpenAI 兼容消息序列:tool 消息必须紧跟一个带匹配 tool_call_id 的 assistant 消息
function assertValidApiSequence(msgs) {
  const errs = [];
  let pending = new Set();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant') pending = new Set((m.tool_calls || []).map((t) => t.id));
    else if (m.role === 'user') pending = new Set();
    else if (m.role === 'tool') {
      if (!pending.has(m.tool_call_id)) errs.push(`messages[${i}] 的 tool 消息缺少前置 assistant tool_calls`);
      else pending.delete(m.tool_call_id);
    }
  }
  return errs;
}
const finish = () => { console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`); if (fail) process.exit(1); };

// ---- estimateTokens ----
{
  const t = estimateTokens('hello world');
  check('estimateTokens 英文保守估为正', t > 0 && t <= 8, `got ${t}`);
  const t2 = estimateTokens('你好世界这是一段中文文本');
  check('estimateTokens 中文按 1.6 字符/token', t2 >= 6 && t2 <= 10, `got ${t2}`);
  check('estimateTokens 空串为 0', estimateTokens('') === 0);
  check('estimateTokens null 为 0', estimateTokens(null) === 0);
  const msgs = [{ role: 'user', content: '你好' }];
  check('messageTokens 含 JSON 结构开销', messageTokens(msgs[0]) > estimateTokens('你好'));
  check('measureMessages 累加', measureMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]) >= 2);
}

// ---- resolveCompactSpec ----
{
  const spec = resolveCompactSpec(64000, 8192);
  check('resolveCompactSpec 窗口 64k/输出 8k 触发阈值', spec.thresholdTokens === Math.floor((64000 - 8192) * 0.8), `got ${spec.thresholdTokens}`);
  check('resolveCompactSpec 保留窗口', spec.retainTokens === 10240, `got ${spec.retainTokens}`);
  check('resolveCompactSpec 未配置窗口禁用', resolveCompactSpec(0, 8192).enabled === false);
}

// ---- selectCompactRange(位置式:切点对齐工具配对边界,单组对话也可压缩) ----
{
  const mk = (role, content, extra = {}) => ({ role, content, ...extra });
  const hist = [
    mk('user', 'q0'), mk('assistant', 'a0'),
    mk('user', 'q1'), mk('assistant', '', { tool_calls: [{ id: 'c1', function: { name: 't', arguments: '{}' } }] }), mk('tool', 'r1', { tool_call_id: 'c1' }), mk('assistant', 'a1'),
    mk('user', 'q2'), mk('assistant', 'a2')
  ];
  const range = selectCompactRange(hist, 4);
  check('selectCompactRange 有可压缩区间', range !== null);
  if (range) {
    check('selectCompactRange 无消息丢失', range.drop.length + range.recent.length === hist.length);
    // 切点处工具配对完整:把保留区拼在一条摘要 user 之后,序列必须合法
    check('selectCompactRange 切点工具配对完整', assertValidApiSequence([mk('user', '摘要'), ...range.recent]).length === 0);
  }
  check('selectCompactRange 历史过短返回 null', selectCompactRange([mk('user', 'a'), mk('assistant', 'b')], 4) === null);
  check('selectCompactRange 两条消息返回 null', selectCompactRange([mk('user', 'a'), mk('assistant', 'b'), mk('user', 'c'), mk('assistant', 'd')].slice(0, 2), 999999) === null);
  // 保留水位覆盖全部历史:无需压缩(旧"退化保留最后一组"语义已并入 compactNow 的兜底分支)
  const two = [mk('user', 'q0'), mk('assistant', 'a0'), mk('user', 'q1'), mk('assistant', 'a1')];
  check('selectCompactRange 全在保留水位内返回 null', selectCompactRange(two, 999999) === null);

  // 核心新能力:单组(单条 user 消息)深工具任务可以中途压缩
  const single = [
    mk('user', '任务'),
    mk('assistant', '', { tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{}' } }] }), mk('tool', 'r1', { tool_call_id: 'c1' }), mk('assistant', '分析1'),
    mk('assistant', '', { tool_calls: [{ id: 'c2', function: { name: 'edit_file', arguments: '{}' } }] }), mk('tool', 'r2', { tool_call_id: 'c2' }), mk('assistant', '结论')
  ];
  const sr = selectCompactRange(single, 4);
  check('selectCompactRange 单组深任务可压缩', sr !== null);
  if (sr) {
    check('selectCompactRange 单组压缩切点配对完整', assertValidApiSequence([mk('user', '摘要'), ...sr.recent]).length === 0);
    check('selectCompactRange 单组压缩保留尾部结论', sr.recent[sr.recent.length - 1]?.content === '结论');
  }

  // 切点对齐:retain=0 时切点必须回退过最后一对未消费的 tool_calls,保留完整的配对
  const bigCalls = [mk('user', 'u'), mk('assistant', 'a')];
  for (let i = 0; i < 5; i++) {
    bigCalls.push(mk('assistant', '', { tool_calls: [{ id: `c${i}`, function: { name: 't', arguments: '{}' } }] }));
    bigCalls.push(mk('tool', 'r', { tool_call_id: `c${i}` }));
  }
  bigCalls.push(mk('assistant', '', { tool_calls: [{ id: 'cLast', function: { name: 't', arguments: '{}' } }] }));
  bigCalls.push(mk('tool', 'r', { tool_call_id: 'cLast' }));
  const br = selectCompactRange(bigCalls, 0);
  check('selectCompactRange retain=0 切点回退到配对完整处',
    br !== null && br.recent.length === 2 && br.recent[0].role === 'assistant' && br.recent[1].role === 'tool'
    && assertValidApiSequence([mk('user', '摘要'), ...br.recent]).length === 0);
  check('compactionInstruction 非空且含保留要求', compactionInstruction().includes('任务'));
}

// ---- compactHistory ----
{
  const big = [];
  for (let i = 0; i < 10; i++) {
    big.push({ role: 'user', content: `第${i}条用户消息,` + '内容比较长以增大占用的上下文窗口尺寸估算值。'.repeat(30) });
    big.push({ role: 'assistant', content: `回答${i}:` + '说明做了哪些操作以及文件内容摘要,重复文本用于撑大 token 估算。'.repeat(30) });
  }

  // 未配置 contextWindow:不启用
  {
    const c = await compactHistory({ messages: big, system: 'sys', llm: null, contextWindow: 0, maxTokens: 0 });
    check('compactHistory 未配置窗口不压缩', c.compacted === false && c.messages === big);
  }
  // 未超阈值:不压缩
  {
    const c = await compactHistory({ messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '回答' }], llm: null, contextWindow: 1000000, maxTokens: 8192 });
    check('compactHistory 未超阈值不压缩', c.compacted === false);
  }
  // 超大窗口 + 摘要生成成功
  {
    let summarizeCalls = 0;
    const fakeLlm = {
      isMock: false,
      async chat({ messages, tools, reasoning }) {
        summarizeCalls++;
        return { content: '这是自动生成的对话摘要。', toolCalls: [], reasoning: '' };
      }
    };
    const c = await compactHistory({ messages: big, system: 'system prompt', llm: fakeLlm, signal: null, contextWindow: 5000, maxTokens: 1024 });
    check('compactHistory 超限触发压缩', c.compacted === true && summarizeCalls === 1, `calls=${summarizeCalls}`);
    check('compactHistory 摘要消息为 user 且带前缀', c.messages[0]?.role === 'user' && /上下文已自动压缩/.test(c.messages[0].content));
    check('compactHistory 保留最近消息', c.messages[c.messages.length - 1] === big[big.length - 1]);
    check('compactHistory 摘要消息以 user 开头', c.messages[0].role === 'user');
    check('compactHistory 压缩后消息序列合法', assertValidApiSequence(c.messages).length === 0);
    check('compactHistory dropCount 正确', c.dropCount > 0 && c.dropCount < big.length, `drop=${c.dropCount}`);
  }
  // 摘要生成失败:降级为纯裁剪,不抛错
  {
    const badLlm = { isMock: false, async chat() { throw new Error('模拟摘要请求失败'); } };
    const c = await compactHistory({ messages: big, system: 'sys', llm: badLlm, signal: null, contextWindow: 5000, maxTokens: 1024 });
    check('compactHistory 摘要失败降级裁剪不抛错', c.compacted === true);
    check('compactHistory 降级消息含省略提示', /省略/.test(c.messages[0].content));
    check('compactHistory 降级结果序列合法', assertValidApiSequence(c.messages).length === 0);
  }
}

// ---- compactHistory 单组深工具任务:超限也能压缩(此前组级压缩永远够不着,回归测试) ----
{
  const single = [{ role: 'user', content: '完成一个复杂任务,' + '需要读取大量文件并逐个修改。'.repeat(40) }];
  for (let i = 0; i < 8; i++) {
    single.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
    single.push({ role: 'tool', tool_call_id: `c${i}`, content: `文件内容 ${i}:` + 'x'.repeat(1500) });
    single.push({ role: 'assistant', content: `第${i}步分析结论,` + '内容重复填充。'.repeat(40) });
  }
  const fakeLlm = {
    isMock: false,
    async chat({ messages, tools, reasoning }) { return { content: '这是自动生成的对话摘要。', toolCalls: [], reasoning: '' }; }
  };
  const c = await compactHistory({ messages: single, system: 'sys', llm: fakeLlm, signal: null, contextWindow: 6000, maxTokens: 1024 });
  check('compactHistory 单组深任务超限可压缩', c.compacted === true && c.dropCount > 0, `compacted=${c.compacted} drop=${c.dropCount}`);
  check('compactHistory 单组压缩后序列合法', assertValidApiSequence(c.messages).length === 0);
  check('compactHistory 单组压缩保留尾部', c.messages[c.messages.length - 1] === single[single.length - 1]);
}

// ---- Session.squash 集成:压缩替换后投影仍合法 ----
{
  const turns = [];
  for (let i = 0; i < 4; i++) {
    turns.push({ role: 'user', content: `第${i}轮:检查目录` });
    turns.push({
      role: 'assistant', content: '',
      tool_calls: [{ id: `c${i}`, function: { name: 'list_directory', arguments: '{}' } }]
    });
    turns.push({ role: 'tool', tool_call_id: `c${i}`, content: `目录内容 ${i}`, ok: true, ms: 5 });
    turns.push({ role: 'assistant', content: `第${i}轮结论` });
  }
  const session = new Session();
  for (const ev of eventsFromTurns(turns)) session.append(ev.type, ev.data);

  const trace = session.deriveMessagesWithTrace();
  check('squash 前 trace 与消息数一致', trace.length === 16, `got ${trace.length}`);
  const dropCount = 12; // 压缩前 3 组对话 = 12 条消息面事件(整组删除,保证保留区以 user 开头)
  const dropSeqs = trace.slice(0, dropCount).map((t) => t.seq);
  const anchorSeq = trace[dropCount] ? trace[dropCount].seq : null;
  session.squash(dropSeqs, '【上下文已自动压缩】早期对话摘要内容', anchorSeq, { dropCount, manual: true });

  const msgs = session.deriveMessages({});
  check('squash 后消息数 = 保留4条 + 摘要1条', msgs.length === 16 - dropCount + 1, `got ${msgs.length}`);
  check('squash 后首条为压缩摘要 user', msgs[0]?.role === 'user' && /上下文已自动压缩/.test(msgs[0].content));
  check('squash 后消息序列合法', assertValidApiSequence(msgs).length === 0);
  check('squash 后完整历史的最后一条不变', msgs[msgs.length - 1]?.content === '第3轮结论');
  check('squash 后 seq 连续单调', session.events.every((ev, i) => ev.seq === i));
  // 压缩标记元数据落事件:dropCount/manual 供前端渲染「压缩标记行」
  const done = session.events.find((ev) => ev.type === 'compaction/done');
  check('squash 后 compaction/done 携带 dropCount+manual', done && done.data.dropCount === dropCount && done.data.manual === true);
}

// ---- squash 区间删除回归:被压区间内的 tool/call 结构事件一并移除,轮末自愈不产生孤儿 ----
{
  const turns = [];
  for (let i = 0; i < 4; i++) {
    turns.push({ role: 'user', content: `第${i}轮:检查目录` });
    turns.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, function: { name: 'list_directory', arguments: '{}' } }] });
    turns.push({ role: 'tool', tool_call_id: `c${i}`, content: `目录内容 ${i}`, ok: true, ms: 5 });
    turns.push({ role: 'assistant', content: `第${i}轮结论` });
  }
  const session = new Session();
  for (const ev of eventsFromTurns(turns)) session.append(ev.type, ev.data);
  const trace = session.deriveMessagesWithTrace();
  const dropCount = 8; // 压掉前 2 组对话(8 条投影消息),其 tool/call 结构事件必须一并移除
  const dropSeqs = trace.slice(0, dropCount).map((t) => t.seq);
  const anchorSeq = trace[dropCount] ? trace[dropCount].seq : null;
  session.squash(dropSeqs, '【上下文已自动压缩】摘要', anchorSeq, { dropCount, manual: false });
  const remainingCalls = session.events.filter((ev) => ev.type === 'tool/call').length;
  check('squash 区间删除后被压组 tool/call 一并移除', remainingCalls === 2, `got ${remainingCalls}`);
  // 轮末自愈:遗留的 tool/call 会在这里补"中止"结果,产生无前置 assistant 的孤儿 tool 消息
  const healed = session.pendingToolCalls();
  check('squash 区间删除后轮末自愈无遗留', healed.length === 0, `遗留 ${healed.length} 个 tool/call`);
  const msgs = session.deriveMessages({});
  check('squash 区间删除后消息序列合法', assertValidApiSequence(msgs).length === 0);
  check('squash 区间删除后消息数正确', msgs.length === 16 - dropCount + 1, `got ${msgs.length}`);
}

// ---- 孤儿工具事件自愈与投影过滤(旧版压缩 bug 遗留的损坏日志) ----
{
  const s = new Session();
  s.append('user/message', { content: '任务', source: 'user' });
  s.append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] } });
  s.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 't', arguments: '{}' });
  s.append('tool/result', { turn: 1, step: 1, callId: 'c1', name: 't', isError: false, content: 'ok', ms: 0 });
  // 旧版压缩遗留的孤儿对:assistant 已删,tool/call + 轮末自愈补的"中止"结果残留
  s.append('tool/call', { turn: 1, step: 1, callId: 'orphan1', name: 't', arguments: '{}' });
  s.append('tool/result', { turn: 1, step: 1, callId: 'orphan1', name: 't', isError: true, content: '工具执行中止(本轮已停止)', ms: 0 });
  // 连 tool/call 都没有的纯孤儿结果
  s.append('tool/result', { turn: 1, step: 1, callId: 'orphan2', name: 't', isError: true, content: '工具执行中止(本轮已停止)', ms: 0 });

  const healed = new Session(s.events); // 构造载入 = 触发自愈
  const toolEvents = healed.events.filter((ev) => ev.type === 'tool/call' || ev.type === 'tool/result').length;
  check('载入自愈清除孤儿工具事件', toolEvents === 2, `got ${toolEvents}`);
  const msgs = healed.deriveMessages({});
  check('自愈后投影序列合法', assertValidApiSequence(msgs).length === 0);
  check('自愈后消息数正确', msgs.length === 3, `got ${msgs.length}`);

  // 投影过滤兜底:构造后手动 append 的孤儿(绕过 _heal,模拟运行中会话的驻内存损坏)不进投影
  healed.append('tool/call', { turn: 2, step: 1, callId: 'orphan3', name: 't', arguments: '{}' });
  healed.append('tool/result', { turn: 2, step: 1, callId: 'orphan3', name: 't', isError: true, content: '中止', ms: 0 });
  const msgs2 = healed.deriveMessages({});
  check('投影过滤跳过孤儿工具消息',
    msgs2.every((m) => m.role !== 'tool' || m.tool_call_id === 'c1') && assertValidApiSequence(msgs2).length === 0);
}

// ---- 加载迁移日志后也能识别旧格式消息(不回归) ----
{
  const evs = eventsFromTurns([
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '好的' }
  ]);
  const s = new Session(evs);
  check('旧格式迁移后 deriveMessages 正常', s.deriveMessages({})[0].role === 'user');
}

finish();