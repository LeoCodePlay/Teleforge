// 事件溯源会话日志(设计 的 session 子系统):
// - append-only 的 SessionEvent 序列是唯一事实源。LLM 消息历史不单独存储,
//   由 deriveMessages() 从事件投影得出——"模型可见即可回放":凡是发给模型的内容,
//   都能从日志重建;回放就是同一份事件的重新投影。
// - 事件词汇表(与 harness 的 SessionEventMap 对齐后按需精简):
//     turn/start       {turn}                          开启一轮(一次用户输入驱动的完整交互)
//     turn/end         {turn, reason}                  关闭一轮;reason.kind: completed|aborted|error|max-iters
//     step/start       {turn, step}                    开启一步(一次模型请求 + 它发起的工具调用)
//     step/end         {turn, step}                    关闭一步
//     user/message     {content, source}               用户输入(source='user')或运行中注入(source='steer')
//     assistant/message {turn, step, message}          模型回复(含 tool_calls / reasoning_content)
//     tool/call        {turn, step, callId, name, arguments}   模型请求的工具调用(arguments 保持原始 JSON 字符串)
//     tool/result      {turn, step, callId, name, isError, content, ms} 工具执行结果
//     todo/write       {todos:[{content,status}]}              任务计划整表快照(todo_write 工具写入)
// - turn/*、step/* 是结构边界,不投影为消息;user/message、assistant/message、
//   tool/result 三类是"消息面",deriveMessages() 只看它们。
// - todo/write 是会话状态而非消息(参照 harness 的 sessionProjections):
//   foldTodos() 折叠出"当前计划"——最新一次 todo/write 的整表,下一次 turn/start 清空
//   (turn/end 不清,完成的清单保持可见,直到用户开启新一轮)。

export interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
  [k: string]: any;
}

export interface LlmMessage {
  role: 'user' | 'assistant' | 'tool' | string;
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
  [k: string]: any;
}

export interface SessionEventDataMap {
  'turn/start': { turn: number };
  'turn/end': { turn: number; reason: { kind: string; [k: string]: any } };
  'step/start': { turn: number; step: number };
  'step/end': { turn: number; step: number };
  'user/message': { content: string; source: string };
  'assistant/message': { turn: number; step: number; message: LlmMessage };
  'tool/call': { turn: number; step: number; callId: string; name: string; arguments: string };
  'tool/result': { turn: number; step: number; callId: string; name: string; isError: boolean; content: string; ms: number };
  'todo/write': { todos: Array<{ content: string; status: string }> };
  'compaction/done': { summary: string; dropCount?: number; manual?: boolean };
}

export type SessionEventType = keyof SessionEventDataMap | string;

export interface SessionEvent {
  seq: number;
  time: number;
  type: SessionEventType;
  data: any;
}

export interface TracedMessage {
  seq: number;
  msg: LlmMessage;
}

export class Session {
  events: SessionEvent[];

  constructor(events: SessionEvent[] = []) {
    // 载入/迁移的事件统一按位置重排 seq;time 缺失时补当前时间
    this.events = (events || [])
      .filter((ev: any) => ev && ev.type && ev.data && typeof ev.data === 'object')
      .map((ev: any, i: number) => ({ seq: i, time: ev.time ?? Date.now(), type: ev.type, data: ev.data }));
    this._heal(); // 给崩溃遗留的未闭合工具调用补结果,保证日志重放出的消息序列永远合法
  }

  /** 追加一条事件,seq 单调递增(seq = 日志长度) */
  append(type: SessionEventType, data: any): SessionEvent {
    const ev = { seq: this.events.length, time: Date.now(), type, data };
    this.events.push(ev);
    return ev;
  }

  /** 回滚到 seq(不含):仅用于"模型不支持工具"这类配置级失败的整轮重开 */
  truncate(seq: number): void {
    if (seq >= 0 && seq <= this.events.length) this.events.length = seq;
  }

  get seq(): number { return this.events.length; }

  /** 下一个 turn 编号(从日志中已出现的最大编号推导) */
  nextTurn(): number {
    let n = 0;
    for (const ev of this.events) {
      if ((ev.type === 'turn/start' || ev.type === 'turn/end') && ev.data.turn > n) n = ev.data.turn;
    }
    return n + 1;
  }

  hasUserMessages(): boolean {
    return this.events.some((ev) => ev.type === 'user/message' && ev.data.source === 'user');
  }

