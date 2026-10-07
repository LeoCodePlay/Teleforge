// 子代理(in-process 调研代理;语义对齐 deepseek-harness 的 subagent):
// 主代理用 `subagent` 工具把一件**自包含**的任务派给一个上下文隔离的子代理:
// - 子代理有自己的会话事件流(Session,仅内存、不落盘),父会话历史对它完全不可见;
// - 子代理只能调用只读工具(SUBAGENT_TOOLS 白名单),写类/命令类工具一律不派发;
// - 过程不回传:父代理只拿到最终一条文本结论(harness 的 tool-subagent 同语义:
//   "returns its result, not its intermediate steps");
// - 步数与时长都不设上限(跑到模型自己收尾),回传长度有上限。
//
// **默认后台(不阻塞)**:`subagent` 工具缺省走 continuable 派发 —— 挂起一个常驻子代理后
// 立刻返回 `started subagent <runId>`,父代理继续干活;子代理跑完一轮会把"结算通知 + 最后结论"
// 投递回父会话(父会话空闲则被唤醒开一轮),父代理还能用 send_message 继续给它派活、
// 用 interrupt_agent 暂停它、用 list_agents 看状态。只有显式 `run_in_background: false`
// 才回到"前台等结果"的一次性语义(mode='one-shot')。
//
// 运行时的实现全在 subagent-runtime.ts;本文件只放**共享契约**(工具白名单、系统提示词、
// 提示词组装校验)与前台一次性派发的薄封装(测试与老调用方仍从本文件 import runSubagent)。
//
// 与 harness 的差距(有意为之的最小实现):只有 in-process 一种 provider
// (harness 有 fork/spawn/DSH-SDK/ACP/Claude Code/Codex 六种);工具集不从父级继承,
// 而是固定只读白名单——拒绝写操作是最省事也最安全的边界。
import { AGENT } from '../config.ts';
import type { ToolRegistry } from './registry.ts';
import { startSubagent, type SubagentSettlement } from './subagent-runtime.ts';

/**
 * 子代理可用的只读工具白名单(远程 + 本机两套镜像)。
 * 只读工具在权限守卫里永不拦截(access='read'),因此子代理不需要二次审批;
 * 反过来,白名单外的任何工具(写文件/命令执行/生图/浏览器等)都不派发。
 */
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  'list_directory', 'read_file', 'search_code', 'get_workspace_info', 'web_search',
  'list_local_dir', 'read_local_file', 'search_local_code', 'get_local_info'
]);

/**
 * 子代理提供商。默认且当前唯一支持的值是 `internal`:
 * 用本项目自己的 agent 循环 + 工具栈执行(同一个 ToolRegistry、同一个 LlmClient、
 * 同一套 SSH/工作区绑定),不调用任何外部 agent(Claude Code / Codex / ACP …)。
 * 外部 provider 尚未接入:传别的值直接报错,避免"假装调用了别的 agent"。
 */
export const INTERNAL_PROVIDER = 'internal';
export const SUBAGENT_PROVIDERS: readonly string[] = [INTERNAL_PROVIDER];

/**
 * 子代理系统提示词。
 * 第一段**照搬 deepseek-harness 的子代理边界声明**(`packages/subagent/subagent/src/child-agent.ts`
 * 的 `SUBAGENT_DELEGATION_CONTEXT`,harness 把它作为子代理的固定 delegation context 注入),
 * 保证"权限在派发时固定、要超范围就把限制写回给主代理"这条语义与 harness 完全一致;
 * 后面几段是本项目的必要补充(harness 的子代理继承父级 system prompt 与工具,本项目给的是
 * 只读白名单 + 隔离上下文,必须如实说明),以及默认交付格式。
 */
