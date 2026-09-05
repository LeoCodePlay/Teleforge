// LLM 客户端:OpenAI 兼容 chat/completions,流式 + function calling
// 支持 DeepSeek / OpenAI / Moonshot / Qwen / 本地 vLLM / Ollama 等所有兼容端点
// model 设为 'mock' 时进入本地联调模式(无需 API Key,可跑通完整 Agent 循环)
import type { LlmMessage } from './session.ts';

export interface ToolCallSpec {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCallSpec[];
  reasoning?: string;
  finishReason?: string;
  /** 提供方在上游流中上报的用量(有则取最后一次非空);网关不报则为 null */
  usage?: { promptTokens?: number; completionTokens?: number } | null;
}

export interface LlmOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  contextWindow?: number;
  maxIters?: number;
}

/** 一次请求失败进入重试的信息(供上层把「重试第几次」推到前端,对齐 harness llm-retry 的 retry 事件语义) */
export interface RetryInfo {
  /** 当前第几次重试(从 1 起) */
  retry: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 本次重试前的等待时长(ms) */
  delayMs: number;
  /** 上次失败的简要原因 */
  error?: string;
}

export interface ChatOptions {
  messages: LlmMessage[];
  tools?: any[];
  signal?: AbortSignal;
  onDelta?: (d: { kind: string; text?: string; index?: number }) => void;
  /** 请求失败进入重试、等待下一次尝试前触发 */
  onRetry?: (info: RetryInfo) => void;
  reasoning?: string;
}

export class LlmClient {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  // 输入上下文窗口(token):>0 时启用对话历史自动压缩(见 compact.js);未配置则沿用字符预算裁剪
  contextWindow: number;
  // 该模型单独的单轮最大工具迭代次数;<=0 表示未配置,由 agent 回退到全局默认(AGENT.MAX_ITERS)
  maxIters: number;

  constructor({ baseUrl, apiKey, model, maxTokens, contextWindow, maxIters }: LlmOptions) {
    this.baseUrl = (baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.model = model || 'deepseek-chat';
    this.maxTokens = maxTokens || 8192;
    this.contextWindow = Number(contextWindow) > 0 ? Math.floor(Number(contextWindow)) : 0;
    this.maxIters = Number(maxIters) > 0 ? Math.floor(Number(maxIters)) : 0;
  }

  get isMock(): boolean { return this.model === 'mock'; }

  /**
   * 流式对话
   * reasoning 推理等级(default|off|low|high|xhigh|max),对应 reasoning_effort 参数
   * finishReason:SSE 结束的 finish_reason(如 'stop' / 'length'),供 agent 判断
   * 输出是否因 max_tokens 被截断(length 时不当作"完成")。mock 模式下为 undefined。
   */
  async chat({ messages, tools, signal, onDelta, onRetry, reasoning = 'default' }: ChatOptions): Promise<ChatResult> {
    if (this.isMock) return mockChat({ messages, tools, signal, onDelta });
    const deepseekV4 = isDeepSeekV4(this.model);
    // 历史 assistant 消息中的 reasoning_content 处理(DeepSeek thinking 模式的 passback 规则):
    // - 非 DeepSeek v4 模型:整体剥离(从 v4 切到其他模型/网关时,该字段可能不被上游接受导致 400)
    // - DeepSeek v4 思考开启(reasoning != 'off'):所有 assistant 消息的 reasoning_content 必须
    //   原样回传,无论是否带 tool_calls。一旦剥离纯文本轮的 reasoning_content,上游会 400
    //   (The reasoning_content in the thinking mode must be passed back to the API)
    // - DeepSeek v4 关闭思考(reasoning === 'off'):剥离 reasoning_content,与 thinking.type=disabled 一致
    let requestMessages = messages;
    if (!deepseekV4 || reasoning === 'off') {
      requestMessages = messages.map(stripReasoning);
    }
    validateMessages(requestMessages); // 发送前校验,避免 400 类结构错误
    const url = `${this.baseUrl}/chat/completions`;
    // 最小兼容请求体:不加 stream_options(部分聚合网关不支持),tools 时显式 tool_choice
    const body: Record<string, any> = {
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
      const map: Record<string, string> = { off: 'low', low: 'low', high: 'high', xhigh: 'high', max: 'high' };
      body.reasoning_effort = map[reasoning] || 'high';
    }
    // 失败重试:最多重试 RETRY_TIMES 次,每次间隔 RETRY_DELAY_MS;
    // 用户中止不重试;SSE 流已开始后若已吐过内容再失败不重试(避免 onDelta 输出重复),
    // 但「流已建立却没吐出任何内容就中断」(terminated/socket hang up 等连接重置)与
    // 连接层错误同等对待,进入统一重试,并统一转成友好中文错误(不再把底层英文原文抛给前端)。
    let lastErr: any;
    let emittedChars = 0; // 本次请求已通过 onDelta 吐出的字符数(正文/思考/工具参数)
    const trackedDelta = (d: { kind: string; text?: string; index?: number }) => {
      if (d.text) emittedChars += d.text.length;
      onDelta?.(d);
    };
    for (let attempt = 0; attempt <= RETRY_TIMES; attempt++) {
      if (attempt > 0) {
        if (signal?.aborted) throw lastErr;
        console.warn(`[llm] ${this.model} 请求失败(${lastErr?.message || lastErr}),${RETRY_DELAY_MS / 1000}s 后重试 (${attempt}/${RETRY_TIMES})`);
        onRetry?.({ retry: attempt, maxRetries: RETRY_TIMES, delayMs: RETRY_DELAY_MS, error: String(lastErr?.message || lastErr) });
        await sleep(RETRY_DELAY_MS, signal);
      }
      emittedChars = 0; // 每次尝试独立计数
      let res: Response;
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
        if (!res.body) throw new Error('LLM API 未返回响应流');
        return await parseSse(res.body, { signal, onDelta: trackedDelta });
      } catch (e) {
        if (signal?.aborted) throw e;
        if (emittedChars === 0) {
          lastErr = e; // 流未吐任何内容即中断(terminated/连接重置):等同连接层错误,进入重试
          continue;
        }
        throw toFriendlyLlmError(e); // 已吐部分内容:重试会造成界面正文重复,直接给友好错误
      }
    }
    throw toFriendlyLlmError(lastErr);
  }
}

