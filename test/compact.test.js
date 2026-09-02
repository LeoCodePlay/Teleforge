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

// ---- selectCompactRange ----
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
    check('selectCompactRange 保留区以 user 开头', range.recent[0]?.role === 'user');
    check('selectCompactRange 压缩区为空或含完整组', range.drop.length > 0);
    check('selectCompactRange 首条 user 不被拆开', range.recent[0]?.content === 'q1' || range.recent[0]?.content === 'q2');
  }
  check('selectCompactRange 历史过短返回 null', selectCompactRange([mk('user', 'a'), mk('assistant', 'b')], 4) === null);
  check('selectCompactRange 单组不可压返回 null', selectCompactRange([mk('user', 'a'), mk('assistant', 'b'), mk('user', 'c'), mk('assistant', 'd')].slice(0, 2), 999999) === null);
  // 两组且保留预算巨大:保留最后一条 user 组
  const two = [mk('user', 'q0'), mk('assistant', 'a0'), mk('user', 'q1'), mk('assistant', 'a1')];
  const r2 = selectCompactRange(two, 999999);
  check('selectCompactRange 两组时保留最后一组', r2 !== null && r2.recent[0]?.content === 'q1' && r2.drop.length === 2);
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
  session.squash(dropSeqs, '【上下文已自动压缩】早期对话摘要内容', anchorSeq);

  const msgs = session.deriveMessages({});
  check('squash 后消息数 = 保留4条 + 摘要1条', msgs.length === 16 - dropCount + 1, `got ${msgs.length}`);
  check('squash 后首条为压缩摘要 user', msgs[0]?.role === 'user' && /上下文已自动压缩/.test(msgs[0].content));
  check('squash 后消息序列合法', assertValidApiSequence(msgs).length === 0);
  check('squash 后完整历史的最后一条不变', msgs[msgs.length - 1]?.content === '第3轮结论');
  check('squash 后 seq 连续单调', session.events.every((ev, i) => ev.seq === i));
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