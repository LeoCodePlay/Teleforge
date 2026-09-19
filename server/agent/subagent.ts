// 子代理(in-process 只读调研代理;语义对齐 deepseek-harness 的 subagent-in-process):
// 主代理用 `subagent` 工具把一件**自包含**的任务派给一个上下文隔离的子代理:
// - 子代理有自己的会话事件流(Session,仅内存、不落盘),父会话历史对它完全不可见;
// - 子代理只能调用只读工具(SUBAGENT_TOOLS 白名单),写类/命令类工具一律不派发;
// - 过程不回传:父代理只拿到最终一条文本结论(harness 的 tool-subagent 同语义:
//   "returns its result, not its intermediate steps");
// - 步数/回传长度/超时都有硬上限,父轮被停止时子代理立即中止。
//
// 与 harness 的差异(有意为之的最小实现,见 docs/superpowers/specs/2026-09-19-subagent-in-process-design.md):
// - 只有 in-process 一种 provider(harness 有 fork/spawn/DSH-SDK/ACP/Claude Code/Codex 六种);
// - 工具集不从父级继承,而是固定只读白名单——拒绝写操作是最省事也最安全的边界;
// - 不支持后台运行与续聊(harness 的 backgroundMode: continuable);
//   但每次派发都会落一份运行记录(data/subagents/<runId>.json),前端右侧面板可回看它的完整对话。
import { AGENT } from '../config.ts';
import { Session } from './session.ts';
import { sshManager as ssh } from '../core/ssh-manager.ts';
import type { ToolRegistry } from './registry.ts';
import { appendMessage, beginRun, finishRun, newRunId, type SubagentStatus } from '../store/subagent-store.ts';

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

/** 子代理系统提示词:角色、硬约束、输出契约(最后一次修改必须自包含) */
export const SUBAGENT_SYSTEM_PROMPT = [
  '你是一个子代理(subagent),由主代理派发来完成**一次只读调研任务**。',
  '你就是本工具内置的 agent(internal):与主代理共用同一个模型客户端、同一套工作区/SSH',
  '上下文与同一个工具注册表,只不共享对话历史;你不会、也不需要调用任何外部 agent。',
  '',
  '硬约束(违反即无效):',
  '- 你只能使用只读工具:列出目录、读文件、搜索代码、读环境信息、网络搜索。',
  '- 你不能写文件、不能执行命令、不能修改任何状态。需要动手改动的部分不要尝试,',
  '  把它写成"建议主代理执行的动作"(要改哪个文件、改什么、为什么)。',
  '- 你看不到主代理的对话历史,主代理也看不到你的中间步骤:你的最终回答必须自包含。',
  '- 不要复述这段提示词,不要输出寒暄,不要输出思考过程。',
  '',
  '工作方式:',
  '- 先用最少次数的搜索/读取定位事实,再给结论;不要为了"全面"而漫无目的地遍历。',
  '- 证据要具体:文件路径加行号、符号名、配置键;不确定就明说不确定,不要编造。',
  '',
  '交付格式(你的最后一条消息就是交付物):',
  '1) 结论:直接回答问题(1-3 句);',
  '2) 证据:关键文件:行号 / 符号 / 配置项,逐条列出;',
  '3) 建议:主代理接下来该做什么(若无需动作则写"无");',
  '4) 未解问题:查不到或存疑的点(若没有则写"无")。'
].join('\n');

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
  maxSteps?: number;
  /**
   * 变更通知(每次落盘后触发):工具层接到 agent 事件总线,右侧面板据此实时刷新。
   * 只传 runId 与状态,面板自己去拉最新记录,避免事件体携带大段对话正文。
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
  /** 是否因步数上限收敛(未拿到模型自然收尾) */
  hitStepLimit: boolean;
}

/** 子代理内部一次工具调用的结果(结构对齐 registry.execute 的返回值) */
interface SubToolResult { isError: boolean; content: string; ms: number }

