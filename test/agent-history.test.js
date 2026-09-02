// 验证跨轮工具上下文保留:第二轮对话时,history 应包含第一轮的工具调用与结果
// (模型因此能看到之前 list_directory/get_workspace_info 的结果,避免重复探测)
// 注意:本测试写会话历史并覆盖 <data>/sessions.json,需在临时目录里隔离运行
// 说明:ESM 静态 import 先于代码执行,故用顶层 await 在导入 agent 前设置 DATA_DIR
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-ah-'));
const { Agent, isToolUnsupportedError } = await import('../server/agent/agent.ts');
const { sshManager: ssh } = await import('../server/core/ssh-manager.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

// 严格校验 OpenAI 兼容消息序列:tool 消息必须紧跟一个带匹配 tool_call_id 的 assistant 消息,
// 且之间不能隔着 user。这是 opencode(Console Go)等严格提供商会 400 拒绝的格式。
function assertValidApiSequence(msgs) {
  const errs = [];
  let pending = new Set(); // 最近一个带 tool_calls 的 assistant 定义的待消费 id
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant') {
      pending = new Set((m.tool_calls || []).map((t) => t.id));
    } else if (m.role === 'user') {
      pending = new Set(); // user 之后工具 id 失效
    } else if (m.role === 'tool') {
      if (!pending.has(m.tool_call_id)) errs.push(`messages[${i}] 的 tool 消息(id=${m.tool_call_id})缺少前置 assistant tool_calls`);
      else pending.delete(m.tool_call_id);
    }
  }
  return errs;
}

// 用假 LLM 模拟真实模型的工具调用:
// 第 1 次调用 -> list_directory(得到目录内容后给出最终答复,不再调用工具)
// 第 2 轮(round 2)-> 直接回答,不应再出现工具调用
function makeFakeLlm(round) {
  let calls = 0;
  return {
    isMock: false,
    async chat({ messages }) {
      calls += 1;
      const toolMsgs = messages.filter((m) => m.role === 'tool');
      if (round === 1) {
        if (calls === 1) {
          return { content: '', toolCalls: [{ id: 'c1', name: 'list_directory', arguments: JSON.stringify({ path: '/home' }) }] };
        }
        return { content: '第一轮完成', toolCalls: [] };
      }
      // 第二轮:直接回答,不做工具调用
      return { content: '第二轮完成,我看到历史里有' + toolMsgs.length + ' 条工具结果', toolCalls: [] };
    }
  };
}

const events = [];
const agent = new Agent({ emit: (e, p) => events.push([e, p]) });

// 模拟连接与工作区
ssh.status = 'connected';
ssh.platform = 'posix';
ssh.workspace = '/home';
ssh.hostInfo = { host: 'h', port: 22, username: 'u' };
// 假 SFTP:让 list_directory 工具真正"成功"返回目录内容
ssh.listDir = async () => ([
  { name: 'README.md', type: 'file', size: 10, mtime: 0 },
  { name: 'src', type: 'dir', size: 0, mtime: 0 }
]);
ssh.atype = async () => 'file';
ssh.stat = async () => ({ isDirectory: () => true });

async function main() {
  // ---- 工具不支持判定:只认"明确提到工具"的错误,网关临时故障文案不得误伤 ----
  const shouldMatch = [
    'LLM API 400 [model=deepseek-reasoner]: The model does not support tool calls',
    'LLM API 400: tools are not supported by this model',
    'LLM API 400: tool calling is not supported',
    'LLM API 400: does not support function calling',
    'MODEL_TOOL_NOT_SUPPORTED',
    'LLM API 400: 该模型不支持工具调用',
    'LLM API 400: 不支持 function calling'
  ];
  for (const m of shouldMatch) check(`应判定为不支持工具: ${m.slice(0, 50)}`, isToolUnsupportedError(new Error(m)) === true);
  const shouldNotMatch = [
    'LLM API 503: 当前分组上游负载已饱和,请稍后重试',
    'LLM API 400: stream mode not supported by this endpoint',      // 流式不支持 -> 与工具无关
    'LLM API 404: model gpt-x not supported',                       // 模型名不支持 -> 与工具无关
    'LLM API 400: thinking not supported for this model',           // 思考参数不支持 -> 与工具无关
    'LLM API 429: rate limit exceeded',
    'LLM API 400: invalid request: max_tokens too large'
  ];
  for (const m of shouldNotMatch) check(`不应误判为不支持工具: ${m.slice(0, 50)}`, isToolUnsupportedError(new Error(m)) === false, '(误伤会导致整轮静默降级)');

  // 第一轮:假 LLM 调 list_directory
  agent.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake' });
  agent.llm = makeFakeLlm(1);
  await agent.run('看看这个项目');
  check('第一轮完成后 history 非空', agent.history.length > 0, JSON.stringify(agent.history.map((m) => m.role)));
  check('history 含 user 消息', agent.history.some((m) => m.role === 'user'));
  check('history 含 assistant 消息', agent.history.some((m) => m.role === 'assistant'));
  check('history 含 tool 结果(关键:工具上下文被保留)', agent.history.some((m) => m.role === 'tool'), JSON.stringify(agent.history.map((m) => m.role)));
  const toolMsg = agent.history.find((m) => m.role === 'tool');
  check('tool 结果包含目录内容', toolMsg && toolMsg.content.includes('/home'), toolMsg?.content);

  // 关键:历史消息顺序必须符合 OpenAI 兼容协议(否则严格提供商会 400)
  const errors1 = assertValidApiSequence(agent.history);
  check('第一轮 history 消息顺序合法(每个 tool 都有前置 assistant tool_calls)', errors1.length === 0, errors1.join('; '));
  check('第一轮 history 以 user 消息开头', agent.history[0]?.role === 'user', `实际首条: ${agent.history[0]?.role}`);

  // 第二轮:假 LLM 能看到历史(直接回答),验证 messages 里有上一轮工具上下文
  agent.llm = makeFakeLlm(2);
  let secondRoundSawTool = false;
  const origChat = agent.llm.chat.bind(agent.llm);
  agent.llm.chat = async (opts) => {
    const msgs = opts.messages;
    secondRoundSawTool = msgs.some((m) => m.role === 'tool' && String(m.content).includes('/home'));
    return origChat(opts);
  };
  await agent.run('继续,基于刚才看过的内容回答');
  check('第二轮请求的消息里带上了第一轮的工具结果', secondRoundSawTool);
  check('第二轮未清空历史(累计)', agent.history.filter((m) => m.role === 'user').length >= 2);

  // 校验消息格式合法(validateMessages 兼容)
  const { LlmClient } = await import('../server/agent/llm.ts');
  const llm = new LlmClient({ baseUrl: 'http://x', apiKey: 'k', model: 'fake' });
  const sys = agent._systemPrompt();
  const messages = [{ role: 'system', content: sys }, ...agent.history.map((m) => ({ ...m })), { role: 'user', content: 'x' }];
  let valid = true;
  try {
    // 触发校验逻辑(直接构造能过校验的请求会发网络请求,这里只测结构)
    for (const m of messages) if (!m.role || typeof m.content !== 'string' && !m.tool_calls) { valid = false; }
  } catch { valid = false; }
  check('历史消息结构合法(role/content/tool_calls 齐全)', valid, JSON.stringify(messages.map((m) => m.role)));

  const errors2 = assertValidApiSequence(messages);
  check('待发送 messages 顺序合法(含 system 消息后无裸 tool)', errors2.length === 0, errors2.join('; '));

  console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });