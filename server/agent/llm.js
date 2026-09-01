// LLM 客户端:OpenAI 兼容 chat/completions,流式 + function calling
// 支持 DeepSeek / OpenAI / Moonshot / Qwen / 本地 vLLM / Ollama 等所有兼容端点
// model 设为 'mock' 时进入本地联调模式(无需 API Key,可跑通完整 Agent 循环)

export class LlmClient {
  constructor({ baseUrl, apiKey, model, maxTokens, contextWindow, maxIters }) {
    this.baseUrl = (baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.model = model || 'deepseek-chat';
    this.maxTokens = maxTokens || 8192;
    // 输入上下文窗口(token):>0 时启用对话历史自动压缩(见 compact.js);未配置则沿用字符预算裁剪
    this.contextWindow = Number(contextWindow) > 0 ? Math.floor(Number(contextWindow)) : 0;
    // 该模型单独的单轮最大工具迭代次数;<=0 表示未配置,由 agent 回退到全局默认(AGENT.MAX_ITERS)
    this.maxIters = Number(maxIters) > 0 ? Math.floor(Number(maxIters)) : 0;
  }

  get isMock() { return this.model === 'mock'; }

  /**
   * 流式对话
   * @param {{messages, tools, signal, onDelta, reasoning}}
   *   reasoning 推理等级(default|off|low|high|xhigh|max),对应 reasoning_effort 参数
   * @returns {Promise<{content, toolCalls:[{id,name,arguments}]}>}
   */
  async chat({ messages, tools, signal, onDelta, reasoning = 'default' }) {
    if (this.isMock) return mockChat({ messages, tools, signal, onDelta });
    const deepseekV4 = isDeepSeekV4(this.model);
    // 历史 assistant 消息中的 reasoning_content 处理(对齐 dsh llm-deepseek serialize 的 passback 规则):
    // - 非 DeepSeek v4 模型:整体剥离(从 v4 切到其他模型/网关时,该字段可能不被上游接受导致 400)
    // - DeepSeek v4:仅在带 tool_calls 的轮次原样回传(官方 thinking 模式的要求);
    //   纯文本轮省略——官方规则里该字段此时被忽略,省掉可节约 token
    let requestMessages = messages;
    if (!deepseekV4) {
      requestMessages = messages.map(stripReasoning);
    } else {
      requestMessages = messages.map((m) => {
        const hasToolCalls = m && typeof m === 'object' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
        return hasToolCalls ? m : stripReasoning(m);
      });
    }
    validateMessages(requestMessages); // 发送前校验,避免 400 类结构错误
    const url = `${this.baseUrl}/chat/completions`;
    // 最小兼容请求体:不加 stream_options(部分聚合网关不支持),tools 时显式 tool_choice
    const body = {
      model: this.model,
      messages: requestMessages,
      stream: true,
      max_tokens: this.maxTokens
    };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    // 推理等级(reasoning_effort: default/off/low/high/xhigh/max):
    // - DeepSeek v4:default 也显式开启思考(对齐 dsh 部署级默认 thinking=enabled)——
    //   不再依赖网关默认值(各网关默认开/关不一致,会出现"有时有思考、有时整轮没有");
    //   off 关闭(thinking.type=disabled);非 default 附加 reasoning_effort
    // - GLM 系列(智谱):off → thinking.type=disabled,显式选档 → enabled;default 不传,用提供方默认
    //   (GLM-4.5+ 默认开思考;glm-4v 等老模型可能不认该参数,默认档保持不发,避免 400)
    // - Qwen 系列(通义兼容模式):off → enable_thinking=false,显式选档 → true;default 不传
    // - 其他推理模型(OpenAI o 系列 / gpt-5 / grok 等):reasoning_effort 仅 low/high 合法,off/xhigh/max 就近映射
    if (deepseekV4) {
      if (reasoning === 'off') {
        body.thinking = { type: 'disabled' };
      } else {
        body.thinking = { type: 'enabled' };
        if (reasoning !== 'default') body.reasoning_effort = reasoning;
      }
    } else if (GLM_RE.test(this.model)) {
      if (reasoning === 'off') body.thinking = { type: 'disabled' };
      else if (reasoning !== 'default') body.thinking = { type: 'enabled' };
    } else if (QWEN_RE.test(this.model)) {
      if (reasoning === 'off') body.enable_thinking = false;
      else if (reasoning !== 'default') body.enable_thinking = true;
    } else if (reasoning !== 'default' && REASONING_EFFORT_RE.test(this.model)) {
      const map = { off: 'low', low: 'low', high: 'high', xhigh: 'high', max: 'high' };
      body.reasoning_effort = map[reasoning] || 'high';
    }
    // 失败重试:最多重试 RETRY_TIMES 次,每次间隔 RETRY_DELAY_MS;
    // 用户中止不重试;SSE 流已开始后再失败不重试(避免 onDelta 输出重复)
    let lastErr;
    for (let attempt = 0; attempt <= RETRY_TIMES; attempt++) {
      if (attempt > 0) {
        if (signal?.aborted) throw lastErr;
        console.warn(`[llm] ${this.model} 请求失败(${lastErr?.message || lastErr}),${RETRY_DELAY_MS / 1000}s 后重试 (${attempt}/${RETRY_TIMES})`);
        await sleep(RETRY_DELAY_MS, signal);
      }
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(body),
          signal
        });
      } catch (e) {
        lastErr = e; // 网络/连接层错误,重试
        continue;
      }
      if (!res.ok) {
        let text = (await res.text()).slice(0, 2000);
        if (/reasoning_content/i.test(text)) {
          text += '\n提示:DeepSeek 思考模式要求历史回传完整 reasoning_content。请清空当前会话历史重试,或把推理等级设为 off(关闭思考)。';
        }
        lastErr = new Error(`LLM API ${res.status} [model=${this.model}]: ${text}`);
        continue; // 非 2xx,重试
      }
      try {
        return await parseSse(res.body, { signal, onDelta });
      } catch (e) {
        if (signal?.aborted) throw e;
        throw e; // 流中途失败,不重试
      }
    }
    throw lastErr;
  }
}

