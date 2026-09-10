// 上下文窗口自动压缩(设计参照 dsh 的 compaction-basic 子系统):
// - 每个模型可在提供方配置里声明 contextWindow(输入上下文长度)与 maxTokens(单次输出上限)。
// - 每次发请求前估算 token;超过阈值窗口(默认 contextWindow×80%,再扣除输出预留)时,
//   把早期区间压缩成一段结构化 checkpoint 摘要(调用 LLM,不带工具;思考系列模型默认开启思考),
//   保留最近约 retainRatio(16%)的窗口。
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
  // 手动压缩(/compact)的最小收益门槛:可压区间低于该 token 数时直接判"无需压缩"。
  // 摘要模板固定 9 个 section(~255 token 起步),区间太小时摘要必然不小于被压内容,
  // shrink 校验必报"压缩失败"——那是"会话还不需要压缩"的正常状态,不是失败。
  MANUAL_MIN_GAIN_TOKENS: 1000,
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
 * 由模型的 contextWindow/maxTokens 推导压缩水位(照搬 harness compaction-basic 的
 * thresholdRatio/retainRatio):
 * - thresholdTokens:触发压缩的阈值 = 窗口 × 80%(测量口径含固定信封,见 compactHistory);
 * - retainTokens:压缩后保留的最近窗口 = 窗口 × 16%
 */