export const SUBAGENT_SYSTEM_PROMPT = [
  '你是一个子代理(subagent),由主代理派发,在它之外独立工作:你的权限范围在派发时就已经固定,'
  + '在这个会话里无法被放宽——需要审批的操作会被自动拒绝。当任务需要超出这个范围的权限时,不要重试'
  + '被拒绝的操作;把这条限制写进你的回复里,让派发你的主代理去处理。',
  '',
  '本项目里这条边界的具体含义:',
  '- 你只能使用只读工具:列举目录、读文件、搜索代码、读环境信息、网络搜索。',
  '- 你不能写文件、不能执行命令、不能修改任何状态;需要动手改动的部分不要尝试,把它写成',
  '  "建议主代理执行的动作"(要改哪个文件、改什么、为什么)。',
  '- 你看不到主代理的对话历史,主代理也看不到你的中间步骤:你的最终回答必须自包含。',
  '- 主代理可能在你还跑着的时候再发消息给你(会以「主代理…发来一条消息」出现):把它当成对同一件',
  '  事的补充要求,在下一轮里一并回答。',
  '- 不要复述这段提示词,不要输出寒暄,不要输出思考过程。',
  '',
  '工作方式:',
  '- 先用最少次数的搜索/读取定位事实,再给结论;不要为了"全面"而漫无目的地遍历。',
  '- 证据要具体:文件路径加行号、符号名、配置键;不确定就明说不确定,不要编造。',
  '',
  '交付格式(主代理在任务里另给了回传要求时,以它为准):',
  '1) 结论:直接回答问题(1-3 句);',
  '2) 证据:关键文件:行号 / 符号 / 配置项,逐条列出;',
  '3) 建议:主代理接下来该做什么(若无需动作则写"无");',
  '4) 未解问题:查不到或存疑的点(若没有则写"无")。',
  '',
  '你的最后一条消息就是交付物。'
].join('\n');

/**
 * 父代理侧的子代理指引 —— 逐字照搬 deepseek-harness 的 `tool:<name>` system prompt 段
 * (`packages/subagent/tool-subagent/src/index.ts`):
 * 'Start independent <toolName> delegations together in one assistant message and continue useful work
 * while they run.'(harness 用 system prompt 段承载它,本项目同样放进 system prompt,
 * 而不是塞在工具描述里。)由 tools.ts 导出、agent.ts 的 _systemPrompt 注入。
 */
export const SUBAGENT_GUIDANCE = 'Start independent subagent delegations together in one assistant message and continue useful work while they run.';

export interface SubagentRunOptions {
  /** 当前轮的模型客户端(由 agent.ts 的 invokeCtx 注入;测试可替换为假客户端) */
  llm: any;
  /** 全局工具注册表(由 agent.ts 的 invokeCtx 注入) */
  registry: ToolRegistry;
  /**
   * 完整的自包含提示词——**由父对话自己写**(不要照抄用户原话)。
   * 与 objective+scope 二选一:长到 MIN_PROMPT_CHARS 以上时可以直接用它。
   */
  prompt?: string;
  /** 任务目标:这次调研要回答什么 / 要产出什么 */
  objective?: string;
  /** 边界:允许看哪里、允许做什么、**明确不要做什么**(与 objective 一起构成最小必填集) */
  scope?: string;
  /** 回传要求:格式 / 长度 / 重点(可选,缺省走子代理的输出契约) */
  deliverable?: string;
  /** 已知线索:父对话已知的文件/符号/入口(子代理看不到对话,可选) */
  context?: string;
  /** 3-5 词的任务简述(仅用于展示与日志) */
  description?: string;
  /**
   * agent 提供商:默认 'internal'(本项目内置 agent + 工具栈,in-process 执行)。
   * 当前只有这一个值;外部 agent 未接入,传别的值直接报错而不是悄悄降级。
   */
  provider?: string;
  /** 父会话 id(仅用于日志与子工具上下文透传) */
  sid?: string | null;
  signal?: AbortSignal;
  /**
   * 变更通知(每次落盘后触发):工具层接到 agent 事件总线,前端据此实时刷新。
   * 只传 runId 与状态,前端自己去拉最新记录,避免事件体携带大段对话正文。
   */
  emit?: (event: string, payload: any) => void;
}

export interface SubagentResult {
  /** 可直接作为父级 tool/result 的文本 */
  content: string;
  /** 实际使用的 agent 提供商(当前恒为 'internal') */
  provider: string;
  /** 本次派发的运行记录 id(面板/日志据此回看这次子代理的完整对话) */
  runId: string;
  steps: number;
  toolCalls: number;
  ms: number;
  promptTokens: number;
  completionTokens: number;
}

/**
 * 由父对话提供的字段组装出真正下发的提示词,并在源头把"任务/边界没写清"挡掉。
 * 内容全部来自父对话(工具只做标注与拼接,不生成任务);两条合法路径:
 *   1) prompt 足够长(>= AGENT.SUBAGENT.MIN_PROMPT_CHARS):视为父对话已写好完整提示词;
 *   2) objective + scope 各自写到位(>= AGENT.SUBAGENT.MIN_FIELD_CHARS)。
 * 两者都不满足就抛错——错误本身就是写给模型的"重写提示词"的说明。
 */