// 请求失败重试策略:最多重试 5 次,每次间隔 2s
const RETRY_TIMES = 5;
const RETRY_DELAY_MS = 2000;

// DeepSeek v4 系列:原生支持思考模式开关 + reasoning_effort(high/max)
const isDeepSeekV4 = (m) => /^deepseek-v4/i.test(m);

// GLM 系列(智谱):thinking.type 开关;Qwen 系列(通义):enable_thinking 开关
const GLM_RE = /^glm-/i;
const QWEN_RE = /^qwen/i;

// 支持 reasoning_effort 参数的其他推理模型(OpenAI o 系列 / gpt-5 / grok-3-mini 等);其余模型不透传
const REASONING_EFFORT_RE = /^(o[134](-|$)|gpt-5|grok-3-mini|grok-4)/i;

// 剥离消息里的 reasoning_content 字段(passback 规则见 chat())
function stripReasoning(m) {
  if (m && typeof m === 'object' && 'reasoning_content' in m) {
    const { reasoning_content, ...rest } = m;
    return rest;
  }
  return m;
}

// 发送前校验 messages 结构,尽早暴露问题而不是收到 400
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages 必须是非空数组');
  }
  let pending = new Set(); // 最近一个带 tool_calls 的 assistant 定义的待消费 id
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (typeof m !== 'object' || m === null || typeof m.role !== 'string') {
      throw new Error(`messages[${i}] 格式错误:期望 {role, content} 对象,实际为 ${JSON.stringify(m)?.slice(0, 120)}`);
    }
    if (m.role === 'tool' && typeof m.tool_call_id !== 'string') {
      throw new Error(`messages[${i}] 是 tool 消息但缺少 tool_call_id`);
    }
    if (m.role === 'tool' && !pending.has(m.tool_call_id)) {
      throw new Error(`messages[${i}] 的 tool 消息(id=${m.tool_call_id})缺少前置 assistant tool_calls,严格提供商会拒绝(400)`);
    }
    if (m.role === 'assistant') {
      pending = new Set((m.tool_calls || []).map((t) => t.id));
    } else if (m.role === 'user') {
      pending = new Set(); // user 之后工具 id 失效
    }
  }
}

async function parseSse(stream, { signal, onDelta }) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = ''; // 思考通道输出(DeepSeek/GLM/Qwen 等推理模型);回传规则见 chat() 的 passback
  const toolAcc = new Map(); // index -> {id,name,args}
  let toolSeq = [];

  const feedDelta = (delta) => {
    if (delta.content) {
      content += delta.content;
      onDelta?.({ kind: 'text', text: delta.content });
    }
    // 思考增量:不再按模型名门控(此前只收 deepseek-v4,其他模型的思考被静默丢弃,
    // 前端永远看不到);兼容 reasoning_content(DeepSeek/GLM/Qwen 系)与
    // reasoning(OpenRouter 风格)两种字段名
    const r = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
      : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (r) {
      reasoning += r;
      onDelta?.({ kind: 'reasoning', text: r });
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
    return { content, toolCalls, reasoning };
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