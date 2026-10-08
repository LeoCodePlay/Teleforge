// 常驻子代理运行时 —— 对齐 deepseek-harness 的 **continuable subagent / Activation** 语义。
//
// 为什么需要它(与旧的"一次性同步派发"的差别,全是用户可见行为):
//   1) **派发不阻塞主会话**:后台派发只把子代理挂成常驻 Activation 就立刻返回
//      `started subagent <runId>`,父代理这一步当场结束、继续干自己的活(harness 的
//      continuable 默认就是后台:`background-first continuable delegation`);
//   2) **可续聊**:子代理的 Session 常驻内存(session 事件日志 = 它的完整对话),
//      父代理(Send_message 工具)或人类(前端输入框 / subagent_prompt RPC)随时可以再发消息,
//      空闲就开新轮,正在跑就在最近的一步边界被认领(steer);
//   3) **可暂停**:interrupt 只停"当前这一轮",排队消息保留、Activation 不销毁,
//      下一条消息就能把它唤醒继续(harness:`Agent.cancel(cause, { keepInbox: true })`);
//   4) **结算通知**:一轮跑完、收件箱空了(Activation settle)时,把"这次结束成什么样 + 最后结论"
//      作为一条消息投递给父会话,父会话空闲就被唤醒开一轮 —— 所以后台子代理的结果照样回得来,
//      而不是让父代理干等(harness 的 settlement notice)。
//
// 与 harness 的差距(有意保留的项目边界,不要按 harness 的六种 provider 去想象):
//   - 只有 in-process 一种 provider(internal):同一个模型客户端、同一套 SSH/工作区绑定;
//   - 子代理工具集是固定只读白名单(SUBAGENT_TOOLS),不能写文件/执行命令——
//     需要动的手由它在结论里写给主代理;
//   - 子代理不能派孙代理(白名单不含 subagent/send_message/interrupt_agent/list_agents);
//   - 进程重启后常驻 Activation 消失:磁盘上仍能回看完整对话,但不能再续聊(如实报错,不假装)。
import { AGENT } from '../config.ts';
import { Session, foldSessionStats, foldTokenUsage, type MessageSource } from './session.ts';
import { sshManager as ssh, runWithWorkspaceBinding } from '../core/ssh-manager.ts';
import { runWithLocalWorkspaceBinding } from '../core/local-fs.ts';
import type { ToolRegistry } from './registry.ts';
import { appendMessage, beginRun, finishRun, get as getRun, newRunId, updateRun, type SubagentRun } from '../store/subagent-store.ts';
import { billedInputTokens } from './llm.ts';
import { INTERNAL_PROVIDER, SUBAGENT_SYSTEM_PROMPT, SUBAGENT_TOOLS, composeSubagentPrompt } from './subagent.ts';

/** 派发方式:one-shot = 旧的前台一次性(等结果);continuable = 常驻后台(默认,不阻塞) */
export type ChildMode = 'one-shot' | 'continuable';
/** 消息投递方式:queue = 排在当前轮之后的下一轮;steer = 最近一步边界就被认领 */
export type Delivery = 'queue' | 'steer';

/**
 * 队列里的一项(等执行的一轮)。
 * 内容在这里带着而不是立刻写进会话:与父会话同一口径 —— 排队时只出现在「待执行队列」面板里,
 * 真正开轮时才落成一条 user/message(steer 进轮内认领的除外,它已经在会话里了)。
 */
interface QueuedTurn {
  id: number;
  at: number;
  /** 投进模型上下文的正文(主代理发的带署名分帧) */
  content: string;
  /** 显示给用户的原文 */
  display: string;
  source: 'brief' | 'parent' | 'human';
  /** 已经写进会话(轮内 steer 认领),开轮时不要再写一遍 */
  steered?: boolean;
}

/**
 * 子代理执行时套用的作用域:与派发它的父会话一致(同一台服务器的连接、同一套远程/本地工作区绑定)。
 * 不套的话,父会话切到别的服务器后子代理的只读工具会打到另一台机器上 —— 结论就错了。
 */
export interface ChildBinding {
  conn: any;
  workspace: string | null;
  localWorkspace: string | null;
}

interface Child {
  runId: string;
  mode: ChildMode;
  parentSid: string | null;
  description: string;
  provider: string;
  /** 子代理自己的会话事件日志(内存;完整对话只在这里) */
  session: Session;
  llm: any;
  registry: ToolRegistry;
  emit?: (event: string, payload: any) => void;
  /** 结算通知的投递口(由工具层注入:父会话空闲会被唤醒,忙则排队) */
  notifyParent?: (text: string, source?: MessageSource) => void;
  /** 待执行轮次(FIFO;interrupt 时原样保留) */
  inbox: QueuedTurn[];
  /** 已写进 session、等下一步认领的 steer 消息条数 */
  steerPending: number;
  /** 活跃时长折叠状态(见 timingOf:只累计真正在跑的回合,闲置不计) */
  timing?: ChildTiming;
  busy: boolean;
  signal: AbortController | null;
  draining: Promise<void> | null;
  disposed: boolean;
  steps: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  lastText: string;
  /** 最近一次停止原因(interrupt / 父轮停止);下一轮开跑时清空 */
  stopReason: string | null;
  startedAt: number;
  /** 第一次结算(前台一次性派发 await 它;后台派发没人等) */
  settled: Promise<SubagentSettlement>;
  resolveSettled: (s: SubagentSettlement) => void;
  firstSettled: boolean;
  /** 父轮 AbortSignal 的清理(仅一次性派发会挂) */
  detachAbort: (() => void) | null;
  /** 执行作用域(父会话的连接/工作区;冷恢复时重新捕获) */
  binding: ChildBinding | null;
}

/** 一次派发/一个 Activation epoch 的终局(前台一次性派发就是它的返回值) */
export interface SubagentSettlement {
  runId: string;
  provider: string;
  status: 'done' | 'error' | 'stopped';
  content: string;
  steps: number;
  toolCalls: number;
  ms: number;
  promptTokens: number;
  completionTokens: number;
  note: string | null;
}

export interface StartSubagentOptions {
  llm: any;
  registry: ToolRegistry;
  prompt?: string;
  objective?: string;
  scope?: string;
  deliverable?: string;
  context?: string;
  description?: string;
  provider?: string;
  sid?: string | null;
  /** 只对一次性派发(前台)有意义:父轮停止即停止子代理。后台派发不受父轮停止约束。 */
  signal?: AbortSignal;
  emit?: (event: string, payload: any) => void;
  notifyParent?: (text: string, source?: MessageSource) => void;
  /** 派发方式,缺省 continuable(后台、不阻塞、可续聊) */
  mode?: ChildMode;
  /** 执行作用域(父会话的连接/工作区):不传就按"当前活动连接"执行 */
  binding?: ChildBinding | null;
}

const children = new Map<string, Child>();
let queueSeq = 0;

/** 常驻子代理(内存里的 Activation)数量:测试/诊断用 */
export function residentCount(): number { return children.size; }

/** 该 id 是否还有常驻 Activation(能续聊/暂停) */
export function isResident(runId: string): boolean { return children.has(String(runId || '')); }

/** 常驻子代理快照(父会话面板/工具列表按 sid 过滤用) */
export function listResident(parentSid?: string | null): Array<{
  runId: string; parentSid: string | null; description: string; mode: ChildMode; running: boolean; queued: number;
}> {
  const want = parentSid ? String(parentSid) : null;
  return [...children.values()]
    .filter((c) => (want ? c.parentSid === want : true))
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((c) => ({
      runId: c.runId, parentSid: c.parentSid, description: c.description,
      mode: c.mode, running: c.busy, queued: c.inbox.length + c.steerPending
    }));
}

function notify(c: Child) {
  const status = c.busy ? 'running' : 'idle';
  try {
    // 两条事件:status 给"把子会话当会话渲染"的对话前端(与父会话同一协议),
    // subagent_changed 给父会话头部的子智能体 catalog(只带 runId/状态,正文按需另拉)
    c.emit?.('agent', { event: 'status', sid: c.runId, status });
    c.emit?.('agent', { event: 'subagent_changed', sid: c.parentSid, runId: c.runId, status });
  } catch { /* 通知失败不影响子代理执行 */ }
}

/** 队列快照:与父会话 queueSnapshot 同一形状({id, text, attach}),前端同一个「待执行」面板直接渲染 */
export function childQueueSnapshot(runId: string): Array<{ id: number; text: string; attach: number }> {
  const c = children.get(String(runId || ''));
  if (!c) return [];
  return c.inbox.map((q) => ({ id: q.id, text: q.display, attach: 0 }));
}

function emitQueue(c: Child) {
  try { c.emit?.('agent', { event: 'queue_update', sid: c.runId, queue: childQueueSnapshot(c.runId) }); }
  catch { /* 忽略 */ }
}

/** 把当前状态写进运行记录(每一步落一次,面板/前端据此实时刷新) */
function publish(c: Child, status: 'running' | 'idle') {
  updateRun(c.runId, {
    status,
    steps: c.steps,
    toolCalls: c.toolCalls,
    promptTokens: c.promptTokens,
    completionTokens: c.completionTokens,
    queued: c.inbox.length + c.steerPending,
    // 活跃时长投影:只累计**真正在跑**的回合,闲置时间不计(见 foldTiming)
    ...timingOf(c)
  });
}

/** 计时折叠状态(逐字对齐 dsh 的 TimingState,省掉它处理"种子日志"的 descriptor 部分) */
interface ChildTiming {
  /** 已完成回合的耗时累加(ms) */
  settledMs: number;
  /** 当前开着的那一轮的起点;没有开着的轮 = null */
  activeSince: number | null;
  /** 开着的这一轮内最后一个事件的时间(前端只在"还在跑"时用它兜底) */
  activeThrough: number | null;
  /** 最近一次关闭的轮是否正常完成(前端据此显示「已完成」/「当前未运行」) */
  lastTurnCompleted: boolean | null;
  /** 已经折进状态的事件条数(增量折叠用;事件日志是 append-only) */
  at: number;
}

/**
 * 子代理的**活跃时长**投影 —— 逐字照搬 dsh 的 subagentTiming
 * (packages/subagent/subagent/src/projection.ts,规格见它的 timing-projection.spec.ts):
 *
 *   - `settledMs`:已完成回合的耗时**累加** —— 只算 turn/start → turn/end 那段,
 *     中间的闲置时间(等消息、面板开着放那儿)一律不计;
 *   - `active`:当前开着的那一轮(有它 = 这一轮还在跑,前端才让计时器继续走);
 *   - `lastTurnCompleted`:最近一次关闭的轮是不是正常结束 —— 前端据此把这一行显示成
 *     「已完成」而不是「当前未运行」。
 *
 * 为什么必须这样:曾经用 `now - startedAt` 当"执行时间",于是常驻子代理跑完停在那儿时,
 * 那一行明明写着「当前未运行」,时间却一直涨(用户报的就是这个)。
 *
 * 增量折叠:事件日志 append-only,子会话被冷恢复重建时才从头折一次。
 */
