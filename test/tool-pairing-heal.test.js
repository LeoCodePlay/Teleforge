// 校验「assistant tool_calls 必须被后续 tool 消息完整应答」这条严格配对约束:
// 上游网关(litellm)在配对不完整时会 400 拒绝:
//   An assistant message with 'tool_calls' must be followed by tool messages responding
//   to each 'tool_call_id'. (insufficient tool messages following tool_calls message)
// 本测试覆盖两类历史损坏:模型响应流被截断(工具根本没开始执行,日志里连 tool/call 都没有)、
// 中止发生在并行池启动之前(声明了 3 个调用,只启动了 1 个)。
import { Session } from '../server/agent/session.ts';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

/** litellm 口径:assistant 声明的每个 tool_call_id 都必须有紧跟其后的 tool 消息应答 */
function pairingErrors(msgs) {
  const errs = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) continue;
    const ids = m.tool_calls.map((t) => t.id);
    const answered = new Set();
    for (let j = i + 1; j < msgs.length && msgs[j].role === 'tool'; j++) answered.add(msgs[j].tool_call_id);
    const missing = ids.filter((id) => !answered.has(id));
    if (missing.length) errs.push(`messages[${i}] 声明 ${ids.length} 个 tool_calls,只有 ${answered.size} 条 tool 消息应答,缺 ${missing.join(',')}`);
  }
  return errs;
}

const call = (id, name = 'run_local_command') => ({
  id, type: 'function', function: { name, arguments: '{"command":"echo hi"}' }
});

// ---- 场景 1:模型响应流被截断,工具调用从未执行(日志里没有 tool/call) ----
{
  const s = new Session([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: '看看这个项目', source: 'user' } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: '先查目录', tool_calls: [call('c1'), call('c2')] } } },
    { type: 'step/end', data: { turn: 1, step: 1, finishReason: null, truncated: true, toolCalls: 2 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'truncated' } } }
  ]);
  const msgs = s.deriveMessages({});
  const errs = pairingErrors(msgs);
  check('截断步:投影出的历史工具配对完整(不再触发上游 400)', errs.length === 0, errs.join(' | '));
  // 载入自愈:声明了却从未启动的两个调用必须被补上"中止"结果(旧实现只按 tool/call 统计,漏检)
  const results = s.events.filter((e) => e.type === 'tool/result');
  check('截断步:载入自愈给"只声明未执行"的调用补上了结果',
    results.length === 2 && results.every((e) => /中止|未完成/.test(e.data.content)),
    `实际补了 ${results.length} 条:${JSON.stringify(results.map((e) => e.data.callId))}`);
  check('截断步:补结果后 pendingToolCalls 清零', s.pendingToolCalls().length === 0);
}

// ---- 场景 2:中止发生在并行池启动之前(声明 3 个,只启动了 1 个) ----
{
  const s = new Session([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: '批量改三处', source: 'user' } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: '', tool_calls: [call('a', 'edit_file'), call('b', 'edit_file'), call('c', 'edit_file')] } } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'a', name: 'edit_file', arguments: '{}' } },
    { type: 'tool/result', data: { turn: 1, step: 1, callId: 'a', name: 'edit_file', isError: false, content: 'ok', ms: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', cause: 'user' } } }
  ]);
  const errs = pairingErrors(s.deriveMessages({}));
  check('中止步:投影出的历史工具配对完整', errs.length === 0, errs.join(' | '));
}