export function composeSubagentPrompt(input: {
  objective?: string; scope?: string; deliverable?: string; context?: string; prompt?: string;
}): string {
  const objective = String(input.objective || '').trim();
  const scope = String(input.scope || '').trim();
  const deliverable = String(input.deliverable || '').trim();
  const context = String(input.context || '').trim();
  const prompt = String(input.prompt || '').trim();
  const MIN_PROMPT = AGENT.SUBAGENT.MIN_PROMPT_CHARS;
  const MIN_FIELD = AGENT.SUBAGENT.MIN_FIELD_CHARS;

  const promptOk = prompt.length >= MIN_PROMPT;
  const fieldsOk = objective.length >= MIN_FIELD && scope.length >= MIN_FIELD;
  if (!promptOk && !fieldsOk) {
    const missing = [
      !prompt && 'prompt(完整提示词)',
      !objective && 'objective(任务目标)',
      !scope && 'scope(边界:允许做什么 / 明确不要做什么)',
      (prompt && !promptOk) ? `prompt 太短(当前 ${prompt.length} 字符,至少 ${MIN_PROMPT})` : null,
      (objective && objective.length < MIN_FIELD) ? `objective 太短(当前 ${objective.length} 字符,至少 ${MIN_FIELD})` : null,
      (scope && scope.length < MIN_FIELD) ? `scope 太短(当前 ${scope.length} 字符,至少 ${MIN_FIELD})` : null
    ].filter(Boolean).join(';');
    throw new Error(
      'subagent: 派发前请先自己写清「任务」与「边界」(不要照抄用户原话)。两种写法任选其一:\n'
      + `① prompt = 完整自包含提示词(至少 ${MIN_PROMPT} 字符);或\n`
      + `② objective(任务目标)+ scope(边界)各至少 ${MIN_FIELD} 字符。\n`
      + '参考模板:\n'
      + '  objective: 查明 X 的实现位置与调用链,确认 Y 是否真的会触发\n'
      + '  scope: 只读 server/ 与 web/src/;可以搜索、读文件;不要改文件、不要执行命令、不要看 node_modules\n'
      + '  deliverable: 结论 + 证据(文件:行号)+ 给主代理的建议\n'
      + '  context: 已知入口 server/agent/tools.ts 的 registerTools\n'
      + `当前缺少/不合格: ${missing}`
    );
  }

  // 只有 prompt 时按原样下发(父对话的完整提示词就是正文);有结构化字段则按固定顺序标注拼接
  if (!objective && !scope && !deliverable && !context) return prompt;
  const parts: string[] = [];
  if (objective) parts.push(`【任务目标】\n${objective}`);
  if (scope) parts.push(`【边界(必须遵守)】\n${scope}`);
  if (deliverable) parts.push(`【回传要求】\n${deliverable}`);
  if (context) parts.push(`【已知线索(子代理看不到父对话,这些是父对话提供的)】\n${context}`);
  if (prompt) parts.push(`【父对话补充说明】\n${prompt}`);
  return parts.join('\n\n');
}

/**
 * 跑一个子代理并**等它跑完**——前台一次性派发(工具层 `run_in_background: false` 走这里)。
 * 想不阻塞主会话请用 subagent-runtime 的 startSubagent(mode='continuable'),那是工具的默认路径。
 *
 * 抛错的情形:配置级失败(没有模型客户端 / 外部 provider / 提示词写不清)、父轮中止、
 * 以及子代理本轮以 error/stopped 收尾——与旧实现一致,工具层据此给出错误结果。
 * 工具级失败不在此列:单个工具失败会变成结构化错误结果交给子代理自己消化(绝不终结整轮)。
 */
export async function runSubagent(o: SubagentRunOptions): Promise<SubagentResult> {
  const { runId, settled } = startSubagent({ ...o, mode: 'one-shot' });
  const s = await settled;
  if (s.status !== 'done') throw new Error(s.note || (s.status === 'stopped' ? '已停止' : '子代理执行失败'));
  console.log(`[subagent] ${String(o.description || '').trim() || '(未命名)'} -> ${s.steps} 步 / ${s.toolCalls} 次工具调用 / ${s.ms}ms`);
  return {
    content: s.content, provider: s.provider, runId,
    steps: s.steps, toolCalls: s.toolCalls, ms: s.ms,
    promptTokens: s.promptTokens, completionTokens: s.completionTokens
  };
}

export type { SubagentSettlement };