function foldTimingStep(st: ChildTiming, ev: { type: string; time?: number; data?: any }): ChildTiming {
  if (ev.type === 'turn/start') {
    const at = Number(ev.time) || 0;
    return { ...st, activeSince: at, activeThrough: at, lastTurnCompleted: null };
  }
  if (ev.type === 'turn/end') {
    const end = Number(ev.time) || 0;
    return {
      ...st,
      settledMs: st.settledMs + (st.activeSince === null ? 0 : Math.max(0, end - st.activeSince)),
      activeSince: null,
      activeThrough: null,
      lastTurnCompleted: String(ev.data?.reason?.kind || '') === 'completed'
    };
  }
  if (st.activeSince === null) return st;
  return { ...st, activeThrough: Number(ev.time) || st.activeThrough };
}

function timingOf(c: Child) {
  let st: ChildTiming = c.timing && c.timing.at <= c.session.events.length
    ? c.timing
    : { settledMs: 0, activeSince: null, activeThrough: null, lastTurnCompleted: null, at: 0 };
  for (let i = st.at; i < c.session.events.length; i++) st = foldTimingStep(st, c.session.events[i]);
  c.timing = { ...st, at: c.session.events.length };
  return {
    settledMs: st.settledMs,
    activeSince: st.activeSince,
    activeThrough: st.activeThrough,
    lastTurnCompleted: st.lastTurnCompleted
  };
}

function isAbort(e: any): boolean {
  const msg = String(e?.message || e || '');
  return e?.name === 'AbortError' || /已停止|aborted|abort/i.test(msg);
}

/** 收尾成终局状态(一次性派发);状态落盘 + resolve 第一次结算 + 从常驻表摘除 */
function finish(c: Child, status: 'done' | 'error' | 'stopped', note: string | null) {
  c.disposed = true;
  children.delete(c.runId);
  finishRun(c.runId, {
    status, steps: c.steps, toolCalls: c.toolCalls,
    promptTokens: c.promptTokens, completionTokens: c.completionTokens, note
  });
  notify(c);
  resolveSettledOnce(c, {
    runId: c.runId, provider: c.provider, status,
    content: settlementText(c), steps: c.steps, toolCalls: c.toolCalls,
    ms: Date.now() - c.startedAt, promptTokens: c.promptTokens, completionTokens: c.completionTokens, note
  });
  c.detachAbort?.();
}

function resolveSettledOnce(c: Child, s: SubagentSettlement) {
  if (c.firstSettled) return;
  c.firstSettled = true;
  try { c.resolveSettled(s); } catch { /* 没有等待者(后台派发) */ }
}

/** 结论正文:最后一次非空 assistant 文本,超长截断(与旧口径一致) */
function settlementText(c: Child): string {
  const finalText = c.lastText.trim() || '(子代理没有产出文字结论)';
  const cap = AGENT.SUBAGENT.RESULT_MAX_CHARS;
  return finalText.length > cap
    ? `${finalText.slice(0, cap)}\n\n…[子代理结论过长,已截断展示 ${finalText.length} 字符]…`
    : finalText;
}

/**
 * 结算通知的**一句话账**(逐条对齐 dsh 的 settlementSummary):
 * 父代理看到的第一行就该是"这个后台子代理现在什么状态、还会不会自己干活",
 * 而不是一行内部术语或它的长结论。
 */
function settlementSummary(runId: string, status: 'done' | 'error' | 'stopped'): string {
  const subject = `后台子代理 ${runId}`;
  switch (status) {
    case 'done':
      return `${subject} 已完成;除非你再给它发消息,它不会再做任何事。`;
    case 'stopped':
      return `${subject} 在完成前被停止。`;
    case 'error':
      return `${subject} 在完成前失败了。`;
    default:
      return `${subject} 异常结束(${String(status)})且未完成。`;
  }
}

/**
 * 结算通知 —— harness 的 settlement notice:一轮跑完、收件箱空了就投递给父会话。
 * 只投一次(每个"跑→空闲"的转换一次),父会话空闲会被唤醒开一轮,忙就排队;
 * 投递失败绝不反过来打断子代理(与 harness 的 observe-only 事件同一取向)。
 *
 * 形态**逐字对齐 dsh 的 createSettlementMessage**(见 packages/subagent/subagent/src/
 * continuation-messages.ts):
 *   - 正文 = 一句话账 + 「Its closing message:」+ 子代理的收尾文字(没有则写明"没留收尾消息");
 *   - source = { kind:'subagent-settled', form:'notice', summary, senderSessionId } ——
 *     `form:'notice'` 是**渲染契约**:前端把它画成"触发这一轮的通知行"(标题 + 时间 + 展开看正文),
 *     而不是一条用户气泡;`summary` 是折叠行上的一行账。
 * dsh 的通知正文里**不带**"还能用 send_message 继续派活"这种补充说明 —— 那句话在子代理的
 * 初始任务指引里(withContinuableReturnGuidance),通知只陈述"它现在什么状态"。
 */
function deliverNotice(c: Child, status: 'done' | 'error' | 'stopped', note: string | null) {
  if (!c.notifyParent) return;
  const cap = AGENT.SUBAGENT.NOTICE_MAX_CHARS;
  const summary = settlementSummary(c.runId, status);
  const closing = status === 'done' && !c.lastText.trim() ? '' : settlementText(c);
  let text = `${summary}${note ? `(${note})` : ''}\n\n`
    + (closing ? `它的收尾消息:\n${closing}` : '它没有留下任何收尾消息。');
  if (text.length > cap) text = `${text.slice(0, cap)}\n…[通知过长,已截断]…`;
  try {
    c.notifyParent(text, {
      kind: 'subagent-settled',
      form: 'notice',
      summary,
      senderSessionId: c.runId
    });
  } catch { /* 投递失败不影响子代理 */ }
}