// ---- 场景 3:工具结果与 assistant 之间夹了一条 user 消息(投影层会把结果当孤儿丢弃) ----
// 3a 运行中的会话(事件是边跑边 append 的,不经过载入自愈)
{
  const s = new Session();
  for (const ev of [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: '跑一下', source: 'user' } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: '', tool_calls: [call('x')] } } },
    { type: 'user/message', data: { content: '等一下,先别跑', source: 'user' } },
    { type: 'tool/result', data: { turn: 1, step: 1, callId: 'x', name: 'run_local_command', isError: false, content: 'done', ms: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  ]) s.append(ev.type, ev.data);
  const msgs = s.deriveMessages({});
  const errs = pairingErrors(msgs);
  check('结果被 user 消息隔开(运行中):投影层仍产出合法序列', errs.length === 0, errs.join(' | '));
  check('结果被 user 消息隔开(运行中):错位结果的真实内容被提到声明之后,不丢',
    msgs.some((m) => m.role === 'tool' && m.content === 'done'), JSON.stringify(msgs.map((m) => m.role)));
}
// 3b 已落盘会话(载入自愈已把孤儿结果从日志清掉):内容不可恢复,但序列必须合法
{
  const s = new Session([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: '跑一下', source: 'user' } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: '', tool_calls: [call('y')] } } },
    { type: 'user/message', data: { content: '等一下,先别跑', source: 'user' } },
    { type: 'tool/result', data: { turn: 1, step: 1, callId: 'y', name: 'run_local_command', isError: false, content: 'done', ms: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  ]);
  const msgs = s.deriveMessages({});
  const errs = pairingErrors(msgs);
  check('结果被 user 消息隔开(已落盘):投影层仍产出合法序列', errs.length === 0, errs.join(' | '));
}

// ---- 场景 4:同一条 assistant 里出现重复的 tool_call id(网关偶发),按条数补足 ----
{
  const s = new Session([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: '改两处', source: 'user' } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: '', tool_calls: [call('dup'), call('dup')] } } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'dup', name: 'run_local_command', arguments: '{}' } },
    { type: 'tool/result', data: { turn: 1, step: 1, callId: 'dup', name: 'run_local_command', isError: false, content: 'ok', ms: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  ]);
  const msgs = s.deriveMessages({});
  const errs = pairingErrors(msgs);
  const toolMsgs = msgs.filter((m) => m.role === 'tool').length;
  check('重复 id:两条声明都能拿到 tool 消息应答(网关按条数校验)', errs.length === 0 && toolMsgs === 2,
    `${errs.join(' | ')} tool 消息数=${toolMsgs}`);
}

// ---- 场景 5:视觉附件结果(截图)仍必须落在整组工具结果之后 ----
{
  const s = new Session([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: '看一下屏幕', source: 'user' } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: '', tool_calls: [call('v1', 'computer_screenshot'), call('v2')] } } },
    { type: 'tool/result', data: { turn: 1, step: 1, callId: 'v2', name: 'run_local_command', isError: false, content: 'ok', ms: 1 } },
    { type: 'tool/result', data: { turn: 1, step: 1, callId: 'v1', name: 'computer_screenshot', isError: false, content: 'shot', ms: 1, meta: { visionAttachments: [{ id: 'att_1', kind: 'image' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  ]);
  const msgs = s.deriveMessages({});
  const errs = pairingErrors(msgs);
  const lastTool = msgs.map((m) => m.role).lastIndexOf('tool');
  const visionUser = msgs.findIndex((m) => m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length);
  check('视觉附件:配对完整且画面 user 消息排在工具结果之后',
    errs.length === 0 && lastTool >= 0 && visionUser > lastTool,
    `${errs.join(' | ')} lastTool=${lastTool} visionUser=${visionUser}`);
}

// ---- 场景 6:发送前校验必须在本地拦下"应答不足"的请求(而不是让上游 400) ----
{
  const { LlmClient } = await import('../server/agent/llm.ts');
  const llm = new LlmClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'deepseek-flash' });
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [call('p1'), call('p2')] },
    { role: 'tool', tool_call_id: 'p1', content: 'ok' }
  ];
  let err = '';
  try { await llm.chat({ messages: msgs }); } catch (e) { err = String(e?.message || e); }
  check('发送前校验:应答不足的请求被本地拒绝且原因可读',
    /insufficient tool messages/.test(err) && /p2/.test(err), err);
  // 合法序列(每个声明都有应答)不应被本地拦下:用 mock 模型避免真的发请求
  const mock = new LlmClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'mock' });
  let okErr = '';
  try {
    await mock.chat({ messages: [...msgs.slice(0, 3), { role: 'tool', tool_call_id: 'p1', content: 'ok' }, { role: 'tool', tool_call_id: 'p2', content: 'ok' }] });
  } catch (e) { okErr = String(e?.message || e); }
  check('发送前校验:完整配对的历史不被误拦', okErr === '', okErr);
}

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'} : ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
