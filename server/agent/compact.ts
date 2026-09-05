// 上下文窗口自动压缩(设计参照 dsh 的 compaction-basic 子系统):
// - 每个模型可在提供方配置里声明 contextWindow(输入上下文长度)与 maxTokens(单次输出上限)。
// - 每次发请求前估算 token;超过阈值窗口(默认 contextWindow×80%,再扣除输出预留)时,
//   把早期区间压缩成一段摘要(调用 LLM,reasoning=off,不含工具),保留最近约 retainRatio(16%)的窗口。
// - 区间选择按"位置"而非"对话组"(见 selectCompactRange):单条消息引发的深工具任务
//   同样可以中途压缩;切点对齐工具配对边界,压缩后消息序列始终合法。
// - 摘要生成失败时降级为"直接裁剪"(丢弃早期区间,保留任务锚点),保证对话永不因压缩失败中断。
// - token 估算为启发式(中文约 1.6 字符/token、英文约 3 字符/token + 每条消息 JSON 结构开销),
//   不引入 tokenizer 依赖,精确度足以做窗口水位判断。
import { AGENT } from '../config.ts';
import type { LlmClient } from './llm.ts';

export const COMPACT = {
  THRESHOLD_RATIO: 0.8,      // 触发压缩的水位:可用上下文(窗口-输出预留)的 80%
  RETAIN_RATIO: 0.16,        // 保留的比例:压缩后保留最近约 contextWindow×16% 的窗口
  SUMMARY_MAX_TOKENS: 8192,  // 摘要生成请求的输出上限(参照 harness 的 compaction maxTokens)
  MSG_OVERHEAD: 12,          // 每条消息 JSON 结构(role/键名/tool_calls)的近似 token 开销
  CHARS_PER_CJK_TOKEN: 1.6,  // 中文近似
  CHARS_PER_ASCII_TOKEN: 3   // 英文/代码/符号近似。4 偏乐观:代码/JSON 实测 ~2.8-3.2,
                              // 十六进制哈希甚至 ~1.5;取 3 让水位判断偏保守(宁可早压不可爆窗)
};

/** 启发式估算一段文本的 token 数 */
export function estimateTokens(s: unknown): number {
  const str = String(s ?? '');
  if (!str) return 0;
  let cjk = 0;
  for (const ch of str) if (ch >= '一' && ch <= '鿿') cjk++;
  const ascii = str.length - cjk;
  return Math.ceil(cjk / COMPACT.CHARS_PER_CJK_TOKEN + ascii / COMPACT.CHARS_PER_ASCII_TOKEN) + 1;
}

/** 估算一条 LLM 消息的 token(含 JSON 序列化开销) */
export function messageTokens(m: any): number {
  return estimateTokens(m && typeof m === 'object' ? JSON.stringify(m) : String(m ?? '')) + COMPACT.MSG_OVERHEAD;
}

/** 估算一组消息的总 token */
export function measureMessages(msgs: any[]): number {
  return (msgs || []).reduce((n, m) => n + messageTokens(m), 0);
}

/**
 * 由模型的 contextWindow/maxTokens 推导压缩水位:
 * - thresholdTokens:触发压缩的阈值(可用的输入预算×80%)
 * - retainTokens:压缩后希望保留的最近窗口
 */
export function resolveCompactSpec(contextWindow: unknown, maxTokens: unknown): { enabled: boolean; thresholdTokens: number; retainTokens: number } {
  const win = Number(contextWindow) || 0;
  if (win <= 0) return { enabled: false, thresholdTokens: 0, retainTokens: 0 };
  const out = Math.max(1, Number(maxTokens) || COMPACT.SUMMARY_MAX_TOKENS);
  const usable = Math.max(1, win - out); // 输入侧可用预算
  return {
    enabled: true,
    thresholdTokens: Math.floor(usable * COMPACT.THRESHOLD_RATIO),
    retainTokens: Math.floor(win * COMPACT.RETAIN_RATIO)
  };
}

/** 兜底字符裁剪预算:由输入窗口(token)换算(保守取 2 字符/token),未配置窗口时回退固定默认
 *  (AGENT.HISTORY_BUDGET_CHARS)。目的:对齐前端仪表盘的 token 口径,消除"模型窗口还很足
 *  却被固定字符数硬裁"的单位错配。精确水位保护由摘要压缩的 token 估算承担,这里只是兜底。 */
export function resolveCharBudget(contextWindow: unknown): number {
  const win = Number(contextWindow) || 0;
  if (win <= 0) return AGENT.HISTORY_BUDGET_CHARS;
  return Math.floor(win * 2);
}

/**
 * 选择可压缩区间(参照 harness region.ts 的 selectCompactableRange,按位置而非对话组):
 * - 从尾部向前按消息累积 token,直到达到保留水位,候选切点为 keep;
 * - 再把切点向前对齐到"工具配对完整"的消息边界:assistant 的 tool_calls 与其
 *   tool 结果绝不拆分,切点后的保留区可能以 user 或 assistant 开头
 *   (压缩后由摘要 user 消息打头,序列依然合法);
 * - 关键差异:不再要求 ≥2 条 user 消息——单条消息引发的深工具任务(只有一个
 *   对话组)同样可以中途压缩,这是长任务上下文治理的核心防线;
 * - 全部消息都在保留水位内时返回 null(无需压缩)。
 * @returns 无可压缩区间时返回 null
 */