/**
 * 派发一个子代理。
 * - `mode: 'continuable'`(缺省):挂成常驻 Activation 后**立即返回**,不阻塞当前这一步;
 * - `mode: 'one-shot'`:与旧行为一致——返回的 `settled` 要等第一次跑完才有结果(前台)。
 * 抛错只发生在"配置级失败"(没有模型客户端 / provider 未接入 / 提示词写不清),
 * 一律发生在落盘建记录之前(不留空壳记录)。
 */
export function startSubagent(o: StartSubagentOptions): { runId: string; settled: Promise<SubagentSettlement> } {
  if (!o.llm || typeof o.llm.chat !== 'function') throw new Error('subagent: 当前没有可用的模型客户端(请先配置 AI 提供商)');
  const provider = String(o.provider || INTERNAL_PROVIDER).trim() || INTERNAL_PROVIDER;
  if (provider !== INTERNAL_PROVIDER) {
    throw new Error(`subagent: 未接入外部 agent 提供商「${provider}」——当前只能使用内置 agent`
      + '(internal = 本项目自己的 agent 循环与工具栈,与主代理共用同一模型与工作区)。'
      + '若用户明确要求别的 agent,请如实说明该能力尚未接入,不要用其它方式冒充。');
  }
  const registry = o.registry;
  if (!registry) throw new Error('subagent: 缺少工具注册表');
  // 提示词先过契约校验(任务/边界写不清在这里就被挡下),再做后面的事:不留空壳记录
  const prompt = composeSubagentPrompt(o);

  const mode: ChildMode = o.mode === 'one-shot' ? 'one-shot' : 'continuable';
  const description = String(o.description || '').trim();
  const runId = newRunId();
  beginRun({
    runId, sid: o.sid ?? null, description, provider, prompt, mode,
    brief: { objective: o.objective, scope: o.scope, deliverable: o.deliverable, context: o.context, prompt: o.prompt }
  });
  appendMessage(runId, { role: 'user', step: 0, at: Date.now(), text: prompt, from: 'brief' });

  // 子会话:仅内存、不落盘、不共享父会话任何变量(上下文隔离的第一道保证)。
  // 初始任务与后续消息都先排队,真正开轮时才落成 user/message + 广播 start(与父会话同一口径)。
  const session = new Session();

  let resolveSettled: (s: SubagentSettlement) => void = () => {};
  const settled = new Promise<SubagentSettlement>((res) => { resolveSettled = res; });

  const child: Child = {
    runId, mode, parentSid: o.sid ?? null, description, provider,
    session, llm: o.llm, registry, emit: o.emit, notifyParent: o.notifyParent,
    inbox: [], steerPending: 0,
    busy: false, signal: null, draining: null, disposed: false,
    steps: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, lastText: '',
    stopReason: null, startedAt: Date.now(),
    settled, resolveSettled, firstSettled: false, detachAbort: null,
    binding: o.binding ?? null
  };
  children.set(runId, child);

  // 一次性派发:父轮中止 = 子代理立即停止(与旧行为一致);后台派发不受父轮停止约束
  if (mode === 'one-shot' && o.signal) {
    const onAbort = () => { interruptChild(runId, '已停止'); };
    if (o.signal.aborted) onAbort();
    else {
      o.signal.addEventListener('abort', onAbort, { once: true });
      child.detachAbort = () => { try { o.signal?.removeEventListener('abort', onAbort); } catch { /* 忽略 */ } };
    }
  }

  child.inbox.push({ id: ++queueSeq, at: Date.now(), content: prompt, display: prompt, source: 'brief' });
  publish(child, 'running');
  notify(child);
  emitQueue(child);
  kick(child);
  return { runId, settled };
}

/** 唤醒 driver:同一时刻只有一个 driver 在跑;收件箱里的每一条 = 一轮 */
function kick(child: Child) {
  if (child.disposed || child.busy) return;
  if (child.inbox.length === 0) return;
  if (child.draining) return;
  const p = drive(child).finally(() => { child.draining = null; });
  child.draining = p;
  void p.catch(() => { /* drive 内部已消化;这里只防止未处理的 Promise 拒绝 */ });
}

/** driver 主循环:逐条消费收件箱,每条跑完整的一轮(Turn) */
async function drive(child: Child) {
  child.busy = true;
  publish(child, 'running');
  notify(child);
  let fatal: { status: 'error' | 'stopped'; note: string } | null = null;
  try {
    while (!child.disposed && child.inbox.length > 0) {
      const item = child.inbox.shift()!;
      emitQueue(child);
      try {
        // 已被要求停止(interrupt / 父轮停止)而还没开跑:这一轮直接按中止处理,
        // 而不是清掉停止意图照跑 —— 否则"暂停"会在队列里悄悄失效。
        if (child.stopReason) throw new Error(child.stopReason);
        await runOneTurn(child, item);
      } catch (e: any) {
        const note = String(e?.message || e || '未知错误');
        if (isAbort(e)) {
          // 停止只停当前轮:后台子代理保留排队(下一条消息继续);一次性派发到此终结
          if (child.mode === 'one-shot') fatal = { status: 'stopped', note };
          else { child.stopReason = note; }
        } else {
          fatal = { status: 'error', note };
        }
        break;
      }
    }
  } finally {
    child.busy = false;
    child.signal = null;
    if (fatal) {
      publishTerminal(child, fatal.status, fatal.note);
      finish(child, fatal.status, fatal.note);
      deliverNotice(child, fatal.status, fatal.note);
    } else if (child.mode === 'one-shot') {
      publishTerminal(child, 'done', null);
      finish(child, 'done', null);
    } else {
      // continuable:Activation 常驻,停在"当前未运行";父会话收到一条结算通知
      const parked = child.stopReason;
      updateRun(child.runId, {
        status: 'idle', steps: child.steps, toolCalls: child.toolCalls,
        promptTokens: child.promptTokens, completionTokens: child.completionTokens,
        queued: child.inbox.length, note: parked,
        // 活跃时长:这一轮跑完了就定住(闲置时间不计,见 foldTiming)
        ...timingOf(child)
      });
      notify(child);
      deliverNotice(child, parked ? 'stopped' : 'done', parked);
      resolveSettledOnce(child, {
        runId: child.runId, provider: child.provider, status: parked ? 'stopped' : 'done',
        content: settlementText(child), steps: child.steps, toolCalls: child.toolCalls,
        ms: Date.now() - child.startedAt, promptTokens: child.promptTokens, completionTokens: child.completionTokens,
        note: parked
      });
    }
  }
}