export function resolveCompactSpec(contextWindow: unknown, maxTokens: unknown): { enabled: boolean; thresholdTokens: number; retainTokens: number } {
  const win = Number(contextWindow) || 0;
  if (win <= 0) return { enabled: false, thresholdTokens: 0, retainTokens: 0 };
  return {
    enabled: true,
    thresholdTokens: Math.floor(win * COMPACT.THRESHOLD_RATIO),
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

/**
 * 手动压缩(/compact)的区间选择:selectCompactRange 位置式切点 + 组边界钳制。
 * - 组边界只认"真实用户消息"(isRealUser 由调用方回查事件日志,排除 runtime 快照与
 *   压缩摘要这类 user 角色的注入消息)——runtime_context 快照紧跟真实消息注入,
 *   若算作组边界,单条消息的深任务会话会被误判为"多组对话"而触发钳制,
 *   可压区间被压到只剩第一条真实消息(实测 40 token),摘要模板(~255 token)
 *   必然更大,shrink 校验必报"压缩失败"(修复前 /compact 在此类会话上必挂);
 * - 多组对话:切点不越过最后一组起点(至少保留完整最后一组);单组(单消息深任务):
 *   直接用位置式切点,允许压缩组内早期步骤;
 * - 钳制后早期区间太小(压了不回本)时回退位置式切点:最后一组占满保留水位的深任务,
 *   同样允许压进组内早期步骤(切点已对齐工具配对边界,保留区仍是最近 retainTokens);
 * - 位置式无可压缩区间(历史全在保留水位内)时走旧语义兜底:至少把除最后一组外的
 *   早期对话全部压缩掉,保证小组会话上 /compact 仍有收益;
 * - 最终防线:可压区间低于 MANUAL_MIN_GAIN_TOKENS 时返回 null(无需压缩),
 *   而不是让 shrink 校验对着摘要模板的最小体量报错。
 * @returns 无可压缩区间时返回 null
 */
export function selectManualCompactRange(msgs: any[], retainTokens: number, isRealUser: (i: number) => boolean): { drop: any[]; recent: any[] } | null {
  if (!Array.isArray(msgs) || msgs.length < 3) return null;
  const realUserIdx: number[] = [];
  msgs.forEach((_, i) => { if (isRealUser(i)) realUserIdx.push(i); });

  // 兜底分支:位置式无可压缩区间(历史全在保留水位内)
  let range = selectCompactRange(msgs, retainTokens);
  if (!range) {
    if (realUserIdx.length >= 2) {
      const cut = realUserIdx[realUserIdx.length - 1];
      if (cut > 0) return finalizeRange(msgs, cut);
    }
    return null;
  }

  // 单组(唯一真实用户消息,或日志里已无真实用户消息):直接用位置式切点
  const first = realUserIdx.length ? realUserIdx[0] : -1;
  const last = realUserIdx.length ? realUserIdx[realUserIdx.length - 1] : -1;
  let keep = first === last
    ? range.drop.length
    : Math.min(range.drop.length, last);
  // 钳制后早期区间无收益:回退位置式切点(压进最后一组的早期步骤)
  if (keep < range.drop.length && measureMessages(msgs.slice(0, keep)) < COMPACT.MANUAL_MIN_GAIN_TOKENS) {
    keep = range.drop.length;
  }
  return finalizeRange(msgs, keep);
}

/** 区间落地前的公共校验:切点合法且可压区间达到最小收益门槛,否则返回 null */
function finalizeRange(msgs: any[], keep: number): { drop: any[]; recent: any[] } | null {
  if (keep <= 0 || keep >= msgs.length) return null;
  const drop = msgs.slice(0, keep);
  if (!drop.length || measureMessages(drop) < COMPACT.MANUAL_MIN_GAIN_TOKENS) return null;
  return { drop, recent: msgs.slice(keep) };
}

/** 摘要指令:要求把对话历史压缩成紧凑的结构化 checkpoint(照搬 harness 的 COMPACTION_INSTRUCTION,中文版) */
export function compactionInstruction(): string {
  return [
    '你现在充当这个 AI 编码助手的压缩引擎。把上面(ABOVE)的对话压缩成一份结构化 checkpoint,让另一个模型在不丢失关键上下文的前提下接续工作。',
    '',
    '严格按下面的 Markdown 结构输出:每个 section 都保留、按顺序排列。用简洁的条目式 bullet,不要散文段落。空 section 写"(无)"——绝不要删掉任何 section。',
    '',
    '## 主要请求与意图',
    '- [用户的原始与演化目标;措辞关键处逐字引用]',
    '',
    '## 关键技术概念',
    '- [涉及的框架、模式与约定]',
    '',
    '## 文件与代码',
    '- [确切路径:为何重要、关键改动或片段]',
    '',
    '## 错误与修复',
    '- [错误:如何解决,以及相关的用户反馈]',
    '',
    '## 待办任务',
    '- [明确请求但尚未完成的工作]',
    '',
    '## 当前工作',
    '- [这个检查点时正在进行的工作]',
    '',
    '## 下一步',
    '- [与最近请求直接一致的唯一动作,或"(无)"]',
    '',
    '## 关键上下文',
    '- [决策及其理由、约束、用户偏好、未决问题、继续所需的数据]',
    '',
    '规则:',
    '- 用简洁的中文工程叙述。保留确切的文件路径、命令、错误串、标识符、数值、函数签名与语法片段。',
    '- 忠实记录用户的反馈与明确指令,尤其是纠正。',
    '- 不要提及本次压缩请求,或上下文已被压缩。',
    '- 只输出 checkpoint 文本:不要调用任何工具,也不要采取其他动作。',
    '- 若对话中已包含 <compacted-summary> 块,它是先前 checkpoint:不要逐字复制它,',
    '  保留仍然成立的事实、剔除过时内容,把新信息合并进同一结构的单一汇总。'
  ].join('\n');
}

/**
 * 对消息历史执行上下文压缩(照搬 harness compaction-basic 的 compactIfNeeded 顺序):
 * 1) 测量:整次请求 = surface 消息 + 固定信封(reservedTokens = system + 工具 schema 的估算);
 * 2) 未超窗口 80% 水位(且非 force)时原样返回;
 * 3) 超水位:先跑无模型免费裁剪——pruner 把 surface 上所有超过 8192 字符的工具结果
 *    折叠为头尾摘要(照搬 harness compaction-tool-result-pruner,不保留最近几条),
 *    重测后回到水位内则只返回折叠结果(compacted=false,pruned=N,日志不动);
 * 4) 仍超:选区间 -> 生成摘要(失败降级裁剪)-> 返回 [摘要消息, ...保留区最近消息]。
 * onStart:确认要压缩(区间已选定)时同步回调一次——摘要要调一次 LLM,可能耗时数十秒,
 *   上层据此把「正在压缩上下文…」的运行态推给前端;只在真的要压缩时触发,避免未超水位
 *   的绝大多数步骤留下永不收尾的运行行。
 * force:跳过阈值检查强制执行(上下文爆窗恢复用);retainTokensOverride:覆盖保留水位
 * (爆窗恢复传 0 = 只保留最后一个配对完整节点,最大力度压缩)。
 */
export async function compactHistory({ messages, system, llm, signal, contextWindow, maxTokens, reservedTokens = 0, force = false, retainTokensOverride, onStart }: { messages: any[]; system?: string; llm?: LlmClient; signal?: AbortSignal; contextWindow?: unknown; maxTokens?: unknown; reservedTokens?: number; force?: boolean; retainTokensOverride?: number; onStart?: () => void }): Promise<{ messages: any[]; compacted: boolean; dropCount: number; pruned: number }> {
  const spec = resolveCompactSpec(contextWindow, maxTokens);
  if (!spec.enabled) return { messages, compacted: false, dropCount: 0, pruned: 0 };
  // 水位(照搬 harness):threshold = 窗口×80%,且必须大于保留水位(对齐 harness 的
  // "retainTokens < thresholdTokens" 校验,防异常配置导致每步都压缩、保留区几乎为空)
  const thresholdTokens = Math.max(spec.retainTokens + 1, spec.thresholdTokens);
  const reserved = Math.max(0, Math.floor(reservedTokens));
  // 测量口径 = surface + 固定信封:真实请求 = 历史 + system + 工具 schema,
  // 只量历史会让触发点比真实水位晚一个信封的体量(实测偏差可达数万 token)。
  if (!force && measureMessages(messages) + reserved <= thresholdTokens) {
    return { messages, compacted: false, dropCount: 0, pruned: 0 };
  }

  // 第一遍:无模型免费裁剪(照搬 harness compaction-tool-result-pruner 默认值:
  // 8192/4096/1024,对 surface 上所有超限结果生效,不保留最近几条)
  const P = AGENT.TOOL_RESULT_PRUNE;
  const prunedRes = pruneToolResults(messages, {
    keepRecent: 0, minChars: P.THRESHOLD_CHARS, headChars: P.HEAD_CHARS, tailChars: P.TAIL_CHARS
  });
  let msgs = prunedRes.messages;
  if (!force && measureMessages(msgs) + reserved <= thresholdTokens) {
    // 折叠后已回到水位内:无需摘要压缩,折叠只作用于投影(事件日志保持完整)
    return { messages: msgs, compacted: false, dropCount: 0, pruned: prunedRes.pruned };
  }

  const retainTokens = retainTokensOverride === undefined ? spec.retainTokens : Math.max(0, Math.floor(retainTokensOverride));
  const range = selectCompactRange(msgs, retainTokens);
  if (!range) return { messages: msgs, compacted: false, dropCount: 0, pruned: prunedRes.pruned };
  // 区间已选定 = 确实要压缩了:先同步通知上层(摘要要调一次 LLM,可能几十秒),
  // 让前端在对话流里插入「正在压缩上下文…」的运行态行。
  if (typeof onStart === 'function') { try { onStart(); } catch {} }

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
  return { messages: [summaryMsg, ...range.recent], compacted: true, dropCount: range.drop.length, pruned: prunedRes.pruned };
}

/** 摘要生成失败降级裁剪时,至少保留被裁区间的原始任务锚点(第一条 user 消息),避免模型"失忆" */
function preserveOriginalTask(dropMsgs: any[]): string {
  const first = (dropMsgs || []).find((m) => m && m.role === 'user' && m.content);
  return first ? `\n原始任务(降级裁剪时保留,供后续对话回顾):\n${first.content}` : '';
}

/** 调用 LLM 生成摘要:沿用原始 system 前缀 + 被压缩的历史 + 摘要指令,不带工具。
 *  reasoning 不传(默认档):思考系列模型(DeepSeek v4 / GLM-4.5+/GLM-5.x 等)默认开启深度思考——
 *  此前硬编码 reasoning:'off' 会让 glm-5.3-flash 等强制思考模型返回 400 REASONING_REQUIRED。 */
export async function summarizeWithLlm({ llm, system, dropMsgs, signal }: { llm: LlmClient; system?: string; dropMsgs: any[]; signal?: AbortSignal }): Promise<string> {
  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...dropMsgs,
    { role: 'user', content: compactionInstruction() }
  ];
  const res = await llm.chat({
    messages,
    tools: [],
    signal
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
