// 事件溯源会话日志(设计参照 deepseek-harness 的 session 子系统):
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

export class Session {
  constructor(events = []) {
    // 载入/迁移的事件统一按位置重排 seq;time 缺失时补当前时间
    this.events = (events || [])
      .filter((ev) => ev && ev.type && ev.data && typeof ev.data === 'object')
      .map((ev, i) => ({ seq: i, time: ev.time ?? Date.now(), type: ev.type, data: ev.data }));
    this._heal(); // 给崩溃遗留的未闭合工具调用补结果,保证日志重放出的消息序列永远合法
  }

  /** 追加一条事件,seq 单调递增(seq = 日志长度) */
  append(type, data) {
    const ev = { seq: this.events.length, time: Date.now(), type, data };
    this.events.push(ev);
    return ev;
  }

  /** 回滚到 seq(不含):仅用于"模型不支持工具"这类配置级失败的整轮重开 */
  truncate(seq) {
    if (seq >= 0 && seq <= this.events.length) this.events.length = seq;
  }

  get seq() { return this.events.length; }

  /** 下一个 turn 编号(从日志中已出现的最大编号推导) */
  nextTurn() {
    let n = 0;
    for (const ev of this.events) {
      if ((ev.type === 'turn/start' || ev.type === 'turn/end') && ev.data.turn > n) n = ev.data.turn;
    }
    return n + 1;
  }

  hasUserMessages() {
    return this.events.some((ev) => ev.type === 'user/message' && ev.data.source === 'user');
  }

  /**
   * 未闭合的工具调用(有 tool/call 无 tool/result)。
   * 中止/异常收尾时由调用方补结果;构造时由 _heal 兜底。
   */
  pendingToolCalls() {
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
  deriveMessages({ budgetChars = Infinity } = {}) {
    const trace = this.deriveMessagesWithTrace({ budgetChars });
    return trace.map((t) => t.msg);
  }

  /**
   * 同 deriveMessages,但返回 [{ seq, msg }],方便调用方把压缩/裁剪后的
   * 消息索引映射回日志事件 seq(供 squash 使用)。
   */
  deriveMessagesWithTrace({ budgetChars = Infinity } = {}) {
    const traced = [];
    for (const ev of this.events) {
      const d = ev.data || {};
      switch (ev.type) {
        case 'user/message':
          traced.push({ seq: ev.seq, msg: { role: 'user', content: d.content } });
          break;
        case 'assistant/message': {
          const m = d.message || {};
          const hasCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
          if (!m.content && !hasCalls) break;
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
          traced.push({ seq: ev.seq, msg: { role: 'tool', tool_call_id: d.callId, content: d.content } });
          break;
        case 'compaction/done':
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
   * 行内压缩区间替换:把 dropSeqs 指定的早期消息事件从日志中移除,
   * 并在 anchorSeq(保留区第一条事件原 seq)位置插入一条 compaction/done 摘要事件。
   * 被压缩的对话事实已沉淀进摘要,日志保持"模型可见即可回放"。
   */
  squash(dropSeqs, summary, anchorSeq) {
    const drop = new Set(dropSeqs.map(Number).filter((n) => Number.isFinite(n)));
    const kept = [];
    let inserted = false;
    for (const ev of this.events) {
      if (drop.has(ev.seq)) continue;
      if (!inserted && anchorSeq != null && ev.seq >= anchorSeq) {
        kept.push({ type: 'compaction/done', data: { summary } });
        inserted = true;
      }
      kept.push(ev);
    }
    if (!inserted) kept.push({ type: 'compaction/done', data: { summary } });
    // 重排 seq = 新数组下标,保持单调;time 缺失时补当前时间
    this.events = kept.map((ev, i) => ({ seq: i, time: ev.time ?? Date.now(), type: ev.type, data: ev.data }));
  }

  /** 给构造载入时仍未闭合的工具调用补一条"中止"结果(进程崩溃/被杀的遗留) */
  _heal() {
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
 * @param {Array<{type: string, data?: any}>} events 事件日志
 * @returns {Array<{content: string, status: string}> | null} 当前计划(无则 null)
 */
export function foldTodos(events) {
  let todos = null;
  for (const ev of events || []) {
    if (ev?.type === 'todo/write') todos = Array.isArray(ev.data?.todos) ? ev.data.todos : null;
    else if (ev?.type === 'turn/start') todos = null;
  }
  return todos;
}

// 按"对话组"裁剪(作用于带 seq 的 trace):超预算时从头部整组丢弃(一组 = 一条 user
// 到下一条 user 之前),保证剩余历史仍以 user 开头、assistant/tool_calls 配对完整。
function trimByBudget(traced, budget) {
  if (!Number.isFinite(budget) || budget <= 0) return traced;
  const mlen = (t) => String(t.msg.content || '').length + String(t.msg.reasoning_content || '').length;
  let total = traced.reduce((n, t) => n + mlen(t), 0);
  let start = 0;
  while (total > budget && start < traced.length) {
    let end = start + 1;
    while (end < traced.length && traced[end].msg.role !== 'user') end++;
    for (let i = start; i < end; i++) total -= mlen(traced[i]);
    start = end;
  }
  return start > 0 ? traced.slice(start) : traced;
}

/**
 * 旧版消息数组(v1 turns)迁移为事件日志:
 * user 开新轮;每条 assistant 是一步;tool 消息与前置 assistant 的 tool_calls
 * 按 id 配对还原为 tool/call + tool/result。孤儿 tool 消息(无前置 tool_calls,
 * 旧版本顺序错乱落盘的损坏数据)直接丢弃,保证迁移结果可安全回放。
 */
export function eventsFromTurns(turns) {
  const events = [];
  const push = (type, data) => events.push({ type, data });
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
      const toolCalls = (Array.isArray(m.tool_calls) ? m.tool_calls : []).filter((t) => t && t.id);
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