function publishTerminal(child: Child, status: 'done' | 'error' | 'stopped', note: string | null) {
  updateRun(child.runId, {
    status, steps: child.steps, toolCalls: child.toolCalls,
    promptTokens: child.promptTokens, completionTokens: child.completionTokens, note,
    ...timingOf(child)
  });
}

/**
 * 一轮(Turn):模型请求 → 工具调用 → … → 模型不再发起工具调用为止。
 * 与主循环同一完成判定;每个模型请求都重新投影子会话,所以轮中途 steer 进来的消息
 * 会在最近的一步边界被认领(harness:`inbox.claimed` 的 best-effort 最近一步语义)。
 */
async function runOneTurn(child: Child, item: QueuedTurn) {
  const sid = child.runId;
  const emit = (payload: any) => {
    try { child.emit?.('agent', { sid, ...payload }); } catch { /* 广播失败不影响执行 */ }
  };
  const signal = child.signal = new AbortController();
  const b = child.binding;
  // 工具子集:走与父轮同一投影口径(未连接 SSH 时剔除远程工具),再按白名单过滤。
  // 有绑定时以"绑定的连接在不在"为准 —— 子代理跟着派发它的父会话走。
  const tools = child.registry.schemas({ localOnly: !(b ? !!b.conn : ssh.connected) })
    .filter((s) => SUBAGENT_TOOLS.has(s?.function?.name));

  const turn = child.session.nextTurn();
  let reason: 'completed' | 'aborted' | 'error' = 'completed';
  child.session.append('turn/start', { turn });
  // 一轮一开就落一次进度:活跃时长口径里的 `active` 就是这一轮的起点,前端据此走计时器
  // (否则"第一步的模型请求还在跑"这段时间里,记录里没有开着的轮 → 时长会停着不动)
  publish(child, 'running');
  try {
    // 排队时只进队列面板;真正开轮时才落成会话里的 user 消息(与父会话同一口径)
    if (!item.steered) child.session.append('user/message', { content: item.content, source: item.source });
    emit({ event: 'start', text: item.display });

  for (let step = 1; ; step++) {
    if (signal.signal.aborted) throw new Error('已停止');
    child.steerPending = 0;
    child.session.append('step/start', { turn, step });
    emit({ event: 'iteration', iter: step });
    let firstTokenTime: number | undefined;
    const res = await child.llm.chat({
      messages: [{ role: 'system', content: SUBAGENT_SYSTEM_PROMPT }, ...child.session.deriveMessages()],
      tools,
      signal: signal.signal,
      reasoning: 'default',
      // 与父会话同款流式:增量按 text / reasoning 两条通道广播
      onDelta: (d: any) => {
        if (!firstTokenTime) firstTokenTime = Date.now();
        const t = String(d?.text || '');
        if (d?.kind === 'reasoning') emit({ event: 'reasoning_delta', text: t });
        else emit({ event: 'text_delta', text: t });
      }
    });
    child.steps += 1;
    const u = res?.usage;
    if (u) {
      child.promptTokens += billedInputTokens(u);
      child.completionTokens += u.outputTokens;
    }

    const text = String(res?.content || '');
    if (text.trim()) child.lastText = text;
    const rawCalls: any[] = Array.isArray(res?.toolCalls) ? res.toolCalls : [];
    const calls = rawCalls.map((tc: any, i: number) => ({
      id: normCallId(tc?.id, child.steps, i),
      name: String(tc?.name || ''),
      arguments: typeof tc?.arguments === 'string' ? tc.arguments : JSON.stringify(tc?.arguments ?? {})
    }));

    // 与父轮同一落盘格式(id/type/function/usage),保证子会话投影出的消息序列严格合法可回放
    child.session.append('assistant/message', {
      turn, step,
      message: {
        role: 'assistant',
        content: text,
        tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        ...(res?.reasoning ? { reasoning_content: res.reasoning } : {})
      },
      ...(u ? { usage: u } : {}),
      ...(firstTokenTime ? { firstTokenTime } : {})
    });
    appendMessage(child.runId, {
      role: 'assistant', step, at: Date.now(),
      text: text || undefined,
      reasoning: res?.reasoning ? String(res.reasoning) : undefined
    });
    publish(child, 'running');
    notify(child);

    if (calls.length === 0) {
      // 收敛判定:模型不再发起工具调用 —— 除非轮中途还有 steer 消息没被认领(那要再走一步)
      child.session.append('step/end', { turn, step });
      if (child.steerPending > 0) continue;
      break;
    }

    // 顺序执行:子代理优先"少而准",串行可避免在一条 SSH 连接上互相挤压
    for (const c of calls) {
      if (signal.signal.aborted) throw new Error('已停止');
      // 工具调用事件先落盘:projectEvents 只投影"有前置 tool/call 的结果"
      child.session.append('tool/call', { turn, step, callId: c.id, name: c.name, arguments: c.arguments });
      emit({ event: 'tool_call', callId: c.id, tool: c.name, args: c.arguments });
      const r: any = await dispatchSubTool(child, c, signal.signal);
      child.toolCalls += 1;
      child.session.append('tool/result', {
        turn, step, callId: c.id, name: c.name, isError: r.isError, content: r.content, ms: r.ms,
        ...(r.meta !== undefined ? { meta: r.meta } : {}),
        ...(Array.isArray(r.attachments) && r.attachments.length ? { attachments: r.attachments } : {})
      });
      appendMessage(child.runId, {
        role: 'tool', step, at: Date.now(), callId: c.id, name: c.name,
        args: c.arguments, isError: r.isError, content: r.content, ms: r.ms
      });
      emit({
        event: 'tool_result', callId: c.id, tool: c.name, ok: !r.isError, ms: r.ms, result: r.content,
        ...(r.meta !== undefined ? { meta: r.meta } : {}),
        ...(Array.isArray(r.attachments) && r.attachments.length ? { attachments: r.attachments } : {})
      });
      publish(child, 'running');
      notify(child);
    }
    child.session.append('step/end', { turn, step });
  }
  } catch (e: any) {
    reason = isAbort(e) ? 'aborted' : 'error';
    throw e;
  } finally {
    child.session.append('turn/end', { turn, reason: { kind: reason } });
    // 与父会话同一收尾事件:前端据此收尾折叠行、流式态与文件变更卡
    if (reason === 'completed') emit({ event: 'done', text: child.lastText });
    else if (reason === 'aborted') emit({ event: 'stopped' });
    else emit({ event: 'error', message: String(child.stopReason || '子代理执行失败') });
    try {
      child.emit?.('agent', {
        event: 'session_stats',
        sid,
        usage: foldTokenUsage(child.session.events),
        stats: foldSessionStats(child.session.events)
      });
    } catch { /* 统计只是展示 */ }
  }
}

