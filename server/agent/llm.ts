// LLM 客户端:OpenAI 兼容 chat/completions,流式 + function calling
// 支持 DeepSeek / OpenAI / Moonshot / Qwen / 本地 vLLM / Ollama 等所有兼容端点
// 生图模型(imageGen)另走 /images/generations 与 /images/edits 两个非流式端点
// model 设为 'mock' 时进入本地联调模式(无需 API Key,可跑通完整 Agent 循环)
import type { LlmMessage } from './session.ts';
import { describeFetchError, outboundFetch } from '../core/net.ts';

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
  /** 上游流没有正常结束标记(finish_reason / [DONE])就断了,且已重试到不再重试:
   *  正文可能只写了一半,调用方不能把它当作正常完成,必须向用户披露(见 chat 的截断处理) */
  truncated?: boolean;
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
  /** 上次失败前已经流出过增量:上层必须丢弃这段尚未落盘的半成品(前端回滚显示),
   *  否则重试会把同一步的正文重新生成一遍,界面出现重复内容 */
  discard?: boolean;
}

export interface ChatOptions {
  messages: LlmMessage[];
  tools?: any[];
  signal?: AbortSignal;
  onDelta?: (d: { kind: string; text?: string; index?: number }) => void;
  /** 请求失败进入重试、等待下一次尝试前触发 */
  onRetry?: (info: RetryInfo) => void;
  reasoning?: string;
  /** 本次请求的输出上限;省略则用客户端的 maxTokens(模型配置)。
   *  摘要压缩等辅助调用会传更小的值以避免摘要本身超窗(对齐 harness 摘要请求的 maxTokens)。 */
  maxTokens?: number;
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
  async chat({ messages, tools, signal, onDelta, onRetry, reasoning = 'default', maxTokens }: ChatOptions): Promise<ChatResult> {
    if (this.isMock) return mockChat({ messages, tools, signal, onDelta });
    // 历史 assistant 消息中的 reasoning_content 回传(DeepSeek thinking_mode 官方规则):
    // 请求带 tools 时,历史里**所有** assistant 轮次(含未发生工具调用的纯文本轮次)的
    // reasoning_content 都必须完整回传,否则上游 400「must be passed back to the API」;
    // 请求不带 tools 时才可省略(上游会忽略,剥离省 token)。规则见 prepareMessagesForWire。
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const requestMessages = prepareMessagesForWire(messages, { tools: hasTools, model: this.model });
    validateMessages(requestMessages); // 发送前校验,避免 400 类结构错误
    const url = `${this.baseUrl}/chat/completions`;
    // 最小兼容请求体:不加 stream_options(部分聚合网关不支持),tools 时显式 tool_choice
    const body: Record<string, any> = {
      model: this.model,
      messages: requestMessages,
      stream: true,
      // 输出上限:调用方可按本次请求收紧(摘要压缩传 SUMMARY_MAX_TOKENS),
      // 否则用模型配置的 maxTokens
      max_tokens: Number(maxTokens) > 0 ? Math.floor(Number(maxTokens)) : this.maxTokens
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
    // 失败重试策略(见文件末尾 LLM_RETRY):网络抖动、网关 5xx、限流 429、以及「流已经建立
    // 但中途被掐断/被截断/返回空响应」一律重试 —— 按指数退避并尊重网关给的 Retry-After /
    // retryAfterSeconds,单次 chat 调用的重试总预算默认 10 分钟、最多 20 次请求。
    // - 用户中止立即停止,不重试;
    // - 鉴权/余额/参数这类「重试也不会变好」的错误不空等,直接给出可操作提示;
    // - 关键:流已吐过内容后失败同样重试。重试会重发这一步,所以必须先作废「已流出但尚未
    //   落盘」的增量(onRetry 带 discard=true,由上层回滚前端显示),否则重试成功后
    //   正文会与上一次的半成品拼接重复。
    let lastErr: any;
    let lastFailure: LlmFailureInfo | undefined; // 上次失败的分类(是否可重试 / 网关要求的等待)
    let lastPartial = false; // 上次失败时是否已流出增量(重试需回滚这段半成品)
    let truncatedRetries = 0; // 「没有结束标记的截断」已重试次数:只给一次机会,避免不认 [DONE] 的提供方白等预算
    let degradedReasoning = false; // 已因「reasoning_content 未完整回传」剥离历史 reasoning 降级重试过一次
    let emittedChars = 0;    // 本次尝试已通过 onDelta 吐出的字符数(正文/思考/工具参数)
    let attempt = 0;         // 已发起的请求次数(含首次)
    let idleFired = false;   // 本次尝试是否因长期收不到任何数据被看门狗掐断
    let deadlineFired = false; // 本次尝试是否因重试总预算用尽被 deadline 掐断
    const startedAt = Date.now();
    const trackedDelta = (d: { kind: string; text?: string; index?: number }) => {
      if (d.text) emittedChars += d.text.length;
      onDelta?.(d);
    };
    for (;;) {
      if (attempt > 0) {
        // 上一次失败之后:先决定还要不要再试一次
        if (signal?.aborted) throw abortError();
        if (!lastFailure || !lastFailure.retryable) {
          throw toFriendlyLlmError(lastErr, lastFailure, { attempts: attempt, elapsedMs: Date.now() - startedAt });
        }
        const elapsedMs = Date.now() - startedAt;
        const delayMs = retryDelayMs(attempt, lastFailure.retryAfterMs);
        if (attempt >= LLM_RETRY.MAX_ATTEMPTS || elapsedMs + delayMs > LLM_RETRY.BUDGET_MS) {
          throw toFriendlyLlmError(lastErr, lastFailure, { attempts: attempt, elapsedMs, budgetExhausted: true });
        }
        console.warn(
          `[llm] ${this.model} 请求失败(${lastFailure.text.slice(0, 200)}),${(delayMs / 1000).toFixed(1)}s 后重试`
          + `(第 ${attempt} 次重试,预算剩余 ${Math.max(0, Math.round((LLM_RETRY.BUDGET_MS - elapsedMs) / 1000))}s)`
        );
        onRetry?.({
          retry: attempt,
          maxRetries: LLM_RETRY.MAX_ATTEMPTS,
          delayMs,
          error: lastFailure.text.slice(0, 300),
          // 已流出过内容:这次尝试整体作废,上层丢弃半成品并让前端回滚
          ...(lastPartial ? { discard: true } : {})
        });
        lastPartial = false;
        await sleep(delayMs, signal); // 等待期间用户停止:sleep 立即 reject,按中止收尾
      }
      emittedChars = 0; // 每次尝试独立计数
      attempt++;
      // 单次尝试的取消控制器:外层 signal(用户停止)、静默看门狗、预算 deadline 合并成一路。
      // idleMs 不超过剩余预算,deadline 则直接钉在「预算用尽」那一刻:前者管「一个字节都不来」,
      // 后者管「一直有数据在流却永远不结束」——两条合起来保证总时长不超预算,且一次尝试
      // 吃不掉整轮预算(否则就成了「只重试 1 次就放弃」)。
      const budgetLeftMs = Math.max(250, LLM_RETRY.BUDGET_MS - (Date.now() - startedAt));
      const idleMs = Math.min(LLM_RETRY.IDLE_MS, budgetLeftMs);
      const attemptAc = new AbortController();
      idleFired = false;
      deadlineFired = false;
      const onOuterAbort = () => attemptAc.abort();
      signal?.addEventListener('abort', onOuterAbort, { once: true });
      if (signal?.aborted) attemptAc.abort();
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      let deadline: ReturnType<typeof setTimeout> | null = null;
      const kick = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => { idleFired = true; attemptAc.abort(); }, idleMs);
      };
      const stopWatchdog = () => {
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        if (deadline) { clearTimeout(deadline); deadline = null; }
        signal?.removeEventListener('abort', onOuterAbort);
      };
      const attemptAbortError = () => (deadlineFired
        ? new Error(`LLM API 重试总预算已用尽(本次请求超过 ${Math.round(LLM_RETRY.BUDGET_MS / 1000)}s 仍未结束)`)
        : new Error(`LLM API ${Math.round(idleMs / 1000)}s 内没有收到任何数据(连接已被网关中断)`));
      kick();
      deadline = setTimeout(() => { deadlineFired = true; attemptAc.abort(); }, budgetLeftMs);
      let res: Response;
      try {
        res = await outboundFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(body),
          signal: attemptAc.signal
        });
      } catch (e) {
        stopWatchdog();
        if (signal?.aborted) throw abortError();
        // 连接层错误(undici terminated / fetch failed / ECONNRESET 等)与静默/预算超时:都是瞬态,重试
        lastErr = idleFired || deadlineFired ? attemptAbortError() : e;
        lastFailure = { retryable: true, text: errText(lastErr) };
        continue;
      }
      if (!res.ok) {
        stopWatchdog(); // HTTP 层就失败:本次尝试的看门狗/监听必须摘干净,否则会串到下一次尝试
        const rawBody = (await res.text()).slice(0, 2000);
        // 网关把「还要等多久」放在 Retry-After 头或 body 的 retryAfterSeconds 里
        // (实测 deepseek 网关:429 回 data.retryAfterSeconds=9~29),先解析再动原文
        const retryAfterMs = parseRetryAfterMs(res, rawBody);
        let text = rawBody;
        // 网关以「历史 reasoning_content 未完整回传」拒绝(DeepSeek thinking mode 400):
        // 历史中确实存在没有 reasoning_content 的 assistant 消息(网关漏报 / 早期由非思考模型
        // 产生 / 中途切过模型),只靠回传已有的 reasoning 修不好。降级为「剥离历史里全部
        // reasoning_content」再重发一次:请求中不再有任何 reasoning 需要回传,上游不会再以此
        // 拒绝,本轮不至于硬失败(代价是丢掉历史思考链,控制台留痕)。
        if (!degradedReasoning && (res.status === 400 || res.status >= 500) && REASONING_PASSBACK_RE.test(rawBody)) {
          degradedReasoning = true;
          body.messages = messages.map(dropReasoningContent);
          text += '\n(已剥离历史 reasoning_content 后自动重试一次)';
          lastFailure = { retryable: true, status: res.status, text: `LLM API ${res.status} [model=${this.model}]: ${text}` };
          lastErr = new LlmRequestError(lastFailure.text, { retryable: true, status: res.status });
          console.warn(`[llm] ${this.model} 网关要求 reasoning_content 完整回传,已剥离历史 reasoning 后降级重试`);
          continue;
        }
        if (/reasoning_content/i.test(text)) {
          text += '\n提示:DeepSeek 思考模式要求历史完整回传 reasoning_content(已尝试剥离历史 reasoning 自动重试)。若仍失败,请清空当前会话历史,或把推理等级设为 off(关闭思考)。';
        }
        // 纯图像端点模型被误当文本模型使用:网关会明确拒绝(503 "only supported on
        // /v1/images/...")。这是配置级错误,重试只会白等并给出同样结论,
        // 因此立即失败并把"去开生图开关"作为可操作指引返回。
        if (IMAGES_ONLY_RE.test(text)) {
          throw new Error(
            `模型 ${this.model} 是生图模型,不支持文本对话端点(网关已拒绝)。` +
            '请在「设置 → AI 配置 → 编辑提供方」里勾选该模型的「生图」开关,该对话将切换为生图对话(文生图 / 图生图)。'
          );
        }
        // 4xx 里只有超时/冲突/过载/限流值得重试;鉴权、余额、参数、找不到这类重试不会变好
        const retryable = isRetryableStatus(res.status);
        lastFailure = { retryable, status: res.status, retryAfterMs, text: `LLM API ${res.status} [model=${this.model}]: ${text}` };
        lastErr = new LlmRequestError(lastFailure.text, { retryable, status: res.status, retryAfterMs });
        console.warn(
          `[llm] ${this.model} HTTP ${res.status}${retryable ? "(将重试)" : "(不可重试,直接交给用户)"}`
          + `${retryAfterMs ? `,网关要求等待 ${(retryAfterMs / 1000).toFixed(1)}s` : ""}`
        );
        continue;
      }
      try {
        if (!res.body) throw new Error('LLM API 未返回响应流');
        const out = await parseSse(res.body, {
          signal: attemptAc.signal,
          onDelta: trackedDelta,
          onActivity: kick,
          tolerateMissingEnd: truncatedRetries > 0
        });
        stopWatchdog();
        // 空响应(正文、思考、工具调用全空)几乎都是网关抽风(200 + 错误 JSON、空 SSE 流)。
        // 旧行为把它当成模型没话说直接收尾,界面表现为对话毫无征兆地停住且没有任何报错;
        // 这里按可重试失败处理,重试到预算耗尽就给出可读错误,而不是静默结束。
        if (!out.content && !out.reasoning && out.toolCalls.length === 0) {
          lastErr = new Error('LLM API 返回空响应(正文、思考与工具调用均为空)');
          lastFailure = { retryable: true, text: errText(lastErr) };
          console.warn(`[llm] ${this.model} 返回空响应,将重试`);
          continue;
        }
        return out;
      } catch (e) {
        stopWatchdog();
        if (signal?.aborted) throw abortError();
        if (idleFired || deadlineFired) e = attemptAbortError();
        // 流中断:无论有没有吐出过内容都重试。吐过内容的这次尝试整体作废
        // (onRetry 带 discard,上层丢弃半成品并回滚前端显示),历史里不会留下残句。
        lastErr = e;
        lastFailure = { retryable: true, text: errText(e) };
        lastPartial = emittedChars > 0;
        if (/未收到 finish_reason/.test(errText(e))) truncatedRetries++;
        console.warn(
          `[llm] ${this.model} 响应流中断(${errText(e).slice(0, 200)}),本步已流出 ${emittedChars} 字`
          + `${lastPartial ? ",该半成品作废后重发这一步" : ""}`
        );
        continue;
      }
    }
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
        res = await outboundFetch(url, { ...init, headers, signal: ac.signal });
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
    const r = await outboundFetch(url, { signal });
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
// 转成用户可读的中文提示;非网络类错误(如 API 业务错误)保留真实信息,只补「为什么还在
// 失败 + 现在能做什么」。文案必须与实际行为一致:只有真的重试过才写「已重试 N 次」。
function toFriendlyLlmError(
  e: any,
  failure?: LlmFailureInfo,
  ctx?: { attempts?: number; elapsedMs?: number; budgetExhausted?: boolean }
): Error {
  const msg = errText(e);
  // 预算用尽必须写出来:否则用户只看到「重试 N 次仍失败」,分不清是次数用尽还是时间用尽
  const budgetNote = `重试总预算 ${Math.round(LLM_RETRY.BUDGET_MS / 1000)}s 已用尽`;
  const tried = ctx?.attempts && ctx.attempts > 1
    ? `已自动重试 ${ctx.attempts - 1} 次(共 ${Math.max(1, Math.round((ctx.elapsedMs || 0) / 1000))}s${ctx.budgetExhausted ? ',预算已用尽' : ''})`
    : (ctx?.budgetExhausted ? budgetNote : '');
  // 确定的账号/入参类错误:重试不会变好,给可操作指引而不是让用户干等
  if (failure && !failure.retryable) {
    const hint = permanentErrorHint(failure.status);
    return new LlmRequestError(`${msg}${hint ? `\n提示:${hint}` : ""}`, { retryable: false, status: failure.status });
  }
  // 可重试的 HTTP 错误(如 429/5xx)但重试预算已耗尽:保留网关原文 + 收尾建议
  if (failure?.status) {
    const hint = retryExhaustedHint(failure.status, tried);
    return new LlmRequestError(`${msg}${hint ? `\n提示:${hint}` : ""}`, { retryable: false, status: failure.status });
  }
  // 连接层/流层中断
  const low = msg.toLowerCase();
  const hint = /terminated|未收到 finish_reason|不是 sse|返回空响应|没有收到任何数据|重试总预算已用尽/i.test(low) ? '连接被服务端/网关中断' : '网络连接异常';
  const head = `${tried ? `${tried}仍失败,` : ""}本轮已停止重试`;
  return new Error(`模型连接中断:${hint}(${msg})。${head};可直接发消息让我接着做,或切换模型/检查网络后重试`);
}