  /**
   * 未闭合的工具调用(有 tool/call 无 tool/result)。
   * 中止/异常收尾时由调用方补结果;构造时由 _heal 兜底。
   */
  pendingToolCalls(): any[] {
    const pending = new Map();
    for (const ev of this.events) {
      if (ev.type === 'tool/call') pending.set(ev.data.callId, ev.data);
      else if (ev.type === 'tool/result') pending.delete(ev.data.callId);
    }
    return [...pending.values()];
  }

  /**
   * 投影出 OpenAI 兼容的 LLM 消息历史(不含 system):
   * - user/message -> user 消息
   * - assistant/message -> assistant 消息;空内容且无 tool_calls 的跳过
   *   (max-tokens 截断等"无产出"的请求不进入下一份请求)
   * - tool/result -> tool 消息(紧跟带对应 tool_calls 的 assistant 之后)
   * - compaction/done -> user 摘要消息(行内压缩:早期区间已被 squash 移除,摘要保留原位)
   * - 超预算时按"对话组"从头部整组丢弃(裁剪发生在投影层,日志本身保持完整)
   */
  deriveMessages({ budgetChars = Infinity }: { budgetChars?: number } = {}): LlmMessage[] {
    const trace = this.deriveMessagesWithTrace({ budgetChars });
    return trace.map((t) => t.msg);
  }