/**
 * 派发一次子代理工具调用。
 * 白名单外/未注册的工具不执行,直接给结构化错误结果——子代理据此改方案,而不是整轮失败。
 */
async function dispatchSubTool(
  child: Child,
  call: { id: string; name: string; arguments: string },
  signal: AbortSignal
): Promise<{ isError: boolean; content: string; ms: number; meta?: any; attachments?: any[] }> {
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
  const exec = () => child.registry.execute({
    name,
    args: call.arguments,
    signal,
    invokeCtx: { sid: child.parentSid, session: child.session, emit: () => {}, subagent: true }
  });
  // 执行时套上派发时捕获的作用域(父会话的连接 + 远程/本地工作区):父会话切到别的服务器后,
  // 子代理的只读工具也必须打在原来那台机器上,否则结论就是另一台机器的。
  const b = child.binding;
  if (!b) return exec();
  return ssh.runWithConn(b.conn, () =>
    runWithWorkspaceBinding(b.workspace, () =>
      runWithLocalWorkspaceBinding(b.localWorkspace, exec)));
}

function normCallId(id: unknown, step: number, index: number): string {
  const s = String(id ?? '').trim();
  return s || `sub_${step}_${index}`;
}

/**
 * 给子代理发一条后续消息(父代理的 send_message 工具 / 人类的前端输入框都走这里)。
 * - delivery='queue':排在当前轮之后的下一轮(FIFO,人类输入的默认);
 * - delivery='steer':正在跑就投到最近的一步边界被认领,空闲就直接开一轮(模型的默认)。
 * 只做"入队/投递"的受理:子代理的回复不会从这里返回(harness:acceptance only)。
 *
 * 常驻 Activation 已经不在(服务重启过 / 这条记录来自上一次运行)时,只要给了 `resume`
 * 依赖就走**冷恢复**(harness 的 `no Activation → cold-resume a new Activation`):
 * 用磁盘上的运行记录把子会话重建出来,再收下这条消息 —— 所以"父会话不在线"从来不是
 * 不能发消息的理由,一次性派发才是。
 */
export function sendMessage(
  runId: string,
  text: string,
  opts: { from?: 'parent' | 'human'; delivery?: Delivery; resume?: ResumeDeps } = {}
): { runId: string; queued: number; delivered: boolean; resumed: boolean } {
  const id = String(runId || '');
  let child = children.get(id);
  let resumed = false;
  if (!child) {
    const rec = getRun(id);
    if (!rec) {
      throw new Error(`子代理 ${id} 不存在:id 写错了,或它的运行记录已被保留策略清掉。可以先用 list_agents 看现在还有哪些。`);
    }
    if ((rec.mode ?? 'continuable') === 'one-shot') {
      throw new Error(`子代理 ${id} 是一次性派发,不接受后续消息(它的完整过程仍可在面板回看)。`);
    }
    const deps = opts.resume;
    if (!deps?.llm || typeof deps.llm.chat !== 'function' || !deps.registry) {
      throw new Error(`子代理 ${id} 当前不在内存中(服务重启过),需要可用的模型客户端才能从运行记录里恢复它;`
        + '请先在设置里配置 AI 提供商,再发这条消息。');
    }
    child = coldResume(rec, deps);
    resumed = true;
  }
  if (child.mode !== 'continuable') throw new Error(`子代理 ${id} 是一次性派发,不接受后续消息(它的完整过程仍可在面板回看)。`);
  const body = String(text ?? '').trim();
  if (!body) throw new Error('消息内容为空,未投递。');
  const from = opts.from ?? 'human';
  // 新的消息 = 唤醒:清掉上一次的停止意图(harness:waking send resumes the parked queue)
  child.stopReason = null;
  // harness 的消息分帧:模型发的消息带发送者署名(人类发的原样送达)
  const content = from === 'parent'
    ? `主代理(Agent ${child.parentSid ?? '未知'})发来一条消息:\n${body}`
    : body;

  const delivery: Delivery = opts.delivery === 'steer' ? 'steer' : 'queue';
  const display = body;
  if (delivery === 'steer' && child.busy) {
    // 最近一步边界被认领:直接写进会话(下一份请求就带上它),标记"已入会话"
    child.session.append('user/message', { content, source: from === 'parent' ? 'parent' : 'user' });
    child.steerPending += 1;
  } else {
    // 排队:内容只进队列(父会话同一口径:排队消息先出现在「待执行」面板,开轮时才成为气泡)
    child.inbox.push({
      id: ++queueSeq, at: Date.now(), content, display,
      source: from === 'parent' ? 'parent' : 'human'
    });
  }
  // 运行记录里立刻可见这条消息(面板/回看用),但模型上下文要等它真正开轮
  appendMessage(id, { role: 'user', step: 0, at: Date.now(), text: content, from });
  publish(child, child.busy ? 'running' : 'idle');
  notify(child);
  emitQueue(child);
  kick(child);
  return { runId: child.runId, queued: child.inbox.length + child.steerPending, delivered: true, resumed };
}