// 确定的账号/配置类错误:重试不会变好,直接给「去哪儿改什么」的指引
function permanentErrorHint(status?: number): string {
  switch (status) {
    case 401: return '鉴权失败:请在「设置 → AI 配置」里检查该提供方的 API Key 是否有效(过期/被撤销)。';
    case 402: return '账户余额不足或已欠费:请到提供方充值。重试不会自动恢复,已停止重试。';
    case 403: return '无权限使用该模型/端点:请确认账号已开通该模型,或改用有权限的模型。';
    case 404: return '端点或模型不存在:请检查「设置 → AI 配置」里的 Base URL 与模型名是否写对。';
    case 413: return '请求体过大:请压缩会话历史(/compact)或减少附件后重试。';
    default: return '';
  }
}

// 可重试错误的重试预算耗尽后:说明「为什么还在失败」并给出下一步
function retryExhaustedHint(status: number, tried: string): string {
  const fatigue = tried ? `${tried}仍失败` : "自动重试仍失败";
  if (status === 429) return `${fatigue}:网关持续限流,稍等一会儿再发一次,或切换到并发额度更高的模型/提供方。`;
  if (status >= 500) return `${fatigue}:上游服务端持续报错,请稍后再试或切换模型。`;
  return `${fatigue}。`;
}

// ---------------- 失败重试策略 ----------------
// 一次 chat 调用的重试总预算默认 10 分钟、最多 20 次请求;退避 1s→2s→4s→…封顶 30s,
// 并与网关给的 Retry-After/retryAfterSeconds 取较大值,叠加 ±10% 抖动避免多会话同时撞车。
// 预算是硬上限:单次尝试的静默超时与 deadline 都按剩余预算收敛,所以「重试了很多次仍是
// 连不上」不会退化成「只重试 1 次就放弃」,也不会等得比承诺更久。
// 可用环境变量覆盖(联调/按需调优):LLM_RETRY_BUDGET_MS、LLM_RETRY_MAX_ATTEMPTS、
// LLM_RETRY_BASE_DELAY_MS、LLM_RETRY_MAX_DELAY_MS、LLM_STREAM_IDLE_MS。
const envNum = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export const LLM_RETRY = {
  BUDGET_MS: envNum(process.env.LLM_RETRY_BUDGET_MS, 600_000),
  // 单次尝试的静默超时:从发起请求到首个字节、以及流中任意两次数据之间的最长间隔。
  // 超时即按可重试的流中断处理——把永远卡在生成中变成一次可见的重试或报错。
  // 60s:上游真的在生成时最长可静默数十秒,而已经死掉的连接 60s 内一定没有任何字节。
  // 这个值必须远小于 BUDGET_MS——两者相等时,一次「网关假死」就能吃掉整轮预算,
  // 用户看到的就是「只重试 1 次就放弃」。
  IDLE_MS: envNum(process.env.LLM_STREAM_IDLE_MS, 60_000),
  MAX_ATTEMPTS: envNum(process.env.LLM_RETRY_MAX_ATTEMPTS, 20),
  BASE_DELAY_MS: envNum(process.env.LLM_RETRY_BASE_DELAY_MS, 1_000),
  MAX_DELAY_MS: envNum(process.env.LLM_RETRY_MAX_DELAY_MS, 30_000)
};

/** 一次失败的分类:决定还要不要再试、网关要求等多久 */
export interface LlmFailureInfo {
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
  text: string;
}

/** 带重试语义的请求错误:上层据此判断能不能再试,而不是只看文案 */
export class LlmRequestError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(message: string, info: { retryable: boolean; status?: number; retryAfterMs?: number }) {
    super(message);
    this.name = 'LlmRequestError';
    this.retryable = info.retryable;
    this.status = info.status;
    this.retryAfterMs = info.retryAfterMs;
  }
}

/** 未分类的错误(连接层/流中断)按可重试处理 */
export function isRetryableLlmError(e: any): boolean {
  return !(e instanceof LlmRequestError) || e.retryable;
}

/** 重试等待时长:指数退避与网关要求的等待取较大值,再叠加 ±10% 抖动 */
function retryDelayMs(failedAttempts: number, retryAfterMs?: number): number {
  const exp = Math.min(LLM_RETRY.MAX_DELAY_MS, LLM_RETRY.BASE_DELAY_MS * 2 ** (failedAttempts - 1));
  const base = Math.max(exp, retryAfterMs || 0);
  return Math.round(base * (0.9 + Math.random() * 0.2));
}

/** HTTP 状态是否值得重试:超时/冲突/过载/限流与服务端错误重试,其余 4xx 是确定的入参/账号问题 */
function isRetryableStatus(status: number): boolean {
  if (status >= 500) return true;
  return status === 408 || status === 409 || status === 425 || status === 429;
}

/** 解析网关要求的等待时长:优先 Retry-After 头,其次 body 里的 retryAfterSeconds(实测 deepseek 网关) */
function parseRetryAfterMs(res: Response, rawBody: string): number | undefined {
  const header = res.headers?.get?.('retry-after');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  try {
    const j = JSON.parse(rawBody);
    const candidates = [j?.data?.retryAfterSeconds, j?.retryAfterSeconds, j?.data?.retry_after, j?.error?.retry_after];
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000);
    }
  } catch { /* body 不是 JSON(网关 HTML 错误页等):没有可用的等待提示 */ }
  return undefined;
}

// undici 把 DNS 失败/连接超时/证书错误全部折叠成一句 "fetch failed",真正原因在 e.cause。
// 直接取 e.message 会让所有网络故障长得一模一样(换台机器就完全查不动),这里统一展开。
const errText = (e: any): string => (e instanceof Error ? describeFetchError(e) : String(e ?? ""));

/** 用户主动停止:统一抛「已停止」(上层按 aborted 收尾,不当错误上报) */
function abortError(): Error {
  const e = new Error('已停止');
  e.name = 'AbortError';
  return e;
}

// DeepSeek 系(含网关别名 deepseek-flash / deepseek-v4-* 等):思考模式有 reasoning 回传要求
const isDeepSeek = (m: string) => /^deepseek/i.test(m);

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

// 网关以「历史 reasoning_content 未完整回传」拒绝的错误文案特征
// (DeepSeek thinking mode 官方 400:The `reasoning_content` in the thinking mode must be passed back to the API.)
const REASONING_PASSBACK_RE = /reasoning_content[\s\S]{0,160}?(passed back|thinking mode)|(passed back|thinking mode)[\s\S]{0,160}?reasoning_content/i;

/** 剥离单条消息的 reasoning_content(仅用于「请求不带 tools」的路径:上游会忽略,剥离省 token) */
function stripReasoningForWire(m: any): any {
  if (!m || typeof m !== 'object') return m;
  if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return m;
  if (!('reasoning_content' in m)) return m;
  const { reasoning_content, ...rest } = m;
  return rest;
}

/** 无条件剥离单条消息的 reasoning_content(降级重试用:请求里不再有任何 reasoning 需要回传) */
function dropReasoningContent(m: any): any {
  if (!m || typeof m !== 'object' || !('reasoning_content' in m)) return m;
  const { reasoning_content, ...rest } = m;
  return rest;
}

/**
 * 发送前的 reasoning_content 处理(DeepSeek thinking_mode 官方规则):
 * - 请求带 tools:历史里所有 assistant 轮次(含未发生工具调用的纯文本轮次)的 reasoning_content
 *   都必须完整回传,否则上游 400「reasoning_content ... must be passed back to the API」;
 *   因此对 DeepSeek 系模型原样放行,一条都不剥。
 * - 请求不带 tools:reasoning_content 会被上游忽略,剥离省 token。
 * 非 DeepSeek 提供方对未知字段的容忍度不一,维持原有的「只留 tool_calls 轮」剥离行为。
 */
function prepareMessagesForWire(messages: any[], { tools, model }: { tools: boolean; model: string }): any[] {
  if (tools && isDeepSeek(model)) return messages;
  return messages.map(stripReasoningForWire);
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

async function parseSse(stream: ReadableStream, { signal, onDelta, onActivity, tolerateMissingEnd = false }: { signal?: AbortSignal; onDelta?: (d: { kind: string; text?: string; index?: number }) => void; onActivity?: () => void; tolerateMissingEnd?: boolean }): Promise<ChatResult> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let rawHead = '';       // 报文头部片段:非 SSE 响应(如 200 + JSON 错误体)时带进错误信息
  let sawData = false;    // 是否收到过 data: 行(区分流被截断与压根不是 SSE)
  let truncated = false;  // 流没有结束标记就结束了(tolerateMissingEnd 分支)
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
      if (done) {
        if (!finishReason) {
          // 一个 data: 行都没收到:这不是被截断的流,而是根本不像 SSE(例如网关返回
          // 200 + JSON 错误体)。把原始报文片段带进错误,否则用户只看到对话停了。
          if (!sawData) {
            const snippet = (rawHead.trim() || '(空响应体)').replace(/\s+/g, ' ').slice(0, 300);
            throw new Error(`LLM API 返回的不是 SSE 事件流,无法解析:${snippet}`);
          }
          // 有事件但没有结束标记:响应被网关/中间层截断。tolerateMissingEnd 时不再反复
          // 重试(见 chat 的 truncatedRetries),但必须把结果标成 truncated:上层据此在对话里
          // 留下回复可能不完整的可见记录,绝不静默当成正常完成。
          if (!tolerateMissingEnd) throw new Error('LLM API 响应流被中断(未收到 finish_reason 或 [DONE])');
          truncated = true;
        }
        break;
      }
      const chunkText = dec.decode(value, { stream: true });
      if (rawHead.length < 400) rawHead = (rawHead + chunkText).slice(0, 400);
      onActivity?.(); // 收到任何字节(含 SSE 心跳注释)都重置静默看门狗
      buf += chunkText;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        sawData = true;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          // [DONE] 到了但整条流从没给过 finish_reason:这不是正常结束,而是网关把上游掐断后
          // "干净地"关流(实测 LiteLLM 一类中转型网关在上游超时/不可用时就这样收尾)。
          // 旧代码在这里直接 return,于是"模型说到一半停住"被记成 completed:用户看到的正是
          // 「突然断开、没有任何报错、也不会重试」。与"流被截断"同一策略:先重试一次,
          // 再容忍但标记 truncated(上层落一条可见披露,绝不静默当正常完成)。
          if (!finishReason) {
            if (!tolerateMissingEnd) throw new Error('LLM API 响应流被中断([DONE] 之前未收到 finish_reason)');
            truncated = true;
          }
          return finish();
        }
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
    return { content, toolCalls, reasoning, finishReason, usage, ...(truncated ? { truncated: true } : {}) };
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
  // 用户真正说的那句:跳过运行时上下文快照(它以 <runtime_context> 开头,同为用户角色)
  const lastUser = [...messages].reverse().find((m) => m.role === 'user' && !/^<runtime_context>/.test(String(m.content || '').trim()));
  const ws = extractWorkspace(messages);
  await sleep(80, signal);

  const mk = (name: string, args: any) => ({
    id: `mock_${name}_${toolMsgs.length}`,
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args)
  });

  // 子代理内部:只读脚本(白名单里没有写/命令工具,别让 mock 去撞墙)
  const isSubagent = messages.some((m) => m.role === 'system' && String(m.content).includes('你是一个子代理'));
  if (isSubagent) {
    if (toolMsgs.length === 0) return { content: '', toolCalls: [mk('get_local_info', {})] };
    onDelta?.({ kind: 'text', text: '已列出目录,给出结论。' });
    return { content: '结论:目录可读,未发现异常。', toolCalls: [] };
  }
  // 父代理:用户明确说"派个子代理"时走一次 subagent 调用(联调用;默认脚本不受影响)
  const wantsSub = /派[个一]?子代理|派发子代理/.test(String(lastUser?.content || ''));
  if (wantsSub) {
    if (toolMsgs.length === 0) {
      onDelta?.({ kind: 'text', text: '好的,我派一个子代理去看看。' });
      return {
        content: '好的,我派一个子代理去看看。',
        toolCalls: [mk('subagent', {
          description: '看工作区目录',
          objective: '列出工作区目录并确认 note.txt 是否存在',
          scope: '只读本机工作区;不要写文件、不要执行命令',
          deliverable: '结论 + 证据'
        })]
      };
    }
    return { content: '子代理已给出结论,本轮结束。', toolCalls: [] };
  }

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
