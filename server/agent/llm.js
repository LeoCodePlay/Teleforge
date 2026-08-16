// LLM 客户端:OpenAI 兼容 chat/completions,流式 + function calling
// 支持 DeepSeek / OpenAI / Moonshot / Qwen / 本地 vLLM / Ollama 等所有兼容端点
// model 设为 'mock' 时进入本地联调模式(无需 API Key,可跑通完整 Agent 循环)

export class LlmClient {
  constructor({ baseUrl, apiKey, model }) {
    this.baseUrl = (baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.model = model || 'deepseek-chat';
  }

  get isMock() { return this.model === 'mock'; }

  /**
   * 流式对话
   * @param {{messages, tools, signal, onDelta, onUsage}}  ...
   * @returns {Promise<{content, toolCalls:[{id,name,arguments}]}>}
   */
  async chat({ messages, tools, signal, onDelta }) {
    if (this.isMock) return mockChat({ messages, tools, signal, onDelta });
    validateMessages(messages); // 发送前校验,避免 400 类结构错误
    const url = `${this.baseUrl}/chat/completions`;
    const body = {
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true }
    };
    if (tools && tools.length) body.tools = tools;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body),
      signal
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 2000);
      throw new Error(`LLM API ${res.status}: ${text}`);
    }
    return parseSse(res.body, { signal, onDelta });
  }
}

// 发送前校验 messages 结构,尽早暴露问题而不是收到 400
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages 必须是非空数组');
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (typeof m !== 'object' || m === null || typeof m.role !== 'string') {
      throw new Error(`messages[${i}] 格式错误:期望 {role, content} 对象,实际为 ${JSON.stringify(m)?.slice(0, 120)}`);
    }
    if (m.role === 'tool' && typeof m.tool_call_id !== 'string') {
      throw new Error(`messages[${i}] 是 tool 消息但缺少 tool_call_id`);
    }
  }
}

async function parseSse(stream, { signal, onDelta }) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  const toolAcc = new Map(); // index -> {id,name,args}
  let toolSeq = [];

  const feedDelta = (delta) => {
    if (delta.content) {
      content += delta.content;
      onDelta?.({ kind: 'text', text: delta.content });
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const acc = toolAcc.get(idx) || { id: null, name: '', args: '' };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        toolAcc.set(idx, acc);
        onDelta?.({ kind: 'tool_args', index: idx, text: tc.function?.arguments || '' });
      }
    }
  };

  try {
    while (true) {
      if (signal?.aborted) throw new Error('已停止');
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return finish();
        try {
          const j = JSON.parse(data);
          const choice = j.choices && j.choices[0];
          if (choice?.delta) feedDelta(choice.delta);
        } catch { /* 忽略无法解析的行 */ }
      }
    }
  } catch (e) {
    if (signal?.aborted) throw new Error('已停止');
    throw e;
  }

  function finish() {
    const toolCalls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        name: v.name,
        arguments: v.args
      }));
    return { content, toolCalls };
  }
  return finish();
}

// ---------------- mock 模式:离线联调,按固定脚本走完整的工具循环 ----------------
async function mockChat({ messages, signal, onDelta }) {
  // 只统计本轮(最后一个 user 之后)的 tool 消息,避免历史里的工具调用干扰脚本进度
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
  const turnMsgs = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages;
  const toolMsgs = turnMsgs.filter((m) => m.role === 'tool');
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const ws = extractWorkspace(messages);
  await sleep(80, signal);

  const mk = (name, args) => ({
    id: `mock_${name}_${toolMsgs.length}`,
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args)
  });

  let result;
  switch (toolMsgs.length) {
    case 0:
      // 第一步:先展示一句思考内容,再调用工具
      onDelta?.({ kind: 'text', text: '好的,我先看一下工作区结构。' });
      await sleep(120, signal);
      result = { content: '好的,我先看一下工作区结构。', toolCalls: [mk('list_directory', { path: ws || '/' })] };
      break;
    case 1:
      result = { content: '', toolCalls: [mk('read_file', { path: ws ? `${ws}/README.md` : './README.md' })] };
      break;
    case 2:
      result = { content: '', toolCalls: [mk('run_command', { command: 'node -v', description: '查看 Node 版本' })] };
      break;
    case 3:
      result = { content: '', toolCalls: [mk('write_file', { path: ws ? `${ws}/ai-notes.md` : './ai-notes.md', content: '# AI 生成的笔记\n\n> 由 mock 模式下的 AI Agent 自动创建,用于验证 write_file 工具链路。\n' })] };
      break;
    default:
      onDelta?.({ kind: 'text', text: '已完成一轮联调:我列出了工作区目录、读取了 README、执行了命令,并写入了一个新文件。你可以配置真实的 LLM API(DeepSeek/OpenAI 等)获得完整能力。' });
      result = {
        content: '已完成一轮联调:我列出了工作区目录、读取了 README、执行了命令,并写入了一个新文件。你可以配置真实的 LLM API(DeepSeek/OpenAI 等)获得完整能力。',
        toolCalls: []
      };
  }
  await sleep(80, signal);
  return result;
}

function extractWorkspace(messages) {
  for (const m of messages) {
    if (m.role === 'system' && m.content?.includes('工作区')) {
      const mm = m.content.match(/工作区: ([^\n]+)/);
      if (mm) return mm[1].trim();
    }
  }
  return '';
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('已停止')); }, { once: true });
});