  /**
   * 同 deriveMessages,但返回 [{ seq, msg }],方便调用方把压缩/裁剪后的
   * 消息索引映射回日志事件 seq(供 squash 使用)。
   */
  deriveMessagesWithTrace({ budgetChars = Infinity }: { budgetChars?: number } = {}): TracedMessage[] {
    const traced: TracedMessage[] = [];
    // 待消费的 tool_call id(最近一条带 tool_calls 的 assistant 声明的,OpenAI 配对语义):
    // 投影期过滤孤儿 tool/result——构造时自愈(_heal)能清掉落盘损坏,但运行中会话
    // (旧版压缩产生的孤儿仍驻内存)也要保证投影序列永远合法,严格提供商会 400。
    let pending = new Set<string>();
    for (const ev of this.events) {
      const d = ev.data || {};
      switch (ev.type) {
        case 'user/message':
          pending = new Set(); // user 之后工具 id 失效
          traced.push({ seq: ev.seq, msg: { role: 'user', content: d.content } });
          break;
        case 'assistant/message': {
          const m = d.message || {};
          const hasCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
          if (!m.content && !hasCalls) break;
          pending = new Set(hasCalls ? m.tool_calls.map((t: any) => t.id) : []);
          traced.push({
            seq: ev.seq,
            msg: {
              role: 'assistant',
              content: m.content || '',
              ...(hasCalls ? { tool_calls: m.tool_calls } : {}),
              ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {})
            }
          });
          break;
        }
        case 'tool/result':
          // 孤儿 tool/result(无前置 assistant tool_calls):跳过,不进入模型可见面
          if (!pending.has(d.callId)) break;
          pending.delete(d.callId);
          traced.push({ seq: ev.seq, msg: { role: 'tool', tool_call_id: d.callId, content: d.content } });
          break;
        case 'compaction/done':
          pending = new Set(); // 压缩摘要 user 消息:工具 id 失效(与 user/message 同语义)
          traced.push({
            seq: ev.seq,
            msg: { role: 'user', content: d.summary || '【上下文已自动压缩】早期对话已省略。' }
          });
          break;
        default:
          break; // turn/*、step/* 等结构事件不投影
      }
    }
    // 兼容旧版损坏数据:丢弃首个 user 之前的消息
    const firstUser = traced.findIndex((t) => t.msg.role === 'user');
    const base = firstUser > 0 ? traced.slice(firstUser) : traced;
    return trimByBudget(base, budgetChars);
  }

  /**
   * 行内压缩区间替换:把 [min(dropSeqs), anchorSeq) 区间内的**全部事件**从日志移除
   * (包括 tool/call、step/* 等不投影的结构事件——它们属于被压缩的步骤,留着会在
   * 轮末自愈时生成无前置 assistant 的孤儿 tool/result,破坏回放序列),
   * 并在 anchorSeq 位置插入一条 compaction/done 摘要事件。
   * dropSeqs 提供区间起点与合法性依据(必须是被压缩消息面的前缀 seq);
   * meta 可选:手动/自动调用方借此携带 dropCount、manual 标记,
   * 前端据其渲染「压缩标记行」的标题与条数(样式参照 harness 的 CompactionItem)。
   * 被压缩的对话事实已沉淀进摘要,日志保持"模型可见即可回放"。
   */
  squash(dropSeqs: number[] | string[], summary: string, anchorSeq: number | null, meta?: { dropCount?: number; manual?: boolean }): void {
    const nums = dropSeqs.map(Number).filter((n) => Number.isFinite(n));
    const rangeStart = nums.length ? Math.min(...nums) : null;
    const data = { summary, ...(meta || {}) };
    const kept: any[] = [];
    let inserted = false;
    for (const ev of this.events) {
      // 区间删除:被压区间 [rangeStart, anchorSeq) 内的一切事件都移除;
      // anchorSeq 为 null 表示压到末尾(保留区为空),删掉 rangeStart 起的全部
      if (rangeStart != null && ev.seq >= rangeStart && (anchorSeq == null || ev.seq < anchorSeq)) continue;
      if (!inserted && anchorSeq != null && ev.seq >= anchorSeq) {
        kept.push({ type: 'compaction/done', data });
        inserted = true;
      }
      kept.push(ev);
    }
    if (!inserted) kept.push({ type: 'compaction/done', data });
    // 重排 seq = 新数组下标,保持单调;time 缺失时补当前时间
    this.events = kept.map((ev, i) => ({ seq: i, time: ev.time ?? Date.now(), type: ev.type, data: ev.data }));
  }

  /**
   * 构造载入时的日志自愈:
   * 1) 移除"孤儿工具事件"——无前置 assistant tool_calls 声明的 tool/call 与 tool/result。
   *    旧版行内压缩(squash)只删投影事件、漏删 tool/call 结构事件,轮末自愈又为残留的
   *    tool/call 补了"中止"结果,落盘后就形成这类孤儿;它们投影出"无前置 assistant 的
   *    tool 消息",严格提供商会 400。此处一次性清掉,保证日志永远可安全回放。
   * 2) 仍未闭合的工具调用(进程崩溃/被杀的遗留)补一条"中止"结果。
   */
  _heal(): void {
    const alive = new Set<string>(); // 当前由 assistant tool_calls 声明的存活调用 id
    const kept: SessionEvent[] = [];
    for (const ev of this.events) {
      if (ev.type === 'user/message' || ev.type === 'compaction/done') {
        alive.clear(); // user 之后工具 id 失效(与 OpenAI 配对语义一致)
      }
      if (ev.type === 'assistant/message') {
        alive.clear();
        for (const t of ((ev.data && ev.data.message && ev.data.message.tool_calls) || [])) alive.add(t.id);
      }
      if ((ev.type === 'tool/call' || ev.type === 'tool/result') && !alive.has(ev.data.callId)) {
        continue; // 孤儿工具事件:移除
      }
      if (ev.type === 'tool/result' && alive.has(ev.data.callId)) alive.delete(ev.data.callId); // 一个 id 只消费一次
      kept.push(ev);
    }
    if (kept.length !== this.events.length) {
      this.events = kept.map((ev, i) => ({ seq: i, time: ev.time ?? Date.now(), type: ev.type, data: ev.data }));
    }
    for (const c of this.pendingToolCalls()) {
      this.append('tool/result', {
        turn: c.turn, step: c.step, callId: c.callId, name: c.name,
        isError: true, content: '工具执行中止(上次会话未完成)', ms: 0
      });
    }
  }
}

/**
 * 折叠事件日志得到"当前任务计划"(参照 harness 的 todos 投影):
 * 最新一次 todo/write 的整表即当前计划;用户开启新一轮(turn/start)即清空,
 * turn/end 不清空——已完成的清单保持可见,直到下一轮重新规划。
 * @returns 当前计划(无则 null)
 */
export function foldTodos(events: SessionEvent[]): Array<{ content: string; status: string }> | null {
  let todos: Array<{ content: string; status: string }> | null = null;
  for (const ev of events || []) {
    if (ev?.type === 'todo/write') todos = Array.isArray(ev.data?.todos) ? ev.data.todos : null;
    else if (ev?.type === 'turn/start') todos = null;
  }
  return todos;
}