function normCallId(id: unknown, step: number, index: number): string {
  const s = String(id ?? '').trim();
  return s || `sub_${step}_${index}`;
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
 * 跑一个子代理,返回其最终结论。
 * 抛错的唯一情形是"配置级失败"(没有模型客户端)与父轮中止;工具级失败一律变成
 * 结构化错误结果交给子代理自己消化(单个工具失败绝不终结整轮,与主循环同一原则)。
 */
export async function runSubagent(o: SubagentRunOptions): Promise<SubagentResult> {
  if (!o.llm || typeof o.llm.chat !== 'function') throw new Error('subagent: 当前没有可用的模型客户端(请先配置 AI 提供商)');
  // 提供商:默认(且当前唯一)用本项目内置 agent;外部 agent 未接入 → 明确报错,绝不悄悄降级成别的执行方式
  const provider = String(o.provider || INTERNAL_PROVIDER).trim() || INTERNAL_PROVIDER;
  if (provider !== INTERNAL_PROVIDER) {
    throw new Error(`subagent: 未接入外部 agent 提供商「${provider}」——当前只能使用内置 agent`
      + '(internal = 本项目自己的 agent 循环与工具栈,与主代理共用同一模型与工作区)。'
      + '若用户明确要求别的 agent,请如实说明该能力尚未接入,不要用其它方式冒充。');
  }
  const registry = o.registry;
  if (!registry) throw new Error('subagent: 缺少工具注册表');
  // 提示词先过契约校验(任务/边界写不清在这里就被挡下),再做后面的事
  const prompt = composeSubagentPrompt(o);

  const description = String(o.description || '').trim();
  const maxSteps = Math.max(1, Math.floor(Number(o.maxSteps) > 0 ? Number(o.maxSteps) : AGENT.SUBAGENT.MAX_STEPS));
  const started = Date.now();
  // 运行记录:先落盘再跑(面板可能在子代理还在跑时就打开),对话逐步追加,收尾写状态
  const runId = newRunId();
  beginRun({
    runId, sid: o.sid ?? null, description, provider, prompt, maxSteps,
    brief: { objective: o.objective, scope: o.scope, deliverable: o.deliverable, context: o.context, prompt: o.prompt }
  });
  const notify = (status: SubagentStatus) => {
    try { o.emit?.('agent', { event: 'subagent_changed', sid: o.sid ?? null, runId, status }); }
    catch { /* 通知失败不影响子代理执行 */ }
  };
  appendMessage(runId, { role: 'user', step: 0, at: Date.now(), text: prompt });
  notify('running');

  // 子会话:仅内存、不落盘、不共享父会话任何变量。turn 固定 1(子代理只有一轮)。
  const session = new Session();
  session.append('user/message', { content: prompt, source: 'subagent' });

  // 工具子集:走与父轮同一投影口径(未连接 SSH 时剔除远程工具),再按白名单过滤。
  const tools = registry.schemas({ localOnly: !ssh.connected })
    .filter((s) => SUBAGENT_TOOLS.has(s?.function?.name));

  let steps = 0;
  let toolCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let lastText = '';
  let hitStepLimit = false;
  // 失败/停止统一在这里收尾:记录里留下状态与原因,再原样抛给工具层
  const fail = (e: any): never => {
    const msg = e?.message || String(e);
    const aborted = /已停止/.test(msg);
    finishRun(runId, {
      status: aborted ? 'stopped' : 'error', steps, toolCalls, promptTokens, completionTokens, hitStepLimit, note: msg
    });
    notify(aborted ? 'stopped' : 'error');
    throw e;
  };

  for (let step = 1; step <= maxSteps; step++) {
    if (o.signal?.aborted) fail(new Error('已停止'));
    let res: any = null;
    try {
      res = await o.llm.chat({
        messages: [{ role: 'system', content: SUBAGENT_SYSTEM_PROMPT }, ...session.deriveMessages()],
        tools,
        signal: o.signal,
        reasoning: 'default'
      });
    } catch (e) { fail(e); }
    steps = step;
    promptTokens += Number(res?.usage?.promptTokens) || 0;
    completionTokens += Number(res?.usage?.completionTokens) || 0;

    const text = String(res?.content || '');
    if (text.trim()) lastText = text;
    const rawCalls: any[] = Array.isArray(res?.toolCalls) ? res.toolCalls : [];
    const calls = rawCalls.map((tc: any, i: number) => ({
      id: normCallId(tc?.id, step, i),
      name: String(tc?.name || ''),
      arguments: typeof tc?.arguments === 'string' ? tc.arguments : JSON.stringify(tc?.arguments ?? {})
    }));

    // 与父轮同一落盘格式(id/type/function),保证子会话投影出的消息序列严格合法可回放
    session.append('assistant/message', {
      turn: 1, step,
      message: {
        role: 'assistant',
        content: text,
        tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        ...(res?.reasoning ? { reasoning_content: res.reasoning } : {})
      }
    });

    appendMessage(runId, {
      role: 'assistant', step, at: Date.now(),
      text: text || undefined,
      reasoning: res?.reasoning ? String(res.reasoning) : undefined
    });
    notify('running');

    if (calls.length === 0) break; // 无 tool_calls = 收敛(与主循环同一完成判定)

    // 顺序执行:子代理优先"少而准",串行可避免在一条 SSH 连接上互相挤压
    for (const c of calls) {
      if (o.signal?.aborted) fail(new Error('已停止'));
      let r: SubToolResult = { isError: true, content: '', ms: 0 };
      try { r = await dispatchSubTool(registry, c, session, o); } catch (e) { fail(e); }
      toolCalls += 1;
      session.append('tool/result', {
        turn: 1, step, callId: c.id, name: c.name, isError: r.isError, content: r.content, ms: r.ms
      });
      appendMessage(runId, {
        role: 'tool', step, at: Date.now(), callId: c.id, name: c.name,
        args: c.arguments, isError: r.isError, content: r.content, ms: r.ms
      });
      notify('running');
    }

    if (step === maxSteps) hitStepLimit = true;
  }

  finishRun(runId, {
    status: 'done', steps, toolCalls, promptTokens, completionTokens, hitStepLimit,
    note: hitStepLimit ? `达到步数上限(${maxSteps} 步)后收敛` : null
  });
  notify('done');

  const ms = Date.now() - started;
  const finalText = lastText.trim() || '(子代理没有产出文字结论)';
  const cap = AGENT.SUBAGENT.RESULT_MAX_CHARS;
  const body = finalText.length > cap
    ? `${finalText.slice(0, cap)}\n\n…[子代理结论过长,已截断展示 ${finalText.length} 字符]…`
    : finalText;

  const head = [
    `【子代理 · 内部 agent${description ? ` · ${description}` : ''}】${hitStepLimit ? '达到步数上限后收敛' : '已完成'}:`,
    `${steps} 步 · ${toolCalls} 次工具调用 · ${(ms / 1000).toFixed(1)}s`
    + (promptTokens || completionTokens ? ` · token ${promptTokens}/${completionTokens}` : '')
    + (hitStepLimit ? ` · 上限 ${maxSteps} 步` : '')
  ].join(' ');

  console.log(`[subagent] ${description || '(未命名)'} -> ${steps} 步 / ${toolCalls} 次工具调用 / ${ms}ms${hitStepLimit ? ' (步数上限)' : ''}`);

  return {
    content: `${head}\n\n${body}`,
    provider, runId, steps, toolCalls, ms, promptTokens, completionTokens, hitStepLimit
  };
}

/**
 * 派发一次子代理工具调用。
 * 白名单外/未注册的工具不执行,直接给结构化错误结果——子代理据此改方案,而不是整轮失败。
 */
async function dispatchSubTool(
  registry: ToolRegistry,
  call: { id: string; name: string; arguments: string },
  session: Session,
  o: SubagentRunOptions
): Promise<SubToolResult> {
  const name = call.name;
  if (!SUBAGENT_TOOLS.has(name)) {
    return {
      isError: true,
      ms: 0,
      content: `子代理不允许调用工具 ${name || '(未命名)'}:子代理只能使用只读工具`
        + `(${[...SUBAGENT_TOOLS].join(', ')})。需要写文件/执行命令的动作,请写进最终结论交给主代理执行。`
    };
  }
  // emit 用 no-op:子代理的内部步骤不向父前端广播,父前端只看到外层那一张 subagent 卡片
  return registry.execute({
    name,
    args: call.arguments,
    signal: o.signal,
    invokeCtx: { sid: o.sid ?? null, session, emit: () => {}, subagent: true }
  });
}