// 把网络层/流层的原始英文错误(undici terminated、socket hang up、fetch failed、ECONNRESET 等)
// 转成用户可读的中文提示;非网络类错误(如 API 业务错误)原样返回,保留真实信息
function toFriendlyLlmError(e: any): Error {
  const msg = e instanceof Error ? e.message : String(e);
  const low = msg.toLowerCase();
  const netRe = /terminated|socket hang up|fetch failed|econnreset|und_err_socket|conn(ection)? reset|connection (closed|refused|aborted)|network (error|unreachable)|broken pipe|keep.?alive|timed? ?out|timeout|aborted|deadline|read eof|eof/i;
  if (netRe.test(low)) {
    const hint = /terminated/i.test(low) ? '连接被服务端/网关中断' : '网络连接异常';
    return new Error(`模型连接中断:${hint}(${msg})。已自动重试,请稍后再试;若持续出现可切换模型或检查网络`);
  }
  return e instanceof Error ? e : new Error(msg);
}

// 请求失败重试策略:最多重试 5 次,每次间隔 2s
const RETRY_TIMES = 5;
const RETRY_DELAY_MS = 2000;

// DeepSeek v4 系列:原生支持思考模式开关 + reasoning_effort(high/max)
const isDeepSeekV4 = (m: string) => /^deepseek-v4/i.test(m);

// GLM 系列(智谱):thinking.type 开关;Qwen 系列(通义):enable_thinking 开关
const GLM_RE = /^glm-/i;
const QWEN_RE = /^qwen/i;

// 支持 reasoning_effort 参数的其他推理模型(OpenAI o 系列 / gpt-5 / grok-3-mini 等);其余模型不透传
const REASONING_EFFORT_RE = /^(o[134](-|$)|gpt-5|grok-3-mini|grok-4)/i;

// 剥离消息里的 reasoning_content 字段(passback 规则见 chat())
function stripReasoning(m: any): any {
  if (m && typeof m === 'object' && 'reasoning_content' in m) {
    const { reasoning_content, ...rest } = m;
    return rest;
  }
  return m;
}

// 发送前校验 messages 结构,尽早暴露问题而不是收到 400
function validateMessages(messages: any[]): void {
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
      pending = new Set((m.tool_calls || []).map((t: any) => t.id));
    } else if (m.role === 'user') {
      pending = new Set(); // user 之后工具 id 失效
    }
  }
}

async function parseSse(stream: ReadableStream, { signal, onDelta }: { signal?: AbortSignal; onDelta?: (d: { kind: string; text?: string; index?: number }) => void }): Promise<ChatResult> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = ''; // 思考通道输出(DeepSeek/GLM/Qwen 等推理模型);回传规则见 chat() 的 passback
  let finishReason = ''; // 最后一个非空 finish_reason(stop/length/tool_calls 等)
  let lastUsage: { prompt_tokens?: number; completion_tokens?: number } | null = null; // 提供方上报用量(通常在流末尾)
  const toolAcc = new Map(); // index -> {id,name,args}
  let toolSeq: any[] = [];

  const feedDelta = (delta: any) => {
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
          // finish_reason 只在流末尾的(可能空 delta)块出现;记录最后一个非空值
          if (choice && typeof choice.finish_reason === 'string' && choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
          // 用量上报:部分网关在流末尾带 usage(顶层或 choice 内),取最后一次非空;
          // 不强制 stream_options(部分聚合网关不支持该参数)
          const u = j.usage && typeof j.usage.prompt_tokens === 'number' ? j.usage : (choice?.usage && typeof choice.usage.prompt_tokens === 'number' ? choice.usage : null);
          if (u) lastUsage = u;
        } catch { /* 忽略无法解析的行 */ }
      }
    }
  } catch (e) {
    if (signal?.aborted) throw new Error('已停止');
    throw e;
  }

  function finish(): ChatResult {
    const toolCalls: ToolCallSpec[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        name: v.name,
        arguments: v.args
      }));
    const usage = lastUsage
      ? { promptTokens: lastUsage.prompt_tokens, completionTokens: lastUsage.completion_tokens }
      : null;
    return { content, toolCalls, reasoning, finishReason, usage };
  }
  return finish();
}

/**
 * 判断错误是否为"请求超出模型上下文窗口"(provider/网关文案各异,枚举常见模式),
 * 供 agent 触发爆窗恢复(折叠 + 压缩 + 重试)。必须先排除限流/配额类错误,避免误触发。
 */
export function isContextOverflowError(e: any): boolean {
  const s = String(e?.message || '');
  if (!s) return false;
  if (/rate.?limit|quota|429|too many requests|请求过于频繁|限流/i.test(s)) return false;
  return /maximum context|context[_ ]?length|context_window_exceeded|CONTEXT_WINDOW_EXCEEDED|input.{0,30}too long|prompt.{0,30}too long|token.{0,20}(exceed|overflow|limit reached)|上下文.{0,12}(超|溢出|过长|上限)|超过.{0,12}(上下文|长度|token)|maximum token/i.test(s);
}

// ---------------- mock 模式:离线联调,按固定脚本走完整的工具循环 ----------------
async function mockChat({ messages, tools, signal, onDelta }: { messages: any[]; tools?: any[]; signal?: AbortSignal; onDelta?: (d: { kind: string; text?: string; index?: number }) => void }): Promise<ChatResult> {
  // 只统计本轮(最后一个 user 之后)的 tool 消息,避免历史里的工具调用干扰脚本进度
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
  const turnMsgs = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages;
  const toolMsgs = turnMsgs.filter((m) => m.role === 'tool');
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const ws = extractWorkspace(messages);
  await sleep(80, signal);

  const mk = (name: string, args: any) => ({
    id: `mock_${name}_${toolMsgs.length}`,
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args)
  });

  let result: any;
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

function extractWorkspace(messages: any[]): string {
  for (const m of messages) {
    if (m.role === 'system' && m.content?.includes('工作区')) {
      const mm = m.content.match(/工作区: ([^\n]+)/);
      if (mm) return mm[1].trim();
    }
  }
  return '';
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('已停止')); }, { once: true });
});