/** 队列操作(与父会话 queue_steer / queue_remove 同语义):立即执行 = 插队首并打断当前轮 */
export function queueSteer(runId: string, itemId: number): boolean {
  const c = children.get(String(runId || ''));
  if (!c) return false;
  const idx = c.inbox.findIndex((q) => q.id === itemId);
  if (idx < 0) return false;
  const [item] = c.inbox.splice(idx, 1);
  if (c.busy) {
    c.inbox.unshift(item);
    if (c.signal) { try { c.signal.abort(); } catch { /* 忽略 */ } }
  } else {
    c.inbox.unshift(item);
    kick(c);
  }
  emitQueue(c);
  return true;
}

/** 从队列里删掉一条(与父会话 queue_remove 同语义) */
export function queueRemove(runId: string, itemId: number): boolean {
  const c = children.get(String(runId || ''));
  if (!c) return false;
  const idx = c.inbox.findIndex((q) => q.id === itemId);
  if (idx >= 0) c.inbox.splice(idx, 1);
  publish(c, c.busy ? 'running' : 'idle');
  emitQueue(c);
  return idx >= 0;
}

// ---------------- 冷恢复(cold resume) ----------------
// harness:一个 continuable 子代理的 Activation 消失后(进程重启/被回收),下一次 sendMessage
// 会**从持久化的子会话**重新造一个 Activation 再投递 —— 子代理不是"重启就死",只有一次性派发才不可续。
// 本项目把子会话落在 data/subagents/<runId>.json 的 messages 上,这里把它重建成 Session 事件流。

/** 冷恢复需要的依赖:模型客户端 + 工具注册表(+ 通知口 + 执行作用域),都由调用方现场提供 */
export interface ResumeDeps {
  llm: any;
  registry: ToolRegistry;
  emit?: (event: string, payload: any) => void;
  notifyParent?: (text: string, source?: MessageSource) => void;
  binding?: ChildBinding | null;
}

/**
 * 把运行记录里的对话重建成子会话事件流。
 * 与父会话**逐字同构**:turn/start、step/start、user/message、assistant/message、
 * tool/call、tool/result、step/end、turn/end —— 这样 `projectEvents` 能直接投影它
 * (前端用同一个 ChatPanel 渲染),`deriveMessages` 也能拿它继续对话。
 * tool_calls 与 tool/call、tool/result 严格配对(严格网关按 id 与条数校验)。
 */
function sessionFromRecord(run: SubagentRun): Session {
  const s = new Session();
  const msgs = Array.isArray(run.messages) ? run.messages : [];
  let turn = 0;
  let open = false;
  const closeTurn = () => {
    if (!open) return;
    s.append('turn/end', { turn, reason: { kind: 'completed' } });
    open = false;
  };
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (m.role === 'user') {
      closeTurn();
      turn += 1;
      s.append('turn/start', { turn });
      open = true;
      const source = m.from === 'brief' ? 'brief' : m.from === 'parent' ? 'parent' : 'user';
      s.append('user/message', { content: String(m.text ?? ''), source });
      i += 1;
      continue;
    }
    if (m.role === 'assistant') {
      if (!open) { turn += 1; s.append('turn/start', { turn }); open = true; }
      // 紧跟其后的连续 tool 消息 = 这条 assistant 声明的那批调用(记录本来就是按顺序追加的)
      const callIds: Array<{ id: string; name: string; args: string }> = [];
      let j = i + 1;
      while (j < msgs.length && msgs[j].role === 'tool') {
        const t = msgs[j];
        callIds.push({
          id: String(t.callId || `recovered_${j}`),
          name: String(t.name || ''),
          args: String(t.args || '{}')
        });
        j += 1;
      }
      const step = m.step || 1;
      s.append('step/start', { turn, step });
      s.append('assistant/message', {
        turn, step,
        message: {
          role: 'assistant',
          content: String(m.text ?? ''),
          ...(callIds.length
            ? { tool_calls: callIds.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) }
            : {}),
          ...(m.reasoning ? { reasoning_content: String(m.reasoning) } : {})
        }
      });
      for (let k = i + 1; k < j; k++) {
        const t = msgs[k];
        s.append('tool/result', {
          turn: 1, step: t.step || 1,
          callId: String(t.callId || `recovered_${k}`),
          name: String(t.name || ''),
          isError: t.isError === true,
          content: String(t.content ?? ''),
          ms: t.ms ?? 0
        });
      }
      i = j;
      continue;
    }
    i += 1; // 落单的 tool(异常记录):不投影,孤儿结果在投影层本来也会被丢弃
  }
  return s;
}