export function selectCompactRange(msgs: any[], retainTokens: number): { drop: any[]; recent: any[] } | null {
  if (!Array.isArray(msgs) || msgs.length < 3) return null;

  // 从尾部倒着累加 token,找保留区起点候选
  let keep = msgs.length;
  let acc = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    acc += messageTokens(msgs[i]);
    keep = i;
    if (acc >= retainTokens) break;
  }
  if (keep <= 0 || keep >= msgs.length) return null;

  // 切点对齐:valid[i] 表示"消息 0..i-1 的工具配对完整"(切在 i 处不拆散任何调用对);
  // user 消息会作废尚未消费的调用 id(与 OpenAI 工具配对语义一致)
  const valid = new Array(msgs.length + 1).fill(false);
  let pending: Set<string> = new Set();
  valid[0] = true;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i] || {};
    if (m.role === 'assistant') pending = new Set(((m.tool_calls || []) as any[]).map((t) => t.id));
    else if (m.role === 'user') pending = new Set();
    else if (m.role === 'tool' && m.tool_call_id) pending.delete(m.tool_call_id);
    valid[i + 1] = pending.size === 0;
  }
  while (keep > 0 && !valid[keep]) keep--;
  if (keep <= 0 || keep >= msgs.length) return null;
  const drop = msgs.slice(0, keep);
  if (!drop.length) return null;
  return { drop, recent: msgs.slice(keep) };
}

/** 摘要指令:要求把对话历史压缩为紧凑的结构化 checkpoint(参照 harness 的 COMPACTION_INSTRUCTION) */
export function compactionInstruction(): string {
  return [
    '请把上面的对话历史压缩成一段紧凑的中文摘要,供后续对话作为上下文回顾。要求:',
    '1. 保留所有用户提出的任务、明确要求与限制条件;',
    '2. 保留关键事实:远程平台、工作区路径、执行过的命令及其关键输出、创建/修改/删除的文件与路径、目录结构与环境探测结果;',
    '3. 保留尚未完成的任务与待办事项;',
    '4. 只压缩已有内容,不要新增信息,不要臆测,不要讨论摘要本身;',
    '5. 直接输出纯文本摘要,不要 Markdown 代码块,不要列表符号之外的多余格式。'
  ].join('\n');
}

/**
 * 对消息历史执行上下文压缩:
 * 未配置 contextWindow 或未超阈值(force=false)时原样返回;超阈值时选区间 -> 生成摘要
 * (失败降级裁剪)-> 返回 [摘要消息, ...保留区最近消息]。
 * reservedTokens:每次请求的固定开销(system 提示词 + 工具 schema 的估算 token),
 * 传入时从触发阈值里扣除——否则实际请求比水位估算大一截,压缩触发严重偏晚。
 * force:跳过阈值检查强制执行(上下文爆窗恢复用);retainTokensOverride:覆盖保留水位
 * (爆窗恢复传 0 = 只保留最后一个配对完整节点,最大力度压缩)。
 */
export async function compactHistory({ messages, system, llm, signal, contextWindow, maxTokens, reservedTokens = 0, force = false, retainTokensOverride }: { messages: any[]; system?: string; llm?: LlmClient; signal?: AbortSignal; contextWindow?: unknown; maxTokens?: unknown; reservedTokens?: number; force?: boolean; retainTokensOverride?: number }): Promise<{ messages: any[]; compacted: boolean; dropCount: number }> {
  const spec = resolveCompactSpec(contextWindow, maxTokens);
  if (!spec.enabled) return { messages, compacted: false, dropCount: 0 };
  // 水位扣除固定开销(system + 工具 schema):真实请求 = 历史 + 固定开销,
  // 只量历史会让触发点比真实爆窗点晚一个 system 的体量(实测偏差可达数万 token)。
  // 地板:阈值必须大于保留水位(retainTokens+1),对齐 harness 的"retainTokens < thresholdTokens"校验,
  // 防止固定开销异常巨大时阈值被扣到 0,导致每一步都触发压缩、保留区几乎为空
  const thresholdTokens = Math.max(spec.retainTokens + 1, Math.max(1, spec.thresholdTokens - Math.max(0, Math.floor(reservedTokens))));
  if (!force && measureMessages(messages) <= thresholdTokens) return { messages, compacted: false, dropCount: 0 };

  const retainTokens = retainTokensOverride === undefined ? spec.retainTokens : Math.max(0, Math.floor(retainTokensOverride));
  const range = selectCompactRange(messages, retainTokens);
  if (!range) return { messages, compacted: false, dropCount: 0 };

  let summary = '';
  if (llm && !llm.isMock) {
    try {
      // 摘要请求防超窗:drop 区间可能比当前请求还大,先把其中大体积工具结果折叠成头尾,
      // 再交给 LLM 汇总——否则摘要请求自己就会 400/被上游截断(摘要并不需要完整文件原文)
      const prunedDrop = pruneToolResults(range.drop, { keepRecent: 0, minChars: 1200, headChars: 900, tailChars: 300 }).messages;
      summary = await summarizeWithLlm({ llm, system, dropMsgs: prunedDrop, signal });
      // 提交前校验:摘要必须比被压缩区间更小(参照 harness 的 shrink 校验),
      // 否则压缩无收益,降级为直接裁剪(只保留任务锚点)
      if (estimateTokens(summary) >= measureMessages(range.drop)) {
        console.warn(`[compact] 摘要(${Math.round(estimateTokens(summary))} token)不小于被压缩区间(${Math.round(measureMessages(range.drop))} token),降级为直接裁剪`);
        summary = '';
      }
    } catch (e: any) {
      console.warn(`[compact] 摘要生成失败,降级为直接裁剪: ${e?.message || e}`);
    }
  }

  const summaryMsg = {
    role: 'user',
    content: summary
      ? `【上下文已自动压缩】为节省上下文窗口,早期对话被压缩为以下摘要(如需细节请让助手展开):\n${summary}`
      : `【上下文已自动压缩】早期 ${range.drop.length} 条消息因超出上下文窗口已省略。${preserveOriginalTask(range.drop)}`
  };
  return { messages: [summaryMsg, ...range.recent], compacted: true, dropCount: range.drop.length };
}

