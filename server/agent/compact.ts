// 上下文窗口自动压缩(设计参照 deepseek-harness 的 compaction-basic 子系统):
// - 每个模型可在提供方配置里声明 contextWindow(输入上下文长度)与 maxTokens(单次输出上限)。
// - 每次发请求前按"对话组"(一条 user 到下一条 user 之间)估算 token;
//   超过阈值窗口(默认 contextWindow×80%,再扣除输出预留)时,把早期对话组压缩成
//   一段摘要(调用 LLM,reasoning=off,不含工具),保留最近约 retainRatio(16%)的窗口。
// - 摘要生成失败时降级为"直接裁剪"(丢弃早期对话组),保证对话永不因压缩失败中断。
// - token 估算为启发式(中文约 1.6 字符/token、英文约 4 字符/token + 每条消息 JSON 结构开销),
//   不引入 tokenizer 依赖,精确度足以做窗口水位判断。
import { AGENT } from '../config.ts';
import type { LlmClient } from './llm.ts';

export const COMPACT = {
  THRESHOLD_RATIO: 0.8,      // 触发压缩的水位:可用上下文(窗口-输出预留)的 80%
  RETAIN_RATIO: 0.16,        // 保留的比例:压缩后保留最近约 contextWindow×16% 的窗口
  SUMMARY_MAX_TOKENS: 8192,  // 摘要生成请求的输出上限(参照 harness 的 compaction maxTokens)
  MSG_OVERHEAD: 12,          // 每条消息 JSON 结构(role/键名/tool_calls)的近似 token 开销
  CHARS_PER_CJK_TOKEN: 1.6,  // 中文近似
  CHARS_PER_ASCII_TOKEN: 4   // 英文/数字/符号近似
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

/**
 * 选择可压缩区间:从头部整组丢弃,保留最近的 retainTokens 窗口(至少保留最后一条 user 组)。
 * 组边界保证:压缩掉的区间内部 user/assistant/tool 配对完整,
 * 保留区起点必然是 user 消息,因此压缩后历史始终以 user 开头、消息序列合法。
 * @returns 无可压缩区间时返回 null
 */
export function selectCompactRange(msgs: any[], retainTokens: number): { drop: any[]; recent: any[] } | null {
  if (!Array.isArray(msgs) || msgs.length < 3) return null;
  const groupStarts: number[] = [];
  msgs.forEach((m, i) => { if (m && m.role === 'user') groupStarts.push(i); });
  if (groupStarts.length < 2) return null; // 只有一组对话,无可压缩的早期历史

  // 从尾部向前累加"对话组"的 token,直到达到保留水位;keep 即保留区起点
  let keep = msgs.length;
  let acc = 0;
  for (let g = groupStarts.length - 1; g >= 0; g--) {
    const s = groupStarts[g];
    const part = msgs.slice(s, keep);
    acc += measureMessages(part);
    keep = s;
    if (acc >= retainTokens) break;
  }
  // 全部组都在保留范围内(历史本身很小):退化为只保留最后一组
  if (keep === 0) keep = groupStarts[groupStarts.length - 1];
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
 * 未配置 contextWindow 或未超阈值时原样返回;超阈值时选区间 -> 生成摘要(失败降级裁剪)
 * -> 返回 [摘要消息, ...保留区最近消息]。
 */
export async function compactHistory({ messages, system, llm, signal, contextWindow, maxTokens }: { messages: any[]; system?: string; llm?: LlmClient; signal?: AbortSignal; contextWindow?: unknown; maxTokens?: unknown }): Promise<{ messages: any[]; compacted: boolean; dropCount: number }> {
  const spec = resolveCompactSpec(contextWindow, maxTokens);
  if (!spec.enabled) return { messages, compacted: false, dropCount: 0 };
  if (measureMessages(messages) <= spec.thresholdTokens) return { messages, compacted: false, dropCount: 0 };

  const range = selectCompactRange(messages, spec.retainTokens);
  if (!range) return { messages, compacted: false, dropCount: 0 };

  let summary = '';
  if (llm && !llm.isMock) {
    try {
      summary = await summarizeWithLlm({ llm, system, dropMsgs: range.drop, signal });
    } catch (e: any) {
      console.warn(`[compact] 摘要生成失败,降级为直接裁剪: ${e?.message || e}`);
    }
  }

  const summaryMsg = {
    role: 'user',
    content: summary
      ? `【上下文已自动压缩】为节省上下文窗口,早期对话被压缩为以下摘要(如需细节请让助手展开):\n${summary}`
      : `【上下文已自动压缩】早期 ${range.drop.length} 条消息因超出上下文窗口已省略。`
  };
  return { messages: [summaryMsg, ...range.recent], compacted: true, dropCount: range.drop.length };
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