// 按"对话组"裁剪的通用核心:超预算时从头部整组丢弃(一组 = 一条 user 到下一条 user 之前),
// 保证剩余历史仍以 user 开头、assistant/tool_calls 配对完整。
// 关键:第一条 user 消息(原始任务锚点)永不丢弃——它是用户最初的需求,丢了模型会"失忆",
// 退化成"我已就绪,没有任务"。裁剪只作用于第二组及之后的早期历史。
function trimByBudgetCore<T>(items: T[], budget: number, getMsg: (t: T) => any): T[] {
  if (!Number.isFinite(budget) || budget <= 0) return items;
  const mlen = (t: T) => {
    const m = getMsg(t);
    return String(m?.content || '').length + String(m?.reasoning_content || '').length;
  };
  let total = items.reduce((n, t) => n + mlen(t), 0);
  if (total <= budget) return items;
  const isUser = (t: T) => getMsg(t)?.role === 'user';
  // 定位原始任务锚点组的结束位置(下一个 user 消息或数组末尾)。
  // 调用方保证 items[0] 必为 user(deriveMessagesWithTrace 已丢弃首个 user 之前的消息)。
  let anchorEnd = 1;
  while (anchorEnd < items.length && !isUser(items[anchorEnd])) anchorEnd++;
  // 从第二组开始从头部整组丢弃,直到回到预算内
  let start = anchorEnd;
  while (total > budget && start < items.length) {
    let end = start + 1;
    while (end < items.length && !isUser(items[end])) end++;
    for (let i = start; i < end; i++) total -= mlen(items[i]);
    start = end;
  }
  return items.slice(0, anchorEnd).concat(items.slice(start));
}

function trimByBudget(traced: TracedMessage[], budget: number): TracedMessage[] {
  return trimByBudgetCore(traced, budget, (t) => t.msg);
}

/** 纯消息数组(无 seq)版本的兜底裁剪:同样保第一条 user 锚点。供 agent 在摘要压缩后再兜底。 */
export function trimMessagesByBudget(msgs: LlmMessage[], budget: number): LlmMessage[] {
  return trimByBudgetCore(msgs, budget, (m) => m);
}

/**
 * 旧版消息数组(v1 turns)迁移为事件日志:
 * user 开新轮;每条 assistant 是一步;tool 消息与前置 assistant 的 tool_calls
 * 按 id 配对还原为 tool/call + tool/result。孤儿 tool 消息(无前置 tool_calls,
 * 旧版本顺序错乱落盘的损坏数据)直接丢弃,保证迁移结果可安全回放。
 */
export function eventsFromTurns(turns: any[]): SessionEvent[] {
  const events: SessionEvent[] = [];
  const push = (type: SessionEventType, data: any) => events.push({ type, data } as any);
  const calls = new Map(); // callId -> {name, arguments}
  let turn = 0, step = 0, stepOpen = false, turnOpen = false;
  const closeStep = () => { if (stepOpen) { push('step/end', { turn, step }); stepOpen = false; } };
  const closeTurn = () => {
    closeStep();
    if (turnOpen) { push('turn/end', { turn, reason: { kind: 'completed' } }); turnOpen = false; }
  };

  for (const m of turns || []) {
    if (!m || !m.role) continue;
    if (m.role === 'user') {
      closeTurn();
      turn++; turnOpen = true;
      push('turn/start', { turn });
      push('user/message', { content: String(m.content || ''), source: 'user' });
    } else if (m.role === 'assistant') {
      if (!turnOpen) { turn++; turnOpen = true; push('turn/start', { turn }); }
      closeStep();
      step++; stepOpen = true;
      const toolCalls = (Array.isArray(m.tool_calls) ? m.tool_calls : []).filter((t: any) => t && t.id);
      for (const t of toolCalls) {
        calls.set(t.id, { name: t.function?.name, arguments: t.function?.arguments });
      }
      push('step/start', { turn, step });
      push('assistant/message', {
        turn, step,
        message: {
          role: 'assistant',
          content: m.content || '',
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {})
        }
      });
    } else if (m.role === 'tool') {
      // 孤儿 tool 消息(缺前置 assistant tool_calls)丢弃
      if (!m.tool_call_id || !calls.has(m.tool_call_id)) continue;
      const c = calls.get(m.tool_call_id);
      push('tool/call', { turn, step, callId: m.tool_call_id, name: c.name || '(unknown)', arguments: c.arguments || '{}' });
      push('tool/result', {
        turn, step, callId: m.tool_call_id, name: c.name || '(unknown)',
        isError: m.ok === false, content: String(m.content || ''), ms: m.ms ?? 0
      });
    }
  }
  closeTurn();
  return events;
}
