// 上下文用量估算(启发式,与后端 server/agent/compact.js 的算法保持一致):
// 中文约 1.6 字符/token、英文约 3 字符/token + 每条消息 JSON 结构开销。
// 不做 tokenizer 依赖,精度足以支撑「已用上下文」水位显示。
// 注:这只是后端未上报真实用量时的兜底口径;仪表盘优先显示服务端 context_usage
// 事件里的"实际请求 token"(provider 上报)与"折叠后预估"。
// 关键口径:本文件的估算一律按「模型可见面」计——压缩是非破坏的,被压早期消息
// 仍完整留在聊天里显示,但模型从最后一个压缩标记行起才看得到(标记行本身携带摘要,
// 即模型面第一条)。若按整个渲染历史估算,压缩后水位会纹丝不动(把模型已看不到的
// 消息也算进去),这正是"压缩了却还是没变"的根因。见 modelFaceMessages。
const CHARS_PER_CJK = 1.6;
const CHARS_PER_ASCII = 3;
const MSG_OVERHEAD = 12;

/** 估算一段文本的 token 数 */
export function estimateTokens(s: unknown): number {
  const str = String(s ?? '');
  if (!str) return 0;
  let cjk = 0;
  for (const ch of str) if (ch >= '\u4e00' && ch <= '\u9fff') cjk++;
  const ascii = str.length - cjk;
  return Math.ceil(cjk / CHARS_PER_CJK + ascii / CHARS_PER_ASCII) + 1;
}

/**
 * 取「模型可见面」消息(前端兜底估算的水位口径,必须与服务端 deriveMessages 一致):
 * 压缩是非破坏的——被压早期消息仍完整保留在渲染历史里(可回看),模型却从最后一个
 * 压缩标记行起才看得到。标记行本身携带压缩摘要,就是模型面的第一条消息。
 * 因此从最后一个 `compaction` 标记开始切片;没有压缩标记时原样返回。
 * @param msgs 前端渲染历史(ChatMessage[],压缩标记行为 { role:'user', compaction:{...} })
 */
export function modelFaceMessages(msgs: unknown[]): unknown[] {
  const arr = msgs || [];
  let last = -1;
  arr.forEach((m, i) => {
    if (m && typeof m === 'object' && (m as { compaction?: { running?: boolean } }).compaction && !(m as { compaction?: { running?: boolean } }).compaction?.running) last = i;
  });
  return last >= 0 ? arr.slice(last) : arr;
}

/**
 * 估算一组聊天消息的 token 数(消息含 content/reasoning/segments 时按 JSON 整体估算)。
 * 只算模型可见面:压缩后从最后一个压缩标记行起,与服务端口径对齐,见 modelFaceMessages。
 */
export function estimateMessages(msgs: unknown[]): number {
  return modelFaceMessages(msgs).reduce<number>((n, m) => {
    let body: string;
    try { body = JSON.stringify(m) as string; } catch { body = String((m as { content?: unknown } | null)?.content ?? ''); }
    return n + estimateTokens(body) + MSG_OVERHEAD;
  }, 0);
}

/** system 提示词 + 工具 schema 的近似固定开销(随提示词内容变化,取常见量级) */
export const SYSTEM_EST = 1200;

/** 上下文明细分段(供悬浮面板展示):系统提示词 / 工具调用 / 对话消息 */
export interface ContextBreakdown {
  system: number;
  tools: number;
  conversation: number;
}

/**
 * 按用途估算各分段 token(同样只算模型可见面,见 modelFaceMessages):
 * - system:系统提示词 + 工具 schema(固定近似)
 * - tools:历史中的工具调用(schema 之外)与工具执行结果消息
 * - conversation:用户/助手正文消息 + 当前输入框内容
 *
 * 分类按"段"而非"整条消息":一条 assistant 回复往往同时含 思考/正文/工具组,
 * 若按消息判断(任一段为 tools 即整条归工具),正文会被误计入工具调用。
 */
export function estimateBreakdown(msgs: unknown[], input: unknown): ContextBreakdown {
  let tools = 0;
  let conversation = 0;
  const estOf = (v: unknown) => estimateTokens(v) + MSG_OVERHEAD;
  for (const m of modelFaceMessages(msgs)) {
    const obj = m as { role?: string; content?: unknown; segments?: Array<{ kind?: string; text?: string; tools?: unknown }>; tool_calls?: unknown } | null;
    // 纯工具执行结果消息:整条归工具
    if (obj?.role === 'tool') {
      tools += estOf(m);
      continue;
    }
    // 带分段的渲染消息:思考/正文归对话,工具组归工具
    if (Array.isArray(obj?.segments) && obj.segments.length) {
      for (const s of obj.segments) {
        if (s?.kind === 'tools') tools += estOf(s.tools);
        else conversation += estOf(s?.text ?? '');
      }
      continue;
    }
    // 无分段:仅含 tool_calls 的消息归工具,其余(user/纯文本 assistant/notice 等)归对话
    if (!!obj?.tool_calls) tools += estOf(m);
    else conversation += estOf(m);
  }
  conversation += estimateTokens(String(input ?? '')) + MSG_OVERHEAD;
  return { system: SYSTEM_EST, tools, conversation };
}

/** 数字格式化为人类可读:>=1000 显示 k(如 45.2k),>=1e6 显示 M */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  return v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}
