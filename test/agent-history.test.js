// 验证跨轮工具上下文保留:第二轮对话时,history 应包含第一轮的工具调用与结果
// (模型因此能看到之前 list_directory/get_workspace_info 的结果,避免重复探测)
import { Agent } from '../server/agent/agent.js';
import { sshManager as ssh } from '../server/ssh-manager.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

// 用假 LLM 模拟真实模型的工具调用:第一轮调 list_directory+read_file,第二轮直接回答(应能看到历史)
function makeFakeLlm(round) {
  return {
    isMock: false,
    async chat({ messages }) {
      const toolMsgs = messages.filter((m) => m.role === 'tool');
      if (round === 1) {
        if (toolMsgs.length === 0) {
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
ssh.listDir = async (p) => ([
  { name: 'README.md', type: 'file', size: 10, mtime: 0 },
  { name: 'src', type: 'dir', size: 0, mtime: 0 }
]);
ssh.atype = async () => 'file';
ssh.stat = async () => ({ isDirectory: () => true });

async function main() {
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
  const { LlmClient } = await import('../server/agent/llm.js');
  const llm = new LlmClient({ baseUrl: 'http://x', apiKey: 'k', model: 'fake' });
  const sys = agent._systemPrompt();
  const messages = [{ role: 'system', content: sys }, ...agent.history.map((m) => ({ ...m })), { role: 'user', content: 'x' }];
  let valid = true;
  try {
    // 触发校验逻辑(直接构造能过校验的请求会发网络请求,这里只测结构)
    for (const m of messages) if (!m.role || typeof m.content !== 'string' && !m.tool_calls) { valid = false; }
  } catch { valid = false; }
  check('历史消息结构合法(role/content/tool_calls 齐全)', valid, JSON.stringify(messages.map((m) => m.role)));

  console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });