// LLM 客户端:按提供方协议发出流式对话请求,统一解析成同一份 ChatResult。
//   openai    —— OpenAI 兼容 chat/completions(DeepSeek / OpenAI / Moonshot / Qwen / vLLM / Ollama 等)
//   anthropic —— Anthropic Messages(/v1/messages,Claude 官方及兼容该协议的网关)
//   gemini    —— Google Gemini 原生(models/{model}:streamGenerateContent)
// 协议的线上差异全部收敛在文件末尾的「协议适配」小节:请求体构建(buildXxxBody)与流式解析
// (parseXxxSse);chat() 本身只关心重试 / 换 Key / 结束语义,对协议无感。
// 生图模型(imageGen)另走 /images/generations 与 /images/edits 两个非流式端点(仅 OpenAI 协议)。
// model 设为 'mock' 时进入本地联调模式(无需 API Key,可跑通完整 Agent 循环)
import { randomUUID } from 'node:crypto';
import type { LlmMessage } from './session.ts';
import { describeFetchError, outboundFetch } from '../core/net.ts';

/** 提供方协议(与前端 types 的 LlmProtocol、服务端 store 的 AiProviderProtocol 保持一致) */
export type LlmProtocol = 'openai' | 'anthropic' | 'gemini';

/** 协议归一:缺省 / 未知值一律按 OpenAI 兼容处理(旧配置没有该字段) */
export function normalizeProtocol(v: unknown): LlmProtocol {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'anthropic' || s === 'gemini' ? s : 'openai';
}

export interface ToolCallSpec {
  id: string;
  name: string;
  arguments: string;
  /**
   * Gemini 原生协议的思考签名(thoughtSignature,仅该协议会产生)。
   * 2.5 系把签名挂在 thought part 上(此时 thoughtSignatureOnThought=true),
   * 3 系挂在 functionCall part 上。两种都必须随历史回传,否则下一次带工具调用的
   * 请求会被上游以「Function call is missing a thought_signature」400 拒收。
   */
  thoughtSignature?: string;
  /** 上面那个签名来自 thought part(true)还是 functionCall part(false/缺省) */
  thoughtSignatureOnThought?: boolean;
}

/**
 * 一次模型调用的 token 记账(四桶,**互斥**)。
 *
 * 语义照搬 deepseek-harness 的 `TokenUsage`(packages/llm/llm/src/types.ts):
 * `uncachedInputTokens` 只算**未命中缓存**的输入;命中/写入缓存的输入分别落在
 * `cacheReadTokens` / `cacheWriteTokens`。**计费输入 = 三桶之和**。
 * 推理 token 已经包含在 `outputTokens` 里,**不再单独累加**(否则会重复计数)。
 */
export interface TokenUsage {
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** 计费输入 = 三个输入桶之和(缓存命中率的分母) */
export function billedInputTokens(u: TokenUsage): number {
  return u.uncachedInputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * 把提供方上报的原始 usage 归一成四桶。
 *
 * 提供方方言不同(shapes 见下),这里做**唯一一处**归一,上层只见四桶:
 *  - OpenAI 兼容(含 DeepSeek-OpenAI / 多数网关):
 *      cacheRead  = prompt_tokens_details.cached_tokens ?? prompt_cache_hit_tokens ?? 0
 *      cacheWrite = prompt_tokens_details.cache_write_tokens || 0
 *      uncached   = max(0, prompt_tokens − cacheRead − cacheWrite)   ← 减法推导
 *      output     = completion_tokens(已含 reasoning_tokens)
 *    ⚠ `cached_tokens` 用 `??` 而不是 `||`:显式的 0 应当**胜过** prompt_cache_hit_tokens。
 *    ⚠ dsh 的适配器**从不读** `prompt_cache_miss_tokens`(未命中数是减出来的),
 *      所以这里也不读——少一个可能与上游不自洽的字段。
 *  - Anthropic Messages:`cache_read_input_tokens` / `cache_creation_input_tokens`
 *      + `input_tokens`(本身即未命中输入)。
 *
 * 兜底(顺序即优先级,每条都防止"算出负数或 >100% 的假命中"):
 *  1. 没有 `prompt_tokens` 也没有 `input_tokens` → 返回 null(调用方视为"无用量");
 *  2. 单个缓存字段非法(非安全整数/负数)→ **忽略该字段**,不是丢弃整条用量;
 *  3. `cacheRead + cacheWrite > prompt` → 上游脏数据,整个用量判为**不可信**,
 *     丢弃缓存分项并退化为 uncached = prompt(宁可"无缓存信息",也不报 >100%);
 *  4. 减法结果用 max(0, …) 夹住,永不为负。
 */
export function normalizeTokenUsage(raw: any): TokenUsage | null {
  if (!raw || typeof raw !== 'object') return null;

  // Anthropic 方言:input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens
  const anthropicPrompt = raw.input_tokens;
  if (isCount(anthropicPrompt)) {
    const cacheRead = isCount(raw.cache_read_input_tokens) ? raw.cache_read_input_tokens : 0;
    const cacheWrite = isCount(raw.cache_creation_input_tokens) ? raw.cache_creation_input_tokens : 0;
    const output = isCount(raw.output_tokens) ? raw.output_tokens : 0;
    // input_tokens 在 Anthropic 语义下**本身就是未命中输入**(三桶互斥),无需减法
    return { uncachedInputTokens: anthropicPrompt, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: output };
  }

  // OpenAI 兼容方言
  const promptTokens = raw.prompt_tokens;
  if (!isCount(promptTokens)) return null;
  const outputTokens = isCount(raw.completion_tokens) ? raw.completion_tokens : 0;
  const details = raw.prompt_tokens_details;

  // 优先级:cached_tokens(显式 0 也算数) → prompt_cache_hit_tokens → 0
  let cacheRead = 0;
  if (details && isCount(details.cached_tokens)) cacheRead = details.cached_tokens;
  else if (isCount(raw.prompt_cache_hit_tokens)) cacheRead = raw.prompt_cache_hit_tokens;

  // 写入缓存:OpenAI 本身不报,只有 OpenRouter 兼容提供方会带
  let cacheWrite = 0;
  if (details && isCount(details.cache_write_tokens)) cacheWrite = details.cache_write_tokens;

  // 兜底 3:缓存量超过 prompt —— 上游脏数据,丢掉缓存分项
  if (cacheRead + cacheWrite > promptTokens) {
    return { uncachedInputTokens: promptTokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens };
  }

  // 兜底 4:减法推导未命中输入,并夹住非负
  const uncached = Math.max(0, promptTokens - cacheRead - cacheWrite);
  return { uncachedInputTokens: uncached, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens };
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCallSpec[];
  reasoning?: string;
  finishReason?: string;
  /** 提供方在上游流中上报的用量(有则取最后一次非空,已归一为四桶);网关不报则为 null */
  usage?: TokenUsage | null;
  /**
   * 本步首个 token 到达的绝对时刻(ms;epoch)。用于统计栏的 TTFT 与解码速度:
   * 落盘后即便刷新/切会话也能从日志重算出同样的统计,而不是只在内存里存在。
   * 流里一个 token 都没出(如纯工具调用开头的空响应)时缺席。
   */
  firstTokenTime?: number;
  /** 上游流没有正常结束标记(finish_reason / [DONE])就断了,且已重试到不再重试:
   *  正文可能只写了一半,调用方不能把它当作正常完成,必须向用户披露(见 chat 的截断处理) */
  truncated?: boolean;
}

export interface LlmOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** 提供方协议(缺省 openai):决定端点、鉴权头与请求/响应体方言 */
  protocol?: LlmProtocol | string;
  maxTokens?: number;
  contextWindow?: number;
  maxIters?: number;
  /** 模型是否具备多模态(看图)能力:开启后带图片附件的 user 消息以 image_url 注入 */
  multimodal?: boolean;
  /** 是否为生图模型:agent 跳过文本对话与工具循环,整轮改走 /images/* 端点 */
  imageGen?: boolean;
  /** 同一提供商的多个 API Key(首位为主 Key)。某个 Key 不可用时自动轮询到下一个,
   *  全部耗尽才停止重试。上层只下发「当前可用」的 Key(已排除被标记不可用的)。 */
  apiKeys?: string[];
  /** 提供商 id(前端下发):Key 不可用时据此把标记写回提供商配置,供界面展示与重置 */
  providerId?: string;
  /** 某个 Key 被判定不可用时回调:上层据此持久化标记(无余额 / 鉴权失败),供界面展示与重置。
   *  kind:'balance' = 余额不足,'auth' = 鉴权失败(Key 无效/过期/被撤销)。 */
  onKeyExhausted?: (key: string, reason: string, kind?: KeyUnusableKind) => void;
}

/** Key 不可用的原因分类:决定界面上的徽标文案与用户的处理方式(充值 / 换 Key) */
export type KeyUnusableKind = 'balance' | 'auth';

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
  /** 连续失败阶段标识;收到有效增量后,下一次失败使用新标识 */
  retryGroup?: string;
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
  /** 'switch' = 只是切换到同一个提供商的另一个可用 Key(立即重发、不等待);
   *  缺省 = 退避后重发同一个 Key。前端据此决定显示「已切换 API Key」还是「等待重试」。 */
  kind?: 'retry' | 'switch';
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
  /** 提供方协议(见文件头);'openai' 之外的协议只影响请求体与流解析,重试/换 Key 逻辑共用 */
  protocol: LlmProtocol;
  /** 候选 API Key 列表(含主 Key,已去重去空)。chat() 按序轮询,余额不足就换下一个 */
  apiKeys: string[];
  /** Key 不可用回调(见 LlmOptions.onKeyExhausted) */
  onKeyExhausted?: (key: string, reason: string, kind?: KeyUnusableKind) => void;
  /** 本客户端生命周期内已判定不可用的 Key(余额不足 / 鉴权失败)。
   *  一次对话轮会锁定同一个客户端跑完所有 step(见 agent.ts「本轮锁定的模型」),若不记住这些
   *  Key,后续每个 step 都会先撞一遍同一个无余额的 Key 再切换 —— 白费一次请求,还会让界面上
   *  重复冒出「已切换到第 N 个可用 Key」的重试行。 */
  private deadKeys = new Set<string>();
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

