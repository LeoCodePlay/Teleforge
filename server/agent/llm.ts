// LLM 客户端:OpenAI 兼容 chat/completions,流式 + function calling
// 支持 DeepSeek / OpenAI / Moonshot / Qwen / 本地 vLLM / Ollama 等所有兼容端点
// 生图模型(imageGen)另走 /images/generations 与 /images/edits 两个非流式端点
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
  /** 模型是否具备多模态(看图)能力:开启后带图片附件的 user 消息以 image_url 注入 */
  multimodal?: boolean;
  /** 是否为生图模型:agent 跳过文本对话与工具循环,整轮改走 /images/* 端点 */
  imageGen?: boolean;
}

/** 生图端点返回的一张成图(字节已在内存,由调用方落盘为附件) */
export interface ImageGenResult {
  buf: Buffer;
  /** 由文件头嗅探出的真实 MIME(不信声明:部分网关 output_format 与实际字节不符) */
  mime: string;
  /** 上游改写后的提示词(有则记录,便于复现与排查) */
  revisedPrompt?: string;
  /** 上游回显的实际尺寸:部分网关忽略请求的 size(实测 fucheers 会把 1024x1024 改成 1312x1199) */
  size?: string;
  /** 上游实际使用的模型名:网关可能做别名路由(实测回显 gpt-image-2-codex) */
  model?: string;
}

/** 图生图的单张输入参考图 */
export interface ImageInput {
  buf: Buffer;
  mime: string;
  name: string;
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
  /** 多模态开关(提供商配置里逐模型声明):true 时请求把图片附件注入为 image_url 内容段 */
  multimodal: boolean;
  /** 生图模型开关(提供商配置里逐模型声明):true 时 agent 整轮改走 /images/* 端点 */
  imageGen: boolean;
  /** @deprecated harness 的 agent-loop 没有迭代上限(循环由"无 tool_calls"收敛,水位靠压缩治理);
   *  字段仅为兼容旧的提供方配置保留,agent 主循环不再读取 */
  maxIters: number;

  constructor({ baseUrl, apiKey, model, maxTokens, contextWindow, maxIters, multimodal, imageGen }: LlmOptions) {
    this.baseUrl = (baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.model = model || 'deepseek-chat';
    this.maxTokens = maxTokens || 8192;
    this.contextWindow = Number(contextWindow) > 0 ? Math.floor(Number(contextWindow)) : 0;
    this.multimodal = multimodal === true;
    this.imageGen = imageGen === true;
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
    // 历史 assistant 消息中的 reasoning_content 处理(照搬 harness llm-deepseek serialize 的
    // passback 规则,DeepSeek thinking_mode 官方规则):reasoning_content 只在带 tool_calls 的
    // assistant 消息上回传(工具调用轮次模型需要延续思考链);纯文本轮次的 reasoning 会被
    // 上游忽略,直接剥离省 token。所有模型统一适用。
    const requestMessages = messages.map(stripReasoningForWire);
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
    // - GLM 系列(智谱):off → thinking.type=disabled,显式选档 → enabled;
    //   default:思考系列(glm-4.5+/glm-5.x,见 GLM_THINKING_RE)也显式 enabled——这些模型
    //   强制/默认开启深度思考,不传时 glm-5.3-flash 等会返回 400 REASONING_REQUIRED;
    //   glm-4 及视觉模型(glm-4v)等老模型可能不认该参数,default 保持不发,由用户显式选档
    // - Qwen 系列(通义兼容模式):off → enable_thinking=false,显式选档 → true;default 不传
    // - 其他推理模型(OpenAI o 系列 / gpt-5 / grok 等):reasoning_effort 仅 low/high 合法,off/xhigh/max 就近映射
    const deepseekV4 = isDeepSeekV4(this.model);
    if (deepseekV4) {
      if (reasoning === 'off') {
        body.thinking = { type: 'disabled' };
      } else {
        body.thinking = { type: 'enabled' };
        if (reasoning !== 'default') body.reasoning_effort = reasoning;
      }
    } else if (GLM_RE.test(this.model)) {
      if (reasoning === 'off') body.thinking = { type: 'disabled' };
      else if (reasoning !== 'default' || GLM_THINKING_RE.test(this.model)) body.thinking = { type: 'enabled' };
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
        // 纯图像端点模型被误当文本模型使用:网关会明确拒绝(503 "only supported on
        // /v1/images/...")。这是配置级错误,重试 5 次只会白等 10 秒并给出同样结论,
        // 因此立即失败并把"去开生图开关"作为可操作指引返回。
        if (IMAGES_ONLY_RE.test(text)) {
          throw new Error(
            `模型 ${this.model} 是生图模型,不支持文本对话端点(网关已拒绝)。` +
            '请在「设置 → AI 配置 → 编辑提供方」里勾选该模型的「生图」开关,该对话将切换为生图对话(文生图 / 图生图)。'
          );
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

  /**
   * 文生图:POST {baseUrl}/images/generations
   * 与 chat() 的关键差异 —— 这里【不做任何自动重试】:
   * 生图按张计费且非流式,请求已到达上游后因网络抖动中断时,重试会重复出图、重复扣费。
   * 失败一律把原因交给用户,由用户决定是否再发一次。
   */
  async generateImage({ prompt, size, quality, signal }: {
    prompt: string; size?: string; quality?: string; signal?: AbortSignal;
  }): Promise<ImageGenResult[]> {
    const body: Record<string, any> = { model: this.model, prompt, n: 1 };
    if (size) body.size = size;
    if (quality) body.quality = quality;
    return this._imageRequest(`${this.baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, signal);
  }

  /**
   * 图生图 / 成图修改:POST {baseUrl}/images/edits(multipart/form-data)
   * 多张参考图统一以 image[] 提交(实测 fucheers 的 gpt-image-2 逐张消费:
   * 同一张图传两遍会画出两个主体,证明不是只取首张)。单张也走 image[] 保持同一形态。
   * imageField 可切为 'image'(dall-e-2 等只认单数字段的旧方言);该形态下多余参考图被丢弃。
   * 不手动设 Content-Type:交给 fetch 生成 multipart boundary。
   */
  async editImage({ prompt, images, size, quality, imageField = 'image[]', signal }: {
    prompt: string; images: ImageInput[]; size?: string; quality?: string;
    imageField?: 'image[]' | 'image'; signal?: AbortSignal;
  }): Promise<ImageGenResult[]> {
    if (!images.length) throw new Error('图生图需要至少一张参考图');
    const form = new FormData();
    form.append('model', this.model);
    form.append('prompt', prompt);
    form.append('n', '1');
    if (size) form.append('size', size);
    if (quality) form.append('quality', quality);
    const sent = imageField === 'image' ? images.slice(0, 1) : images;
    sent.forEach((im, i) => {
      const name = im.name || `ref_${i + 1}.png`;
      form.append(imageField, new Blob([im.buf], { type: im.mime || 'image/png' }), name);
    });
    return this._imageRequest(`${this.baseUrl}/images/edits`, { method: 'POST', body: form }, signal);
  }

  /** 两个图像端点共用的请求/解析:鉴权注入 + 超时保护 + 用户中止 + 成图字节提取 */
  private async _imageRequest(url: string, init: Omit<RequestInit, 'signal'>, signal?: AbortSignal): Promise<ImageGenResult[]> {
    // 鉴权统一在这里注入:multipart 分支不能手写 Content-Type(会丢 boundary),
    // 若把 Authorization 分散写进各调用点极易漏掉 —— 一旦漏掉就是"文生图能用、
    // 图生图恒 401"这种只在真实网络下才暴露的错。
    const headers = new Headers(init.headers || {});
    if (this.apiKey) headers.set('Authorization', `Bearer ${this.apiKey}`);
    // 上游总超时:生图实测 29~35s(方图),大图可能数分钟。给 5 分钟地板,
    // 否则连接被网关半挂起时前端会永远停在"生成中"。
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('生图请求超时')), IMAGE_TIMEOUT_MS);
    const onUserAbort = () => ac.abort(new Error('已停止'));
    signal?.addEventListener('abort', onUserAbort, { once: true });
    try {
      let res: Response;
      try {
        res = await fetch(url, { ...init, headers, signal: ac.signal });
      } catch (e: any) {
        if (signal?.aborted) throw new Error('已停止');
        throw toFriendlyLlmError(e);
      }
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 1200);
        throw new Error(imageApiError(res.status, this.model, text));
      }
      const j: any = await res.json().catch(() => null);
      const items: any[] = Array.isArray(j?.data) ? j.data : [];
      const out: ImageGenResult[] = [];
      for (const it of items) {
        const meta = { revisedPrompt: it?.revised_prompt, size: j?.size, model: j?.model };
        if (it?.b64_json) {
          const buf = Buffer.from(it.b64_json, 'base64');
          if (buf.length) out.push({ buf, mime: sniffImageMime(buf), ...meta });
        } else if (typeof it?.url === 'string' && it.url) {
          // 部分网关返回远端 URL 而非 base64:必须下载回本机,否则成图无法进附件库、
          // 也就无法作为下一轮图生图的参考图(多轮迭代链路会断)
          const buf = await this._fetchBytes(it.url, ac.signal);
          if (buf.length) out.push({ buf, mime: sniffImageMime(buf), ...meta });
        }
      }
      if (!out.length) {
        throw new Error(`生图接口未返回图片数据${j ? `(响应:${JSON.stringify(j).slice(0, 300)})` : '(响应不是合法 JSON)'}`);
      }
      return out;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onUserAbort);
    }
  }

  /** 拉取远端成图字节(受同一超时/中止信号约束) */
  private async _fetchBytes(url: string, signal: AbortSignal): Promise<Buffer> {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`下载生成的图片失败:HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
}

// 生图请求总超时(ms):非流式端点,一次请求要等整张图生成完
const IMAGE_TIMEOUT_MS = 300_000;

// 按文件头魔数判定真实 MIME:不信任网关声明的 output_format(实测存在声明与实际字节不符的网关)
function sniffImageMime(buf: Buffer): string {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length > 3 && buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return 'image/png'; // 兜底:生图端点默认输出 PNG
}

// 图像端点错误的友好化:把网关原文翻译成可操作的中文提示
function imageApiError(status: number, model: string, text: string): string {
  const head = `生图接口 HTTP ${status} [model=${model}]: ${text}`;
  if (status === 404 || status === 405) {
    return `${head}\n提示:该提供商未开放图像端点(/images/generations、/images/edits)。请确认 Base URL 指向的是支持生图的网关,或关闭该模型的「生图」开关改回文本对话。`;
  }
  if (status === 429) {
    return `${head}\n提示:触发生图限流。生图按张计费、并发额度通常远低于文本模型,请稍后再试。`;
  }
  if (/only supported on[^\n]*images/i.test(text)) {
    return `${head}\n提示:该模型只支持图像端点,当前请求路径不对(应由服务端路由错误导致,请重启后端服务)。`;
  }
  if (/content_policy|safety|rejected|违规|敏感/i.test(text)) {
    return `${head}\n提示:提示词被内容安全策略拒绝,请调整描述后重试。`;
  }
  return head;
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

// GLM 思考系列(glm-4.5+/glm-5.x):强制/默认开启深度思考,default 档也显式 thinking=enabled,
// 否则 glm-5.3-flash 等返回 400 REASONING_REQUIRED(当前模型必须开启深度思考)。
// glm-4 及视觉模型(glm-4v)等老模型不认该参数,不在匹配范围内,default 保持不发。
const GLM_THINKING_RE = /^glm-(4\.(5|6)|5)/i;

// 支持 reasoning_effort 参数的其他推理模型(OpenAI o 系列 / gpt-5 / grok-3-mini 等);其余模型不透传
const REASONING_EFFORT_RE = /^(o[134](-|$)|gpt-5|grok-3-mini|grok-4)/i;

// 网关拒绝把纯图像端点模型用于 chat/completions 的错误文案特征
// (实测 fucheers:「model gpt-image-2 is only supported on /v1/images/generations and /v1/images/edits」)
const IMAGES_ONLY_RE = /only supported on\s+\S*\/images\/(generations|edits)/i;

// 发送前的 reasoning_content passback 处理(照搬 harness llm-deepseek serialize.ts):
// 带 tool_calls 的 assistant 消息保留 reasoning_content(thinking-mode 工具调用轮次要求回传);
// 其余消息(纯文本 assistant、user/tool)一律剥离——纯文本轮的 reasoning 会被上游忽略,剥离省 token。
function stripReasoningForWire(m: any): any {
  if (!m || typeof m !== 'object') return m;
  if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return m;
  if (!('reasoning_content' in m)) return m;
  const { reasoning_content, ...rest } = m;
  return rest;
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
  // 工作区信息随"运行时上下文"快照进入历史(user 消息),不再固定在 system prompt;
  // 因此这里扫描全部消息(优先 system)。
  const ordered = [...messages.filter((m) => m.role === 'system'), ...messages.filter((m) => m.role !== 'system')];
  for (const m of ordered) {
    const mm = m.content?.match?.(/工作区: ([^\n]+)/);
    if (mm) return mm[1].trim();
  }
  return '';
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('已停止')); }, { once: true });
});