/** 从运行记录重建一个常驻 Activation(只恢复身份与对话,不恢复"正在跑的那一轮") */
function coldResume(rec: SubagentRun, deps: ResumeDeps): Child {
  const session = sessionFromRecord(rec);
  // 最后一条非空 assistant 文本 = 上次的结论(冷恢复后继续跑时仍可作为 fallback 结论)
  let lastText = '';
  for (const m of rec.messages || []) if (m.role === 'assistant' && String(m.text || '').trim()) lastText = String(m.text);
  let resolveSettled: (x: SubagentSettlement) => void = () => {};
  const child: Child = {
    runId: rec.runId,
    mode: 'continuable',
    parentSid: rec.sid ?? null,
    description: rec.description,
    provider: rec.provider,
    session,
    llm: deps.llm,
    registry: deps.registry,
    emit: deps.emit,
    notifyParent: deps.notifyParent,
    inbox: [], steerPending: 0,
    busy: false, signal: null, draining: null, disposed: false,
    steps: rec.steps || 0, toolCalls: rec.toolCalls || 0,
    promptTokens: rec.promptTokens || 0, completionTokens: rec.completionTokens || 0,
    lastText, stopReason: null, startedAt: rec.startedAt || Date.now(),
    settled: new Promise((res) => { resolveSettled = res; }),
    resolveSettled, firstSettled: false, detachAbort: null,
    binding: deps.binding ?? null
  };
  children.set(child.runId, child);
  // 记录上可能还留着上次的终局/停止标记:恢复出来就是"当前未运行",等这条新消息开新轮
  updateRun(child.runId, { status: 'idle', note: null, steps: child.steps, toolCalls: child.toolCalls, queued: 0 });
  notify(child);
  return child;
}

/**
 * 结算通知的投递口(唯一实现;工具层与 RPC 层共用)。
 * 走 agent.submit = harness 的 waking delivery:父会话空闲就被唤醒开一轮,正在跑就进它的
 * 待执行队列。投递前先 ensureRuntime —— 父会话本身也可能没在内存里(服务重启过/用户没切到它),
 * 那正是"父会话不在线"的真实情形,这里把它从磁盘载回来再投,而不是把通知丢掉。
 */
export function parentNotifier(agent: any, sid: string | null | undefined) {
  const parentSid = sid ? String(sid) : '';
  if (!parentSid) return undefined;
  return (text: string, source?: MessageSource) => {
    try {
      if (!agent) return;
      // 投递目标由 dsh 的 notifySettlement 决定(空闲=排一轮 / 运行中=steer 进正在跑的那一轮);
      // agent.deliverNotice 实现了那套选择,submit 只作为老 agent 实例的兜底
      const src = source ?? 'subagent-settled';
      if (typeof agent.deliverNotice === 'function') { agent.deliverNotice(parentSid, text, { source: src }); return; }
      try { agent.ensureRuntime?.(parentSid); } catch { /* 载不回来就按下面的 submit 兜底 */ }
      const p = agent.submit(parentSid, text, { auto: true, source: src });
      if (p && typeof p.catch === 'function') p.catch(() => { /* 投递失败与子代理无关 */ });
    } catch { /* 父会话载不回来:丢弃通知(子代理自己的记录里仍有完整结论) */ }
  };
}

/**
 * 暂停一个常驻子代理:只停"当前这一轮",排队消息保留、Activation 不销毁。
 * 已结束/不在内存里 = 受理的空操作(harness:absent target is an accepted no-op)。
 */
export function interruptChild(runId: string, reason = '已停止'): boolean {
  const child = children.get(String(runId || ''));
  if (!child) return false;
  child.stopReason = reason;
  if (child.signal) { try { child.signal.abort(); } catch { /* 忽略 */ } }
  return true;
}

/** 进程退出/测试收尾:停掉所有常驻子代理(不影响已落盘的运行记录) */
export function disposeAll(): void {
  for (const child of [...children.values()]) {
    child.disposed = true;
    if (child.signal) { try { child.signal.abort(); } catch { /* 忽略 */ } }
    finishRun(child.runId, {
      status: 'stopped', steps: child.steps, toolCalls: child.toolCalls,
      promptTokens: child.promptTokens, completionTokens: child.completionTokens, note: '运行时已关闭'
    });
    child.detachAbort?.();
  }
  children.clear();
}

/** 子代理 id 形状(sa_…):session 级 RPC 据此把请求分流到子代理运行时 */
export function isChildId(id: unknown): boolean {
  return /^sa_[0-9a-z]+$/.test(String(id || ''));
}

/**
 * 这一次派发的子会话(常驻的用内存里那份,否则从运行记录重建)。
 * 返回的 Session 事件流与父会话逐字同构,所以调用方可以直接
 * `projectEvents(session.events)` 得到与父会话同一形状的 turns。
 */
export function childSessionFor(runId: string): Session | null {
  const id = String(runId || '');
  const live = children.get(id);
  if (live) return live.session;
  const rec = getRun(id);
  return rec ? sessionFromRecord(rec) : null;
}

/**
 * 捕获派发它的父会话当前的作用域(连接 + 远程/本地工作区绑定),供子代理的工具执行套用。
 * 取自 agent 的会话运行时;取不到(会话没在内存/绑定失败)就返回 null = 按当前活动连接执行。
 */
export function captureBinding(agent: any, sid: string | null | undefined): ChildBinding | null {
  try {
    const rt = sid ? agent?._runtimes?.get?.(String(sid)) : null;
    if (!rt) return null;
    const bound = typeof agent?._bindTurnConn === 'function' ? agent._bindTurnConn(rt) : null;
    if (bound?.error) return null;
    return {
      conn: bound?.boundConn ?? null,
      workspace: bound?.remoteWs ?? null,
      localWorkspace: rt.localWorkspace ?? null
    };
  } catch { return null; }
}

export { isAbort };