/** 摘要生成失败降级裁剪时,至少保留被裁区间的原始任务锚点(第一条 user 消息),避免模型"失忆" */
function preserveOriginalTask(dropMsgs: any[]): string {
  const first = (dropMsgs || []).find((m) => m && m.role === 'user' && m.content);
  return first ? `\n原始任务(降级裁剪时保留,供后续对话回顾):\n${first.content}` : '';
}

/** 调用 LLM 生成摘要:沿用原始 system 前缀 + 被压缩的历史 + 摘要指令,不带工具、关闭思考 */
export async function summarizeWithLlm({ llm, system, dropMsgs, signal }: { llm: LlmClient; system?: string; dropMsgs: any[]; signal?: AbortSignal }): Promise<string> {
  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...dropMsgs,
    { role: 'user', content: compactionInstruction() }
  ];
  const res = await llm.chat({
    messages,
    tools: [],
    signal,
    reasoning: 'off'
  });
  const text = (res && (res.content || '')) || '';
  return text.trim().slice(0, AGENT.HISTORY_BUDGET_CHARS);
}

// ---- 历史中旧工具结果的投影期折叠(参照 harness compaction-tool-result-pruner) ----
// 与 squash 摘要压缩互补:摘要压缩按"对话组"选区间,单轮深工具任务只有一组,永远够不着;
// 这里在请求构造时把"早期的大体积工具结果"替换为头尾摘要 + 回读指引,补上这道防线。
// 纯函数、不动事件日志:日志保持完整(可回放/分支),只裁模型当轮可见面。

export interface ToolResultPruneSpec {
  keepRecent: number;  // 最近 N 条工具结果保持原样(模型正在分析的活跃上下文)
  minChars: number;    // 只折叠超过该长度的结果
  headChars: number;
  tailChars: number;
}

function pruneHint(omitted: number): string {
  return `\n…[早期工具结果已折叠:省略中段 ${omitted} 字符。头尾已保留;需要完整内容可按原参数重新调用该工具,或用 read_file/read_local_file 的 offset 分段读取]…\n`;
}

/**
 * 折叠消息历史中早期的大体积工具结果:
 * - 只处理 role='tool' 的消息;最近 keepRecent 条不动(活跃上下文);
 * - 其余超过 minChars 的替换为 head + 提示 + tail,消息结构(role/tool_call_id)原样保留,
 *   序列合法性不受影响(只改 content 字符串);
 * - 返回新数组与统计;输入不被修改。
 */
export function pruneToolResults(msgs: any[], spec: ToolResultPruneSpec): { messages: any[]; pruned: number; charsSaved: number } {
  const toolIdx: number[] = [];
  (msgs || []).forEach((m, i) => {
    if (m && m.role === 'tool' && typeof m.content === 'string' && m.content.length > spec.minChars) toolIdx.push(i);
  });
  const keep = new Set(toolIdx.slice(-Math.max(0, spec.keepRecent)));
  const out = (msgs || []).slice();
  let pruned = 0;
  let charsSaved = 0;
  for (const i of toolIdx) {
    if (keep.has(i)) continue;
    const content = out[i].content;
    const omitted = content.length - spec.headChars - spec.tailChars;
    if (omitted <= 0) continue;
    out[i] = { ...out[i], content: content.slice(0, spec.headChars) + pruneHint(omitted) + content.slice(content.length - spec.tailChars) };
    pruned++;
    charsSaved += omitted;
  }
  return { messages: out, pruned, charsSaved };
}