  constructor({ baseUrl, apiKey, model, protocol, maxTokens, contextWindow, maxIters, multimodal, imageGen, apiKeys, onKeyExhausted }: LlmOptions) {
    this.baseUrl = (baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.protocol = normalizeProtocol(protocol);
    this.apiKeys = normalizeApiKeys(apiKeys, this.apiKey);
    this.onKeyExhausted = onKeyExhausted;
    this.model = model || 'deepseek-chat';
    this.maxTokens = maxTokens || 8192;
    this.contextWindow = Number(contextWindow) > 0 ? Math.floor(Number(contextWindow)) : 0;
    this.multimodal = multimodal === true;
    // 生图链路只实现了 OpenAI 协议端点(/images/generations 与 /images/edits):
    // 其余协议即便旧配置里标了 imageGen 也不启用,否则整轮会去撞一个不存在的端点
    this.imageGen = imageGen === true && this.protocol === 'openai';
    this.maxIters = Number(maxIters) > 0 ? Math.floor(Number(maxIters)) : 0;
  }

  get isMock(): boolean { return this.model === 'mock'; }

  /** 候选 Key:跳过本客户端已判定不可用的;全被标记时回退全量,以便最终错误里仍能报告"试过哪几个 Key" */
  private availableKeys(): string[] {
    const alive = this.apiKeys.filter((k) => !this.deadKeys.has(k));
    return alive.length ? alive : [...this.apiKeys];
  }

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
    // 线上差异全部下沉到 buildXxxBody / parseXxxSse(见文件末尾「协议适配」)。
    // OpenAI 兼容路径要先做消息面的线材预处理与结构校验;其它协议的方言不同,由各自的构建器负责。
    const isOpenAi = this.protocol === 'openai';
    const requestMessages = isOpenAi ? prepareMessagesForWire(messages, { tools: hasTools, model: this.model }) : messages;
    if (isOpenAi) validateMessages(requestMessages); // 发送前校验,避免 400 类结构错误
    // 输出上限:调用方可按本次请求收紧(摘要压缩传 SUMMARY_MAX_TOKENS),否则用模型配置的 maxTokens
    const outMaxTokens = Number(maxTokens) > 0 ? Math.floor(Number(maxTokens)) : this.maxTokens;
    const url = chatEndpoint(this.protocol, this.baseUrl, this.model);
    const body: Record<string, any> = this.protocol === 'anthropic'
      ? buildAnthropicBody({ model: this.model, messages: requestMessages, tools, maxTokens: outMaxTokens })
      : this.protocol === 'gemini'
        ? buildGeminiBody({ model: this.model, messages: requestMessages, tools, maxTokens: outMaxTokens })
        : buildOpenAiBody({ model: this.model, messages: requestMessages, tools, maxTokens: outMaxTokens, reasoning });
    // ---- 多 API Key 轮询 ----
    // 本次调用固定一份候选 Key 列表(上层下发的都是「当前可用」的 Key,已排除被标记不可用的)。
    // 某个 Key 不可用(余额不足 / 鉴权失败) → 标记它、换下一个,新 Key 重新获得满额重试次数;
    // 全部 Key 都试过才停止(见下面 isKeyUnusable 分支)。
    // 没有下发 Key 时不带鉴权头(本地不鉴权的网关仍可用),而不是发「Bearer 」空值
    // ——空 Bearer 会被网关判成 401,把「没配 Key」伪装成「Key 无效」。
    const availKeys = this.availableKeys();
    const keyList = availKeys.length ? availKeys : [''];
    let keyIdx = 0;
    let activeKey = keyList[keyIdx];
    // 失败重试策略(见文件末尾 LLM_RETRY):网络抖动、网关 5xx、限流 429、超时无响应、以及
    // 「流已经建立但中途被掐断/被截断/返回空响应」一律重试 —— 按指数退避并尊重网关给的
    // Retry-After / retryAfterSeconds,单次 chat 调用最多 10 次请求(次数用尽是唯一放弃条件)。
    // - 用户中止立即停止,不重试;
    // - 唯一不靠重试解决的错误是「余额不足」:此时自动轮询到该提供商的其它可用 API Key;
    //   只有所有 Key 都被判定无余额,才停止重试并回报给用户(见 _rotateKey)。
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
    // 已被网关判定不可用(余额/鉴权)的 Key:仅用于最终错误里报告「试过哪几个 Key」,
    // 让「换了 Key 还是 401」这种问题一眼看出是哪个 Key 在拖后腿(只露头尾,不落全量 Key)。
    const badKeys: string[] = [];
    let idleFired = false;   // 本次尝试是否因长期收不到任何数据被看门狗掐断
    let startedAt = Date.now(); // 仅用于在最终错误里报告「整轮已耗时」;换 Key 时会重置
    let retryGroup: string | undefined;
    let consecutiveRetries = 0;
    const trackedDelta = (d: { kind: string; text?: string; index?: number }) => {
      if (d.text) {
        emittedChars += d.text.length;
        // 输出恢复结束当前失败阶段;不重置请求总预算,避免反复断流造成无限重试。
        retryGroup = undefined;
        consecutiveRetries = 0;
      }
      onDelta?.(d);
    };
    const emitRetry = (info: RetryInfo) => {
      retryGroup ??= randomUUID();
      if (info.kind !== 'switch') consecutiveRetries++;
      onRetry?.({ ...info, retryGroup, ...(info.kind === 'switch' ? {} : { retry: consecutiveRetries }) });
    };
    // 当前活跃 Key 被判定不可用(余额不足 / 鉴权失败)时的统一处理:标记它 + 换下一个候选 Key。
    // 两条失败路径共用(HTTP 非 2xx;以及网关把错误包在 200 + JSON 里的流解析失败):
    // 同一个 Key 再试多少次都不会有额度/都不会被认,原地重试纯属白等。
    // @returns true = 已切到下一个 Key(调用方 continue);false = 没有下一个可换。
    const markUnusableAndRotate = (kind: KeyUnusableKind, reasonText: string, status?: number): boolean => {
      // 同一个 Key 在一次 chat 里只上报一次:换不出下一个 Key 时会落回通用重试分支,
      // 每轮都上报会变成「10 次落盘 + 10 次 key_exhausted 事件(前端跟着刷新)」的噪声。
      if (activeKey && !badKeys.includes(activeKey)) {
        badKeys.push(activeKey);
        this.deadKeys.add(activeKey); // 本轮后续 step 直接跳过它,不再白撞一次
        this.onKeyExhausted?.(activeKey, reasonText.slice(0, 300), kind);
      }
      const next = keyIdx + 1;
      if (next >= keyList.length) return false;
      const failedKey = activeKey;
      keyIdx = next;
      activeKey = keyList[keyIdx];
      attempt = 0;              // 新 Key 重新给满重试额度:换 Key 不吃上一个 Key 的失败次数
      startedAt = Date.now();
      lastPartial = false;      // 上一个 Key 留下的半成品由上层按 discard 语义回滚
      lastFailure = {
        retryable: true,
        status,
        text: kind === 'balance'
          ? `API Key ${failedKey.slice(0, 8)}… 余额不足,已切换到第 ${keyIdx + 1}/${keyList.length} 个可用 Key`
          : `API Key ${failedKey.slice(0, 8)}… 鉴权失败(网关拒绝该 Key),已切换到第 ${keyIdx + 1}/${keyList.length} 个可用 Key`
      };
      lastErr = new LlmRequestError(lastFailure.text, { retryable: true, status });
      emitRetry({ retry: keyIdx, maxRetries: keyList.length, delayMs: 0, error: lastFailure.text, kind: 'switch' });
      console.warn(`[llm] ${this.model} API Key ${kind === 'balance' ? '余额不足' : '鉴权失败'},切换到第 ${keyIdx + 1}/${keyList.length} 个 Key`);
      return true;
    };
    for (;;) {
      if (attempt > 0) {
        // 上一次失败之后:先决定还要不要再试一次
        if (signal?.aborted) throw abortError();
        if (!lastFailure || !lastFailure.retryable) {
          throw toFriendlyLlmError(lastErr, lastFailure, { attempts: attempt, elapsedMs: Date.now() - startedAt, keysTried: badKeys });
        }
        const elapsedMs = Date.now() - startedAt;
        const delayMs = retryDelayMs(attempt, lastFailure.retryAfterMs);
        // 次数用尽是唯一的放弃条件:除「余额不足」这类确定性账号问题外(由 Key 轮询专门处理),
        // 其余失败一律重试,不再因总时长超限提前停止(旧行为:600s 预算一到就停)。
        if (attempt >= LLM_RETRY.MAX_ATTEMPTS) {
          throw toFriendlyLlmError(lastErr, lastFailure, { attempts: attempt, elapsedMs, exhausted: true, keysTried: badKeys });
        }
        console.warn(
          `[llm] ${this.model} 请求失败(${lastFailure.text.slice(0, 200)}),${(delayMs / 1000).toFixed(1)}s 后重试`
          + `(第 ${attempt} 次重试,上限 ${LLM_RETRY.MAX_ATTEMPTS} 次)`
        );
        emitRetry({
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
      // 单次尝试的取消控制器:外层 signal(用户停止)、静默看门狗、单次总时长上限合并成一路。
      // 看门狗管「一个字节都不来」:等待 idleMs(默认 300s)仍收不到任何数据就作废本次尝试,
      // 按可重试的流中断处理——于是「网关假死 / 连接超时」变成一次新的重试,直到次数用尽。
      const idleMs = LLM_RETRY.IDLE_MS;
      const attemptAc = new AbortController();
      idleFired = false;
      let attemptTimedOut = false; // 本次尝试是否因超过单次总时长上限(ATTEMPT_MS)被掐断
      const onOuterAbort = () => attemptAc.abort();
      signal?.addEventListener('abort', onOuterAbort, { once: true });
      if (signal?.aborted) attemptAc.abort();
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      let attemptTimer: ReturnType<typeof setTimeout> | null = null;
      const kick = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => { idleFired = true; attemptAc.abort(); }, idleMs);
      };
      const stopWatchdog = () => {
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        if (attemptTimer) { clearTimeout(attemptTimer); attemptTimer = null; }
        signal?.removeEventListener('abort', onOuterAbort);
      };
      const attemptAbortError = () => (attemptTimedOut
        ? new Error(`LLM API 单次尝试超过 ${Math.round(LLM_RETRY.ATTEMPT_MS / 1000)}s 仍未结束(流一直没有收尾标记)`)
        : new Error(`LLM API ${Math.round(idleMs / 1000)}s 内没有收到任何数据(连接已被网关中断)`));
      kick();
      attemptTimer = setTimeout(() => { attemptTimedOut = true; attemptAc.abort(); }, LLM_RETRY.ATTEMPT_MS);
      let res: Response;
      try {
        res = await outboundFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // 鉴权头按协议注入(x-api-key / x-goog-api-key / Bearer),无 Key 时不带鉴权字段
            ...authHeaders(this.protocol, activeKey)
          },
          body: JSON.stringify(body),
          signal: attemptAc.signal
        });
      } catch (e) {
        stopWatchdog();
        if (signal?.aborted) throw abortError();
        // 连接层错误(undici terminated / fetch failed / ECONNRESET 等)与静默/预算超时:都是瞬态,重试
        lastErr = idleFired || attemptTimedOut ? attemptAbortError() : e;
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
        // Key 不可用:换 Key 而不是干等重试——同一个 Key 再试多少次都不会有额度/都不会被认。
        // 两类都先尝试换 Key,但收尾方式不同:
        //  - 余额不足(balance):该 Key 有额度前一直不可用 → 全部 Key 都无余额就停止重试,
        //    给出「充值 + 点重置」的指引;
        //  - 鉴权失败(auth,401/403/无效 Key):只说明「这个 Key 不认」,同提供商的其它 Key
        //    完全可能可用 —— 这正是「第一个 Key 失效后必须自动落到下一个」的关键路径。
        //    换不出下一个时才落回通用分支(按既有口径重试到次数用尽,最终给鉴权指引)。
        const unusable: KeyUnusableKind | null = isBalanceError(res.status, rawBody) ? 'balance'
          : (isAuthError(res.status, rawBody) ? 'auth' : null);
        if (unusable) {
          if (markUnusableAndRotate(unusable, rawBody, res.status)) continue;
          // 余额不足且再没有下一个 Key:停止重试,给出「去哪儿充值 / 重置」的可操作指引
          if (unusable === 'balance') {
            const allGone = new LlmRequestError(
              `LLM API ${res.status} [model=${this.model}]: ${rawBody.slice(0, 500)}`,
              { retryable: false, status: res.status }
            );
            throw toFriendlyLlmError(
              allGone,
              { retryable: false, status: res.status, text: rawBody },
              { attempts: attempt, elapsedMs: Date.now() - startedAt, allKeysExhausted: true }
            );
          }
        }
        // 网关以「历史 reasoning_content 未完整回传」拒绝(DeepSeek thinking mode 400):
        // 历史中确实存在没有 reasoning_content 的 assistant 消息(网关漏报 / 早期由非思考模型
        // 产生 / 中途切过模型),只靠回传已有的 reasoning 修不好。降级为「剥离历史里全部
        // reasoning_content」再重发一次:请求中不再有任何 reasoning 需要回传,上游不会再以此
        // 拒绝,本轮不至于硬失败(代价是丢掉历史思考链,控制台留痕)。
        // 这是 OpenAI 兼容网关(DeepSeek)的方言,其它协议没有这条回传规则。
        if (isOpenAi && !degradedReasoning && (res.status === 400 || res.status >= 500) && REASONING_PASSBACK_RE.test(rawBody)) {
          degradedReasoning = true;
          body.messages = messages.map(dropReasoningContent);
          text += '\n(已剥离历史 reasoning_content 后自动重试一次)';
          lastFailure = { retryable: true, status: res.status, text: `LLM API ${res.status} [model=${this.model}]: ${text}` };
          lastErr = new LlmRequestError(lastFailure.text, { retryable: true, status: res.status });
          console.warn(`[llm] ${this.model} 网关要求 reasoning_content 完整回传,已剥离历史 reasoning 后降级重试`);
          continue;
        }
        if (isOpenAi && /reasoning_content/i.test(text)) {
          text += '\n提示:DeepSeek 思考模式要求历史完整回传 reasoning_content(已尝试剥离历史 reasoning 自动重试)。若仍失败,请清空当前会话历史,或把推理等级设为 off(关闭思考)。';
        }
        // 纯图像端点模型被误当文本模型使用:网关会明确拒绝(503 "only supported on
        // /v1/images/...")。这是配置级错误,重试只会白等并给出同样结论,
        // 因此立即失败并把"去开生图开关"作为可操作指引返回。
        if (isOpenAi && IMAGES_ONLY_RE.test(text)) {
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
        const sseOpts = {
          signal: attemptAc.signal,
          onDelta: trackedDelta,
          onActivity: kick,
          tolerateMissingEnd: truncatedRetries > 0
        };
        const out = this.protocol === 'anthropic' ? await parseAnthropicSse(res.body, sseOpts)
          : this.protocol === 'gemini' ? await parseGeminiSse(res.body, sseOpts)
          : await parseSse(res.body, sseOpts);
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
        if (idleFired || attemptTimedOut) e = attemptAbortError();
        // 网关把错误包在 HTTP 200 + JSON 里返回(实测存在:正文非 SSE / 空流,报文里写着
        // invalid api key 或余额不足)。HTTP 状态是 200,但本质仍是「这个 Key 不可用」——
        // 原地重试 10 次只会白等约 2 分钟,还得不到可读结论(旧行为报成「连接被中断」)。
        // 所以在这里补一次与 HTTP 错误分支相同的「换 Key」判定。
        const bodyKind: KeyUnusableKind | null = isBalanceError(undefined, errText(e)) ? 'balance'
          : (isAuthError(undefined, errText(e)) ? 'auth' : null);
        if (bodyKind && markUnusableAndRotate(bodyKind, errText(e))) continue;
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

  /** 两个图像端点共用的请求/解析:鉴权注入 + 超时保护 + 用户中止 + 成图字节提取。
   *  Key 轮询与 chat() 共用同一份候选列表(见 LlmOptions.apiKeys):排在前面的 Key 被网关
   *  判为不可用(鉴权失败 / 余额不足)时换下一个,否则会出现「多 Key 配了、文本对话能自动
   *  切换、生图却恒 401」的割裂行为。只在 401/402/403 这种「网关明确拒绝、不可能已经出图」
   *  的状态上换 Key;网络中断仍不重试 —— 生图按张计费,重发可能重复扣费。 */
  private async _imageRequest(url: string, init: Omit<RequestInit, 'signal'>, signal?: AbortSignal): Promise<ImageGenResult[]> {
    // 鉴权统一在这里注入:multipart 分支不能手写 Content-Type(会丢 boundary),
    // 若把 Authorization 分散写进各调用点极易漏掉 —— 一旦漏掉就是"文生图能用、
    // 图生图恒 401"这种只在真实网络下才暴露的错。
    const availKeys = this.availableKeys();
    const keyList = availKeys.length ? availKeys : [''];
    // 上游总超时:生图实测 29~35s(方图),大图可能数分钟。给 5 分钟地板,
    // 否则连接被网关半挂起时前端会永远停在"生成中"。
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('生图请求超时')), IMAGE_TIMEOUT_MS);
    const onUserAbort = () => ac.abort(new Error('已停止'));
    signal?.addEventListener('abort', onUserAbort, { once: true });
    try {
      for (let i = 0; i < keyList.length; i++) {
        const activeKey = keyList[i];
        const headers = new Headers(init.headers || {});
        if (activeKey) headers.set('Authorization', `Bearer ${activeKey}`);
        let res: Response;
        try {
          res = await outboundFetch(url, { ...init, headers, signal: ac.signal });
        } catch (e: any) {
          if (signal?.aborted) throw new Error('已停止');
          throw toFriendlyLlmError(e);
        }
        if (!res.ok) {
          const text = (await res.text().catch(() => '')).slice(0, 1200);
          const unusable: KeyUnusableKind | null = isBalanceError(res.status, text) ? 'balance'
            : (isAuthError(res.status, text) ? 'auth' : null);
          if (unusable && i + 1 < keyList.length) {
            this.deadKeys.add(activeKey); // 本客户端后续请求直接跳过它
            this.onKeyExhausted?.(activeKey, text.slice(0, 300), unusable);
            // 后面统一以「当前 Key」发起请求:换过 Key 之后它才是这个客户端真正能用的那个
            this.apiKey = keyList[i + 1];
            console.warn(`[llm] ${this.model} 生图 Key ${unusable === 'balance' ? '余额不足' : '鉴权失败'},切换到第 ${i + 2}/${keyList.length} 个 Key`);
            continue;
          }
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
      }
      throw new Error(imageApiError(402, this.model, '该提供方的全部 API Key 都不可用(余额不足 / 鉴权失败)'));
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
  ctx?: { attempts?: number; elapsedMs?: number; exhausted?: boolean; allKeysExhausted?: boolean; keysTried?: string[] }
): Error {
  const msg = errText(e);
  // 一条对话里试过多个 Key 还是失败:把「试过哪几个」写进结论,否则用户只看到 401,
  // 无法判断到底是 Key 没传过去、还是几个 Key 都不行(只露头尾,不落全量 Key)
  const keysTriedHint = (ctx?.keysTried?.length || 0) > 1
    ? `\n提示:该提供方配置的 ${ctx!.keysTried!.length} 个 API Key 都已尝试过(`
      + ctx!.keysTried!.map((k) => (k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k)).join('、')
      + ');若仍报鉴权失败,请在「设置 → AI 配置」逐个核对它们是否有效/有余额。'
    : '';
  // 该提供商的全部 API Key 都被判定无余额:停止重试并说明如何恢复
  if (ctx?.allKeysExhausted) {
    return new LlmRequestError(
      `${msg}\n提示:该提供商的全部 API Key 都已余额不足,已停止重试。`
      + `请为其中任一 Key 充值后,到「设置 → AI 配置」点该 Key 的「重置」按钮恢复使用;`
      + `重置后下一次重试会重新尝试该 Key。`,
      { retryable: false, status: failure?.status }
    );
  }
  const tried = ctx?.attempts && ctx.attempts > 1
    ? `已自动重试 ${ctx.attempts - 1} 次(共 ${Math.max(1, Math.round((ctx.elapsedMs || 0) / 1000))}s${ctx.exhausted ? ',重试次数已用尽' : ''})`
    : '';
  // 确定的账号/入参类错误:重试不会变好,给可操作指引而不是让用户干等
  if (failure && !failure.retryable) {
    const hint = permanentErrorHint(failure.status);
    return new LlmRequestError(`${msg}${hint ? `\n提示:${hint}` : ""}`, { retryable: false, status: failure.status });
  }
  // 可重试的 HTTP 错误(如 429/5xx)但重试预算已耗尽:保留网关原文 + 收尾建议
  if (failure?.status) {
    const hint = retryExhaustedHint(failure.status, tried);
    return new LlmRequestError(`${msg}${hint ? `\n提示:${hint}` : ""}${keysTriedHint}`, { retryable: false, status: failure.status });
  }
  // 连接层/流层中断
  const low = msg.toLowerCase();
  const hint = /terminated|未收到 finish_reason|不是 sse|返回空响应|没有收到任何数据|重试次数已用尽/i.test(low) ? '连接被服务端/网关中断' : '网络连接异常';
  const head = `${tried ? `${tried}仍失败,` : ""}本轮已停止重试`;
  return new Error(`模型连接中断:${hint}(${msg})。${head};可直接发消息让我接着做,或切换模型/检查网络后重试${keysTriedHint}`);
}

// 确定的账号/配置类错误:重试不会变好,直接给「去哪儿改什么」的指引
function permanentErrorHint(status?: number): string {
  switch (status) {
    case 401: return '鉴权失败:请在「设置 → AI 配置」里检查该提供方的 API Key 是否有效(过期/被撤销)。';
    case 402: return '账户余额不足或已欠费:请到提供方充值。该 Key 会被标记为「无余额」并从重试中排除;充值后在「设置 → AI 配置」点「重置」即可重新启用。';
    case 403: return '无权限使用该模型/端点:请确认账号已开通该模型,或改用有权限的模型。';
    case 404: return '端点或模型不存在:请检查「设置 → AI 配置」里的 Base URL 与模型名是否写对。';
    case 413: return '请求体过大:请压缩会话历史(/compact)或减少附件后重试。';
    default: return '';
  }
}

// 重试次数用尽后:说明「为什么还在失败」并给出下一步
function retryExhaustedHint(status: number, tried: string): string {
  const fatigue = tried ? `${tried}仍失败` : "自动重试仍失败";
  // 鉴权/权限/端点这类确定性错误:重试到次数用尽后仍要给「去哪儿改什么」的指引
  const permanent = permanentErrorHint(status);
  if (permanent) return `${fatigue}:${permanent}`;
  if (status === 429) return `${fatigue}:网关持续限流,稍等一会儿再发一次,或切换到并发额度更高的模型/提供方。`;
  if (status >= 500) return `${fatigue}:上游服务端持续报错,请稍后再试或切换模型。`;
  return `${fatigue}。`;
}

/** 归一化多 API Key 列表:去空白、去重;主 Key(apiKey)保证在首位且不丢。
 *  上层可能只下发新的 apiKeys,也可能只下发旧的单 apiKey,两种形态都要能用。 */
function normalizeApiKeys(apiKeys: string[] | undefined, primary: string): string[] {
  const out: string[] = [];
  const push = (k: unknown) => {
    const s = String(k ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  push(primary);
  if (Array.isArray(apiKeys)) apiKeys.forEach(push);
  return out;
}

// ---------------- 失败重试策略 ----------------
// 一次 chat 调用最多 10 次请求(MAX_ATTEMPTS);退避 1s→2s→4s→…封顶 30s,
// 并与网关给的 Retry-After/retryAfterSeconds 取较大值,叠加 ±10% 抖动避免多会话同时撞车。
// 次数用尽是唯一的放弃条件:不再有总时长预算——旧行为的 600s 预算一到就停,用户看到的是
// 「等够 600s 未响应就直接停止」,明明还有重试额度却被判失败。
// 可用环境变量覆盖(联调/按需调优):LLM_RETRY_MAX_ATTEMPTS、
// LLM_RETRY_BASE_DELAY_MS、LLM_RETRY_MAX_DELAY_MS、LLM_STREAM_IDLE_MS。
const envNum = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export const LLM_RETRY = {
  // 已移除 600s 总预算(BUDGET_MS):重试不再因总时长超限提前停止,只有次数用尽才放弃。
  // 单次尝试的静默超时:从发起请求到首个字节、以及流中任意两次数据之间的最长间隔。
  // 超时即按可重试的流中断处理——等待 300s 仍无任何响应就作废本次尝试、再试一次。
  // 300s:上游真的在生成时最长可静默数十秒,而已经死掉的连接 300s 内一定没有任何字节。
  // 超时只作废「本次尝试」并按可重试处理,因此一次「网关假死」只消耗一次重试额度,
  // 不会让整轮请求直接失败。
  IDLE_MS: envNum(process.env.LLM_STREAM_IDLE_MS, 300_000),
  // 单次尝试的总时长上限:兜住「流一直有数据却永远不结束」——静默看门狗每收到数据
  // 就被重置,这种情形它永远等不到,没有这道上限整轮就会挂死在这里。超时同样按可重试处理。
  ATTEMPT_MS: envNum(process.env.LLM_ATTEMPT_MS, 300_000),
  MAX_ATTEMPTS: envNum(process.env.LLM_RETRY_MAX_ATTEMPTS, 10),
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

/** HTTP 状态是否值得重试:除「余额不足」外一律重试。
 *  需求口径是「除了余额不足以外的错误全部都要重试」——鉴权/参数/找不到这类错误也重试到
 *  次数用尽,只是在最终失败时附上可操作提示(见 retryExhaustedHint / permanentErrorHint)。
 *  「Key 不可用」(余额不足 / 鉴权失败)不会走到这里:它们在 HTTP 分支里被专门拦下并改走
 *  Key 轮询;只有已经轮不出下一个 Key 时,才落回本口径重试(见 chat 的 unusable 分支)。 */
function isRetryableStatus(status: number): boolean {
  return !isBalanceError(status, '');
}

/** 是否「余额不足 / 额度耗尽」类错误:状态码 402,或错误文案命中余额/欠费/额度关键词。
 *  判定必须足够窄——把普通错误误判成余额不足,会导致「本该重试却直接换成下一个 Key」。 */
export function isBalanceError(status: number | undefined, text: string): boolean {
  if (status === 402) return true;
  if (status !== undefined && status < 400) return false;
  return /insufficient\s+(balance|quota|credit|funds)|insufficient_quota|(no|out\s+of)\s+credit|exceeded\s+your\s+current\s+quota|balance\s+(is\s+)?(insufficient|exhausted|depleted)|余额不足|余额不够|余额已耗尽|欠费|额度不足|额度已用尽|额度耗尽|配额不足|账户余额/i.test(text || '');
}

/** 是否「Key 鉴权失败 / 无效」类错误:状态码 401/403,或错误文案明确指向「这个 Key 不认」。
 *  与 isBalanceError 一样必须窄:只有确定是「Key 本身不被接受」才换 Key ——
 *  否则(限流、参数错、模型不存在)换 Key 只会把同一个错误在几个 Key 上重放。
 *  实践中最常见的是网关对「已停用/被撤销」的 Key 直接回 401 invalid api key(而不是 402),
 *  于是多 Key 里排在前面的失效 Key 会把整轮对话打死,其它可用 Key 一次都轮不到。 */
export function isAuthError(status: number | undefined, text: string): boolean {
  if (status === 401 || status === 403) return true;
  if (status !== undefined && status < 400) return false;
  return /invalid\s*[-_ ]?(api[-_ ]?)?key|incorrect\s+api\s+key|api[-_ ]?key\s*(is\s*)?(invalid|expired|revoked|disabled|not\s+found)|authentication\s+fails|unauthori[sz]ed|does\s+not\s+have\s+access|无效的?\s*(api\s*)?key|(api\s*)?key\s*无效|密钥(无效|错误|已过期)|鉴权失败|未授权/i.test(text || '');
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
  // 两个方向都要查(与 litellm 的严格校验同口径):
  //  a) tool 消息必须有前置 assistant tool_calls 认领它;
  //  b) assistant 声明的每个 tool_call_id 都必须被紧随其后的 tool 消息应答 —— 少一条就是
  //     上游那句「insufficient tool messages following tool_calls message」,而且这种请求
  //     重发多少次都一样,必须在本地就拦下来(会话投影已保证配对,这里是最后一道保险)。
  // 计数口径(不是集合口径):同一条 assistant 里 id 重复时按**条数**配对,
  // 与上游「insufficient tool messages」的条数校验一致。
  let pending = new Map<string, number>(); // 待应答 id -> 还差几条 tool 消息
  const pendingCount = () => [...pending.values()].reduce((n, v) => n + v, 0);
  const unanswered = () => [...pending.entries()]
    .filter(([, n]) => n > 0)
    .map(([id, n]) => (n > 1 ? `${id}×${n}` : id))
    .join(',');
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (typeof m !== 'object' || m === null || typeof m.role !== 'string') {
      throw new Error(`messages[${i}] 格式错误:期望 {role, content} 对象,实际为 ${JSON.stringify(m)?.slice(0, 120)}`);
    }
    if (m.role === 'tool' && typeof m.tool_call_id !== 'string') {
      throw new Error(`messages[${i}] 是 tool 消息但缺少 tool_call_id`);
    }
    if (m.role === 'tool' && !pending.get(m.tool_call_id)) {
      throw new Error(`messages[${i}] 的 tool 消息(id=${m.tool_call_id})缺少前置 assistant tool_calls,严格提供商会拒绝(400)`);
    }
    if (m.role === 'assistant') {
      if (pendingCount() > 0) {
        throw new Error(`messages[${i}] 之前带 tool_calls 的 assistant 仍未被应答(id=${unanswered()}),`
          + '严格提供商会以「insufficient tool messages following tool_calls message」拒绝(400);'
          + '请重开一个会话或删除该条消息后继续');
      }
      pending = new Map();
      for (const t of (m.tool_calls || [])) {
        const id = (t as any)?.id;
        if (typeof id !== 'string' || !id) {
          throw new Error(`messages[${i}] 的 assistant tool_calls 缺少 id,无法与 tool 结果配对(严格提供商会拒绝 400)`);
        }
        pending.set(id, (pending.get(id) || 0) + 1);
      }
    } else if (m.role === 'user') {
      if (pendingCount() > 0) {
        throw new Error(`messages[${i}] 的 user 消息插在 assistant tool_calls(id=${unanswered()})与它的 tool 结果之间,`
          + '严格提供商会以「insufficient tool messages following tool_calls message」拒绝(400)');
      }
      pending = new Map(); // user 之后工具 id 失效
    } else if (m.role === 'tool') {
      pending.set(m.tool_call_id, pending.get(m.tool_call_id)! - 1);
    }
  }
  if (pendingCount() > 0) {
    throw new Error(`messages 末尾带 tool_calls 的 assistant 没有被应答(id=${unanswered()}),`
      + '严格提供商会以「insufficient tool messages following tool_calls message」拒绝(400)');
  }
}

// ---------------- 协议适配:端点 / 鉴权头 ----------------

/** Anthropic Messages 的 API 版本头(官方要求显式声明;该日期版本至今向后兼容) */
const ANTHROPIC_VERSION = '2023-06-01';

/** 去掉结尾斜杠的端点基址 */
function trimBase(baseUrl: string): string {
  return String(baseUrl || '').replace(/\/+$/, '');
}

/** Anthropic 端点:{base}/v1/…;base 已带版本段(/v1)时不重复拼 */
function anthropicUrl(baseUrl: string, path: string): string {
  const b = trimBase(baseUrl);
  return /\/v\d+$/.test(b) ? b + path : b + '/v1' + path;
}

/** Gemini 端点:{base}/v1beta/…;base 已带版本段时不重复拼 */
function geminiUrl(baseUrl: string, path: string): string {
  const b = trimBase(baseUrl);
  return /\/v\d+(beta|alpha)?$/i.test(b) ? b + path : b + '/v1beta' + path;
}

/** 按协议注入鉴权头。无 Key 时不带鉴权字段(本地不鉴权的网关仍可用),而不是发空值把自己伪装成 401。
 *  Anthropic 无论有没有 Key 都要带 anthropic-version;Gemini 走 x-goog-api-key(不接受 Bearer)。 */
export function authHeaders(protocol: LlmProtocol, apiKey: string): Record<string, string> {
  if (protocol === 'anthropic') {
    return apiKey ? { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION } : { 'anthropic-version': ANTHROPIC_VERSION };
  }
  if (protocol === 'gemini') return apiKey ? { 'x-goog-api-key': apiKey } : {};
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** 流式对话端点。URL 口径只有这一处(「获取模型列表」等转发路径也复用同一套拼接规则) */
export function chatEndpoint(protocol: LlmProtocol, baseUrl: string, model: string): string {
  if (protocol === 'anthropic') return anthropicUrl(baseUrl, '/messages');
  if (protocol === 'gemini') return geminiUrl(baseUrl, `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`);
  return `${trimBase(baseUrl)}/chat/completions`;
}

/** 模型列表端点(三种协议方言不同:OpenAI /models、Anthropic /v1/models、Gemini /v1beta/models) */
export function modelsEndpoint(protocol: LlmProtocol, baseUrl: string): string {
  if (protocol === 'anthropic') return anthropicUrl(baseUrl, '/models');
  if (protocol === 'gemini') return geminiUrl(baseUrl, '/models?pageSize=1000');
  return `${trimBase(baseUrl)}/models`;
}

/** 从模型列表响应里抽出模型名:OpenAI/Anthropic 是 data[].id,Gemini 是 models[].name(带 models/ 前缀) */
export function parseModelList(protocol: LlmProtocol, raw: any): string[] {
  const list: any[] = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.models) ? raw.models : [];
  const names: string[] = list.map((m: any): string => {
    const s = typeof m === 'string' ? m : String(m?.id ?? m?.name ?? '');
    // Gemini 的模型名带 models/ 前缀,而请求路径里用的是裸名
    return protocol === 'gemini' ? s.replace(/^models\//, '') : s;
  });
  return [...new Set(names.map((s) => s.trim()).filter(Boolean))].sort();
}

// ---------------- 协议适配:请求体 ----------------

/** 取消息文本(内部消息面的 content 可能是字符串,也可能是多模态物化后的内容段数组) */
function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('');
  }
  return content == null ? '' : String(content);
}

/** 工具调用参数(内部以 JSON 字符串保存)→ 对象。解析失败退化成空对象:参数坏掉不该打断整轮 */
function parseArgsJson(raw: any): Record<string, any> {
  if (raw && typeof raw === 'object') return raw;
  const s = String(raw ?? '').trim();
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : { value: v };
  } catch { return {}; }
}

/** data URL → { mime, base64 }。非 data URL(远端 http 图片)返回 null:
 *  两个非 OpenAI 协议都只吃内联字节,不替上游下载外链(那会把一次模型请求变成不确定的网络依赖)。 */
function splitDataUrl(url: any): { mime: string; data: string } | null {
  if (typeof url !== 'string') return null;
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? { mime: m[1], data: m[2] } : null;
}

/** OpenAI 兼容请求体(含各家网关的思考参数方言) */
function buildOpenAiBody({ model, messages, tools, maxTokens, reasoning }: {
  model: string; messages: any[]; tools?: any[]; maxTokens: number; reasoning: string;
}): Record<string, any> {
  // 最小兼容请求体:不加 stream_options(部分聚合网关不支持),tools 时显式 tool_choice
  const body: Record<string, any> = { model, messages, stream: true, max_tokens: maxTokens };
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
  if (isDeepSeekV4(model)) {
    if (reasoning === 'off') {
      body.thinking = { type: 'disabled' };
    } else {
      body.thinking = { type: 'enabled' };
      if (reasoning !== 'default') body.reasoning_effort = reasoning;
    }
  } else if (GLM_RE.test(model)) {
    if (reasoning === 'off') body.thinking = { type: 'disabled' };
    else if (reasoning !== 'default' || GLM_THINKING_RE.test(model)) body.thinking = { type: 'enabled' };
  } else if (QWEN_RE.test(model)) {
    if (reasoning === 'off') body.enable_thinking = false;
    else if (reasoning !== 'default') body.enable_thinking = true;
  } else if (reasoning !== 'default' && REASONING_EFFORT_RE.test(model)) {
    const map: Record<string, string> = { off: 'low', low: 'low', high: 'high', xhigh: 'high', max: 'high' };
    body.reasoning_effort = map[reasoning] || 'high';
  }
  return body;
}

/** data URL 图片段 → Anthropic image block(非 data URL 的图片段直接丢弃,文本仍在) */
function toAnthropicBlocks(content: any): any[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) {
    const t = textOf(content);
    return t ? [{ type: 'text', text: t }] : [];
  }
  const blocks: any[] = [];
  for (const p of content) {
    if (!p) continue;
    if (p.type === 'text' && typeof p.text === 'string' && p.text) blocks.push({ type: 'text', text: p.text });
    else if (p.type === 'image_url') {
      const img = splitDataUrl(p.image_url?.url);
      if (img) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } });
    }
  }
  return blocks;
}

/**
 * Anthropic Messages 请求体。
 * 与 OpenAI 的关键差异:
 *  - 消息体是 content block 数组;tool_calls ↔ tool_use、tool ↔ tool_result(按 id 配对);
 *  - **角色必须严格交替**:相邻同角色消息必须合并(否则 400);末轮工具结果整体进同一条 user;
 *  - 系统提示走顶层 system 字段,不在 messages 里;
 *  - max_tokens 必填。
 * 不发送 extended thinking(那要求把带签名的 thinking block 原样回传,本项目的消息面不保存该签名),
 * 因此推理等级对 Claude 不生效;上游若自行返回 thinking 增量,仍会被解析成思考通道展示。
 */
function buildAnthropicBody({ model, messages, tools, maxTokens }: {
  model: string; messages: any[]; tools?: any[]; maxTokens: number;
}): Record<string, any> {
  const system: string[] = [];
  const out: Array<{ role: 'user' | 'assistant'; content: any[] }> = [];
  const push = (role: 'user' | 'assistant', blocks: any[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks); // 同角色相邻必须合并
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system') { const t = textOf(m.content); if (t) system.push(t); continue; }
    if (m.role === 'user') { push('user', toAnthropicBlocks(m.content)); continue; }
    if (m.role === 'assistant') {
      const blocks: any[] = [];
      const t = textOf(m.content);
      if (t) blocks.push({ type: 'text', text: t });
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const name = tc?.function?.name;
        if (!name) continue;
        blocks.push({ type: 'tool_use', id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`, name, input: parseArgsJson(tc.function?.arguments) });
      }
      push('assistant', blocks);
      continue;
    }
    if (m.role === 'tool') {
      push('user', [{
        type: 'tool_result',
        tool_use_id: m.tool_call_id || '',
        // 空内容会被 Anthropic 判为非法 block,给一句可读占位
        content: textOf(m.content) || '(无输出)'
      }]);
    }
  }
  // 首条必须是 user(压缩摘要可能让历史以 assistant 开头)
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(继续)' }] });
  const body: Record<string, any> = {
    model,
    max_tokens: Number(maxTokens) > 0 ? Math.floor(Number(maxTokens)) : 8192,
    stream: true,
    messages: out
  };
  if (system.length) body.system = system.join('\n\n');
  if (tools && tools.length) {
    const decls = tools
      .map((t) => t?.function)
      .filter((f) => f && f.name)
      .map((f) => ({ name: f.name, description: f.description || '', input_schema: f.parameters || { type: 'object', properties: {} } }));
    if (decls.length) {
      body.tools = decls;
      body.tool_choice = { type: 'auto' };
    }
  }
  return body;
}

/** Gemini Schema 只认 OpenAPI 子集:未知字段会直接 400,所以这里递归白名单化 */
function toGeminiSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' || k === '$schema' || k === '$ref' || k === 'default' || k === 'examples' || k === 'strict' || k === 'allOf') continue;
    if (k === 'type') {
      // JSON Schema 的 type 数组(如 ['string','null'])要折成 Gemini 的 nullable
      if (Array.isArray(v)) {
        const types = v.filter((x) => x !== 'null');
        if (types.length) out.type = types[0];
        if (types.length !== v.length) out.nullable = true;
      } else out.type = v;
      continue;
    }
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, any>).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
      continue;
    }
    if (k === 'items') { out.items = toGeminiSchema(v); continue; }
    if (k === 'anyOf' || k === 'oneOf') { out.anyOf = (v as any[]).map(toGeminiSchema); continue; }
    if (['enum', 'required', 'description', 'format', 'nullable', 'minimum', 'maximum', 'minItems', 'maxItems', 'pattern', 'title', 'example', 'propertyOrdering'].includes(k)) {
      out[k] = v;
      continue;
    }
    // 其余未知键(x-* / const / …)一律丢弃
  }
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

/** Gemini content 的 user part(文本 + 内联图片;❗️不接受远端 URL 与 OpenAI 的 image_url 段) */
function toGeminiParts(content: any): any[] {
  if (typeof content === 'string') return [{ text: content || '(空消息)' }];
  if (!Array.isArray(content)) return [{ text: textOf(content) || '(空消息)' }];
  const parts: any[] = [];
  for (const p of content) {
    if (!p) continue;
    if (p.type === 'text' && typeof p.text === 'string' && p.text) parts.push({ text: p.text });
    else if (p.type === 'image_url') {
      const img = splitDataUrl(p.image_url?.url);
      if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.data } });
    }
  }
  return parts.length ? parts : [{ text: '(空消息)' }];
}

/**
 * Gemini 原生请求体(generateContent 的 contents/parts 形态)。
 *  - 系统提示走 systemInstruction;工具走 tools[].functionDeclarations + toolConfig.mode=AUTO;
 *  - 工具结果回传为 user 轮的 functionResponse(必须带函数名,而内部 tool 消息只有 id → 这里按 id 反查);
 *  - **思考签名回传**:2.5 系把签名挂在 thought part 上、3 系挂在 functionCall part 上,两种都必须原样带回,
 *    否则下一次带工具调用的请求会被上游以「missing a thought_signature」400 拒收;
 *  - 不发 thinkingConfig:2.5/3 默认就有思考,而 thinkingBudget=0 在 pro 系会被判非法(400)。
 *    于是「推理等级」对 Gemini 不改变思考开关,只影响展示(getter 传给前端的思考增量照常解析)。
 */
function buildGeminiBody({ model, messages, tools, maxTokens }: {
  model: string; messages: any[]; tools?: any[]; maxTokens: number;
}): Record<string, any> {
  const system: string[] = [];
  const contents: Array<{ role: 'user' | 'model'; parts: any[] }> = [];
  const push = (role: 'user' | 'model', parts: any[]) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  const nameById = new Map<string, string>(); // tool_call_id → 函数名(functionResponse 需要)
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system') { const t = textOf(m.content); if (t) system.push(t); continue; }
    if (m.role === 'user') { push('user', toGeminiParts(m.content)); continue; }
    if (m.role === 'assistant') {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      for (const tc of calls) if (tc?.id) nameById.set(tc.id, tc.function?.name || '');
      const thinkText = typeof m.reasoning_content === 'string' ? m.reasoning_content : '';
      const parts: any[] = [];
      const sigOnThought = calls.find((tc: any) => tc?.thoughtSignature && tc.thoughtSignatureOnThought === true);
      // 只回传"带签名的思考":上游要求的是签名本身,而 2.5 的签名挂在 thought part 上,
      // 所以思考正文必须跟着它一起回去。没有签名的思考不需要回传(白增 token,且 3 系对
      // 无签名的 thought part 更挑),此时签名会改挂到 functionCall part 上(见下)。
      if (sigOnThought && thinkText) parts.push({ text: thinkText, thought: true, thoughtSignature: sigOnThought.thoughtSignature });
      const text = textOf(m.content);
      if (text) parts.push({ text });
      for (const tc of calls) {
        const name = tc?.function?.name;
        if (!name) continue;
        // 已经用 thought part 回传过的签名不再重复挂到 functionCall 上
        const sig = tc.thoughtSignature && !(tc.thoughtSignatureOnThought === true && thinkText) ? tc.thoughtSignature : undefined;
        parts.push({ functionCall: { name, args: parseArgsJson(tc.function?.arguments) }, ...(sig ? { thoughtSignature: sig } : {}) });
      }
      push('model', parts);
      continue;
    }
    if (m.role === 'tool') {
      push('user', [{
        functionResponse: {
          name: nameById.get(m.tool_call_id) || 'unknown_tool',
          response: { result: textOf(m.content) }
        }
      }]);
    }
  }
  if (!contents.length || contents[0].role !== 'user') contents.unshift({ role: 'user', parts: [{ text: '(继续)' }] });
  const body: Record<string, any> = { contents };
  if (system.length) body.systemInstruction = { parts: [{ text: system.join('\n\n') }] };
  if (Number(maxTokens) > 0) body.generationConfig = { maxOutputTokens: Math.floor(Number(maxTokens)) };
  if (tools && tools.length) {
    const decls = tools
      .map((t) => t?.function)
      .filter((f) => f && f.name)
      .map((f) => ({
        name: f.name,
        description: f.description || '',
        parameters: toGeminiSchema(f.parameters || { type: 'object', properties: {} })
      }));
    if (decls.length) {
      body.tools = [{ functionDeclarations: decls }];
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }
  }
  return body;
}

// ---------------- 协议适配:流式解析 ----------------

/** SSE 行泵:把响应流按行切出 data: 帧交给 onFrame;onFrame 返回 true = 收到结束帧、停止读取。
 *  返回是否见过 data 帧 + 报文头部片段(非 SSE 响应时用于给出可读报错;onFrame 抛错原样上抛)。 */
async function pumpSse(
  stream: ReadableStream,
  { signal, onActivity }: { signal?: AbortSignal; onActivity?: () => void },
  onFrame: (data: string) => boolean
): Promise<{ sawData: boolean; rawHead: string }> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let rawHead = '';
  let sawData = false;
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('已停止');
      const { done, value } = await reader.read();
      if (done) break;
      const chunkText = dec.decode(value, { stream: true });
      if (rawHead.length < 400) rawHead = (rawHead + chunkText).slice(0, 400);
      onActivity?.(); // 收到任何字节(含 SSE 心跳注释)都重置静默看门狗
      buf += chunkText;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        sawData = true;
        if (onFrame(line.slice(5).trim())) return { sawData, rawHead };
      }
    }
  } catch (e) {
    if (signal?.aborted) throw new Error('已停止');
    throw e;
  }
  return { sawData, rawHead };
}

/** 流收尾的统一判定:一个 data 帧都没有 → 根本不是 SSE;有帧但没有结束标记 → 截断
 *  (先重试一次,tolerateMissingEnd 时才接受并标记 truncated)。返回是否标记为截断。 */
function assertStreamEnded(ended: boolean, { sawData, rawHead, tolerateMissingEnd }: { sawData: boolean; rawHead: string; tolerateMissingEnd: boolean }): boolean {
  if (ended) return false;
  if (!sawData) {
    const snippet = (rawHead.trim() || '(空响应体)').replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`LLM API 返回的不是 SSE 事件流,无法解析:${snippet}`);
  }
  if (!tolerateMissingEnd) throw new Error('LLM API 响应流被中断(未收到 finish_reason 或 [DONE])');
  return true;
}

/** 把流中途上报的用量并入累计(只吸收有值的字段:message_delta 的 usage 只带 output_tokens) */
function mergeUsageInto(target: any, patch: any): any {
  if (!patch || typeof patch !== 'object') return target;
  const out = { ...(target && typeof target === 'object' ? target : {}) };
  for (const [k, v] of Object.entries(patch)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

/** Anthropic 的 stop_reason → 内部口径(agent 只认 stop/length/tool_calls 这几个关键值) */
const ANTHROPIC_STOP: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls'
};

/** Anthropic Messages 流式解析(message_start、content_block_* 系列事件、message_delta、message_stop)。
 *  用量在 message_start(input_tokens 等)与 message_delta(output_tokens)分两处上报,合并后归一。 */
async function parseAnthropicSse(
  stream: ReadableStream,
  { signal, onDelta, onActivity, tolerateMissingEnd = false }: {
    signal?: AbortSignal;
    onDelta?: (d: { kind: string; text?: string; index?: number }) => void;
    onActivity?: () => void;
    tolerateMissingEnd?: boolean;
  }
): Promise<ChatResult> {
  let content = '';
  let reasoning = '';
  let stopReason = '';
  let usage: any = null;
  let streamError: Error | null = null;
  let firstTokenTime: number | null = null;
  const markFirstToken = () => { if (firstTokenTime === null) firstTokenTime = Date.now(); };
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();

  const { sawData, rawHead } = await pumpSse(stream, { signal, onActivity }, (data) => {
    let ev: any;
    try { ev = JSON.parse(data); } catch { return false; } // 忽略无法解析的帧
    switch (ev?.type) {
      case 'message_start':
        usage = mergeUsageInto(usage, ev.message?.usage);
        return false;
      case 'content_block_start': {
        const block = ev.content_block || {};
        if (block.type === 'tool_use') {
          markFirstToken(); // 工具名到达即算"开始出字"(与 OpenAI 流的口径一致)
          toolAcc.set(ev.index ?? 0, { id: block.id || '', name: block.name || '', args: '' });
        }
        return false;
      }
      case 'content_block_delta': {
        const d = ev.delta || {};
        if (d.type === 'text_delta' && d.text) {
          markFirstToken();
          content += d.text;
          onDelta?.({ kind: 'text', text: d.text });
        } else if (d.type === 'thinking_delta' && d.thinking) {
          markFirstToken();
          reasoning += d.thinking;
          onDelta?.({ kind: 'reasoning', text: d.thinking });
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          const idx = ev.index ?? 0;
          const acc = toolAcc.get(idx) || { id: '', name: '', args: '' };
          acc.args += d.partial_json;
          toolAcc.set(idx, acc);
          onDelta?.({ kind: 'tool_args', index: idx, text: d.partial_json });
        }
        return false;
      }
      case 'message_delta':
        if (ev.delta?.stop_reason) stopReason = String(ev.delta.stop_reason);
        usage = mergeUsageInto(usage, ev.usage);
        return false;
      case 'message_stop':
        return true;
      case 'error':
        streamError = new Error(`LLM API 返回错误:${JSON.stringify(ev.error ?? ev).slice(0, 400)}`);
        return true;
      default:
        return false; // ping / content_block_stop 等无需处理
    }
  });
  if (streamError) throw streamError;
  const truncated = assertStreamEnded(!!stopReason, { sawData, rawHead, tolerateMissingEnd });
  const toolCalls: ToolCallSpec[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({
      id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      name: v.name,
      arguments: v.args || '{}'
    }));
  return {
    content, toolCalls, reasoning,
    finishReason: ANTHROPIC_STOP[stopReason] || stopReason,
    usage: normalizeTokenUsage(usage),
    ...(firstTokenTime !== null ? { firstTokenTime } : {}),
    ...(truncated ? { truncated: true } : {})
  };
}

/** Gemini 的用量口径 → normalizeTokenUsage 认得的 OpenAI 方言(思考 token 计入输出) */
function geminiUsage(u: any): any {
  const prompt = Number(u?.promptTokenCount) || 0;
  const output = (Number(u?.candidatesTokenCount) || 0) + (Number(u?.thoughtsTokenCount) || 0);
  const cached = Number(u?.cachedContentTokenCount) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {})
  };
}

/** 完成的 JSON 文本判定:用于识别"参数被拆成 JSON 片段下发"的接入层 */
function isCompleteJson(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

/** JSON 文本 → 值;解析失败返回 null */
function parseJsonLoose(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

/** Gemini 的 finishReason → 内部口径 */
const GEMINI_FINISH: Record<string, string> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  UNEXPECTED_TOOL_CALL: 'tool_calls'
};

/**
 * Gemini 原生流式解析(streamGenerateContent?alt=sse:每帧一个 GenerateContentResponse)。
 *  - 结束标记不是 [DONE],而是候选里的 finishReason;usageMetadata 可能在其后单独一帧,读到流自然结束;
 *  - 工具调用 part 的参数:**一个 part 就是一次完整调用**(Gemini 的 args 是结构化的,官方把"参数分片"
 *    做成单独开关 partialArgs,本项目不启用);同一 functionCall id 重复出现时按对象合并,
 *    另外对"args 被拆成 JSON 片段"的非标接入层做续写兜底;
 *  - 思考签名按来源记录:thought part → thoughtSignatureOnThought=true,functionCall part → false。
 */
async function parseGeminiSse(
  stream: ReadableStream,
  { signal, onDelta, onActivity, tolerateMissingEnd = false }: {
    signal?: AbortSignal;
    onDelta?: (d: { kind: string; text?: string; index?: number }) => void;
    onActivity?: () => void;
    tolerateMissingEnd?: boolean;
  }
): Promise<ChatResult> {
  let content = '';
  let reasoning = '';
  let finishReason = '';
  let blockReason = '';
  let usage: any = null;
  let firstTokenTime: number | null = null;
  const markFirstToken = () => { if (firstTokenTime === null) firstTokenTime = Date.now(); };
  const calls: Array<{ id: string; name: string; args: string; thoughtSignature?: string; thoughtSignatureOnThought?: boolean }> = [];
  let lastThoughtSignature = ''; // 2.5 系:签名在 thought part 上,要随其后的 functionCall 一起回传
  let callSeq = 0;

  const addFunctionCall = (name: string, args: any, ownSignature?: string, callId?: string) => {
    if (!name) return;
    const frag = typeof args === 'string' ? args : args == null ? '{}' : JSON.stringify(args);
    // 归并规则:
    //  1) 带 id 且已存在同 id 调用(Gemini 3)→ 参数按对象合并(后到的字段覆盖);
    //  2) 无 id 且上一条同名调用的参数还不是合法 JSON(非标接入层把 args 拆成片段)→ 续写;
    //  3) 其余情况(2.5 的常规形态:一个 part 一次完整调用)→ 新调用。
    // 第 3 条很重要:同名的两个独立调用(如并行读两个文件)绝不能被按名字合并掉。
    const sameId = callId ? calls.find((c) => c.id === callId) : undefined;
    const last = calls[calls.length - 1];
    if (sameId) {
      const prev = parseJsonLoose(sameId.args);
      const next = parseJsonLoose(frag);
      sameId.args = prev && next && typeof prev === 'object' && typeof next === 'object'
        ? JSON.stringify({ ...prev, ...next })
        : (frag.startsWith(sameId.args) ? frag : sameId.args + frag);
    } else if (!callId && last && last.name === name && !isCompleteJson(last.args)) {
      last.args = frag.startsWith(last.args) ? frag : last.args + frag;
    } else {
      markFirstToken();
      calls.push({ id: callId || `call_${callSeq++}_${Math.random().toString(36).slice(2, 8)}`, name, args: frag });
    }
    const cur = sameId || calls[calls.length - 1];
    const sig = ownSignature || lastThoughtSignature;
    if (sig && !cur.thoughtSignature) {
      cur.thoughtSignature = sig;
      cur.thoughtSignatureOnThought = !ownSignature;
    }
  };

  const { sawData, rawHead } = await pumpSse(stream, { signal, onActivity }, (data) => {
    let ev: any;
    try { ev = JSON.parse(data); } catch { return false; }
    if (ev?.error) throw new Error(`LLM API 返回错误:${String(ev.error?.message || JSON.stringify(ev.error)).slice(0, 400)}`);
    if (ev?.promptFeedback?.blockReason) blockReason = String(ev.promptFeedback.blockReason);
    const cand = Array.isArray(ev?.candidates) ? ev.candidates[0] : null;
    for (const part of cand?.content?.parts || []) {
      if (!part || typeof part !== 'object') continue;
      // functionCall 自带的签名不能污染 lastThoughtSignature(否则会以"thought 来源"记错)
      if (part.thoughtSignature && !part.functionCall) lastThoughtSignature = String(part.thoughtSignature);
      if (typeof part.text === 'string' && part.text) {
        if (part.thought === true) {
          markFirstToken();
          reasoning += part.text;
          onDelta?.({ kind: 'reasoning', text: part.text });
        } else {
          markFirstToken();
          content += part.text;
          onDelta?.({ kind: 'text', text: part.text });
        }
      }
      if (part.functionCall) addFunctionCall(part.functionCall.name, part.functionCall.args, part.thoughtSignature, part.functionCall.id);
    }
    if (cand?.finishReason) finishReason = String(cand.finishReason);
    if (ev?.usageMetadata) usage = geminiUsage(ev.usageMetadata);
    return false; // 不提前停止:usageMetadata 常在 finishReason 之后单独一帧
  });
  // 提示词被安全策略整体拦截:没有任何候选可用,重试不会变好,直接给可读原因
  if (blockReason && !content && !reasoning && !calls.length) {
    throw new Error(`Gemini 拒绝了该请求(promptFeedback.blockReason=${blockReason}),请调整输入内容后重试`);
  }
  const truncated = assertStreamEnded(!!finishReason, { sawData, rawHead, tolerateMissingEnd });
  const toolCalls: ToolCallSpec[] = calls.map((c) => ({
    id: c.id,
    name: c.name,
    arguments: c.args || '{}',
    ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature, thoughtSignatureOnThought: c.thoughtSignatureOnThought === true } : {})
  }));
  return {
    content, toolCalls, reasoning,
    finishReason: GEMINI_FINISH[finishReason] || finishReason,
    usage: normalizeTokenUsage(usage),
    ...(firstTokenTime !== null ? { firstTokenTime } : {}),
    ...(truncated ? { truncated: true } : {})
  };
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
  let lastUsage: any = null; // 提供方上报的**原始** usage(通常在流末尾),finish() 时归一成四桶
  const toolAcc = new Map(); // index -> {id,name,args}
  let toolSeq: any[] = [];
  /**
   * 首个 token 到达的绝对时刻(ms)。用于统计栏的「首 token 延迟(TTFT)」与「解码速度」。
   * 语义照搬 harness 的 assistantStreamFirstTokenTime:第一个**非空**的正文/思考增量,
   * 或第一个带名字的工具调用增量 —— 空增量与心跳不算"开始出字"。
   * 只在本次尝试内取第一次;重试会重新解析,拿到的是最终成功那次的值。
   */
  let firstTokenTime: number | null = null;
  const markFirstToken = () => { if (firstTokenTime === null) firstTokenTime = Date.now(); };

  const feedDelta = (delta: any) => {
    if (delta.content) {
      markFirstToken();
      content += delta.content;
      onDelta?.({ kind: 'text', text: delta.content });
    }
    // 思考增量:不再按模型名门控(此前只收 deepseek-v4,其他模型的思考被静默丢弃,
    // 前端永远看不到);兼容 reasoning_content(DeepSeek/GLM/Qwen 系)与
    // reasoning(OpenRouter 风格)两种字段名
    const r = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
      : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (r) {
      markFirstToken();
      reasoning += r;
      onDelta?.({ kind: 'reasoning', text: r });
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const acc = toolAcc.get(idx) || { id: null, name: '', args: '' };
        if (tc.id) acc.id = tc.id;
        // 工具名先于参数到达:名字到达即算"开始出字"(与 harness 的 name-bearing run 一致)
        if (tc.function?.name) { markFirstToken(); acc.name += tc.function.name; }
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
          // 不强制 stream_options(部分聚合网关不支持该参数)。
          // 这里只存**原始**对象,归一成四桶留到 finish()——不同网关可能在中途报
          // 只有 prompt_tokens 的中间态,提前归一会被后一条更完整的覆盖掉。
          const u = j.usage && typeof j.usage === 'object' ? j.usage
            : (choice?.usage && typeof choice.usage === 'object' ? choice.usage : null);
          if (u && (typeof u.prompt_tokens === 'number' || typeof u.input_tokens === 'number')) lastUsage = u;
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
    // 归一成四桶(含缓存字段);上游没报或不可信时为 null
    const usage = normalizeTokenUsage(lastUsage);
    return {
      content, toolCalls, reasoning, finishReason, usage,
      ...(firstTokenTime !== null ? { firstTokenTime } : {}),
      ...(truncated ? { truncated: true } : {})
    };
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

  // 父代理:用户说"交付/成果物"时走 本地写文件 → present 两步(联调用)。
  // 用来端到端验证成果物卡片(以及从卡片进右侧栏)这条链路,默认脚本不受影响。
  const wantsDeliver = /成果物|交付/.test(String(lastUser?.content || ''));
  if (wantsDeliver) {
    // 取**本地**工作区路径:不能用 extractWorkspace —— 它匹配的是第一个"工作区: ",
    // 在同时有远程和本地时会拿到远程路径,而 write_local_file 只认本地工作区。
    let localWs = '';
    for (const m of messages) {
      const mm = m.content?.match?.(/本地工作区: ([^\n]+)/);
      if (mm) { localWs = mm[1].trim(); break; }
    }
    const dir = localWs || ws || '.';
    const p = `${dir}/deliverable.md`;
    if (toolMsgs.length === 0) {
      onDelta?.({ kind: 'text', text: '好,我写一个文件,然后交付给你。' });
      return {
        content: '好,我写一个文件,然后交付给你。',
        toolCalls: [mk('write_local_file', {
          path: p,
          content: '# 交付物\n\n由 mock 生成,用于验证成果物卡片与右侧栏。\n'
        })]
      };
    }
    if (toolMsgs.length === 1) {
      return { content: '', toolCalls: [mk('present', { files: [{ path: p, description: 'mock 生成的交付物' }] })] };
    }
    onDelta?.({ kind: 'text', text: '已经交付给你了,可以点卡片打开。' });
    return { content: '已经交付给你了,可以点卡片打开。', toolCalls: [] };
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
  // mock 也给出首个 token 时刻:统计栏(TTFT/速度)在 mock 与 e2e 里同样可被验证
  return { ...result, firstTokenTime: Date.now() };
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
