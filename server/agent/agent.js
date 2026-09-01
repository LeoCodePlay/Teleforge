// Agent 主循环:接收用户指令 -> 流式调用 LLM -> 执行工具 -> 迭代直到完成。
// 架构参照 deepseek-harness:
// - 事件溯源:会话是 append-only 的 SessionEvent 日志(见 session.js),LLM 消息
//   历史由 deriveMessages() 投影得出,不再单独维护 history 数组——"模型可见即可回放"。
// - Turn/Step 生命周期:一步(step)= 一次模型请求 + 它发起的工具调用;一轮(turn)=
//   若干步。每次边界都写入事件日志,turn/end 记录结束原因(completed/aborted/error/max-iters)。
// - 工具走注册表执行管线(见 registry.js):单个工具失败是结构化错误结果,绝不终结整轮。
// - Inbox 输入路由(对齐 harness 的 next-turn / next-step 两个收件边界):
//   空闲时 submit() 开新轮;运行中注入下一步,作为 user 消息进入模型上下文,
//   让用户能在 Agent 工作期间补充/纠正指令。
// - 多会话并行:每个会话一个运行时(事件日志 + inbox/steer/signal/busy,见 newRuntime),
//   各会话独立驱动互不阻塞;所有发给前端的事件都带 sid,前端按会话路由显示。
import { AGENT } from '../config.js';
import { LlmClient } from './llm.js';
import { compactHistory, summarizeWithLlm, messageTokens } from './compact.js';
import { Session, foldTodos } from './session.js';
import { ToolRegistry } from './registry.js';
import { registerTools, getEnvInfo, refreshSkillsCatalog, skillsCatalogStale, getSkillsCatalog, renderSkillCatalog, getSkillFull } from './tools.js';
import { renderPromptInjectSection } from './prompt-inject.js';
import { sshManager as ssh } from '../ssh-manager.js';
import * as sessions from '../session-store.js';

// 全局唯一工具注册表:启动时注册全部内置工具与守卫
const registry = new ToolRegistry();
registerTools(registry);
// 供 ws 层列出/开关工具插件(设置 → 工具插件)
export { registry as toolRegistry };

// 工具结果入日志的裁剪预算(head + marker + tail,参照 harness pruner 思路):
// 保留头尾而非丢弃,保证跨轮对话模型能复用已有探索结果,
// 避免每轮重复 get_workspace_info / list_directory 探测环境。
const STORE_HEAD = 4000;
const STORE_TAIL = 1000;
function storeCap(s) {
  if (!s || s.length <= STORE_HEAD + STORE_TAIL) return s;
  const omitted = s.length - STORE_HEAD - STORE_TAIL;
  return s.slice(0, STORE_HEAD) + `\n…[工具结果过长,历史中省略中间 ${omitted} 字符]…\n` + s.slice(s.length - STORE_TAIL);
}

// 判断错误是否为"模型/上游明确不支持工具调用"(如推理模型 deepseek-reasoner 等)。
// 认定标准:错误文案必须明确出现"工具/tool calling/function calling"字样并声明其不被支持。
// 不能只匹配 "not supported" 这类泛化措辞——中转网关的临时故障(渠道切换、限流等)
// 文案里也常含 "not supported",误判成能力缺失会把整个会话静默降级、掩盖真实错误。
const TOOL_UNSUPPORTED_RES = [
  /MODEL_TOOL_NOT_SUPPORTED/i,                                                            // DeepSeek 官方错误码
  /tools?\s+(?:is\s+|are\s+)?not\s+support(?:ed)?/i,                                      // tools are not supported
  /tools?\s+unsupported/i,                                                                // tool unsupported
  /not\s+(?:be\s+)?support(?:ed)?\s+(?:any\s+)?(?:tools?|tool\s+calls?|tool\s+calling|tool\s+use|function\s+calling|function\s+calls?)/i, // does not support tools / tool calling / function calling
  /(?:tool\s+calls?|tool\s+calling|tool\s+use|function\s+calling|function\s+calls?)\s+(?:is\s+|are\s+)?not\s+support(?:ed)?/i, // tool calling is not supported
  /不支持\s*(?:工具|函数调用|function\s*calling)/i,                                        // 不支持工具调用 / 不支持 function calling
  /工具调用[^。]{0,30}不支持/                                                               // 该模型的工具调用暂不支持
];
export function isToolUnsupportedError(e) {
  const s = String(e?.message || '');
  return TOOL_UNSUPPORTED_RES.some((re) => re.test(s));
}

// 会话运行时:每个会话独立持有事件日志与驱动状态,多会话可并行运行互不阻塞
function newRuntime(session) {
  return {
    session,       // Session:该会话的事件日志(唯一事实源)
    busy: false,   // 该会话的 driver 是否在运行(idle/running 状态机的运行态)
    signal: null,  // 该会话当前轮的 AbortController
    inbox: [],     // next-turn 输入队列(followup,空闲时逐条开新轮)
    steer: [],     // next-step 注入队列(运行中补充指令,下一步生效)
    driving: null  // 进行中的 driver promise(同会话并发提交复用同一驱动)
  };
}

// 兜底空日志:活跃会话运行时缺失(恢复失败)时投影为空
const EMPTY_SESSION = new Session();

// 事件日志 -> 前端消息数组投影(getHistory 的实现,与具体会话无关)
function projectEvents(events) {
  const out = [];
  const calls = new Map();
  for (const ev of events) {
    const d = ev.data || {};
    if (ev.type === 'tool/call') {
      calls.set(d.callId, d);
    } else if (ev.type === 'user/message') {
      out.push({ role: 'user', content: d.content });
    } else if (ev.type === 'compaction/done') {
      out.push({ role: 'user', content: d.summary || '【上下文已自动压缩】早期对话已省略。' });
    } else if (ev.type === 'assistant/message') {
      const m = d.message || {};
      out.push({
        role: 'assistant',
        content: m.content || '',
        ...(Array.isArray(m.tool_calls) && m.tool_calls.length ? { tool_calls: m.tool_calls } : {}),
        ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {})
      });
    } else if (ev.type === 'tool/result') {
      const c = calls.get(d.callId) || {};
      out.push({
        role: 'tool', tool_call_id: d.callId, content: d.content,
        tool_name: d.name || c.name, tool_args: c.arguments, ok: !d.isError, ms: d.ms
      });
    }
  }
  return out;
}

// 定位第 idx 条"消息面 turn"对应的事件结束位置(与 projectEvents 的投影顺序一致):
// 结构化边界(turn/*、step/*)与 tool/call 不投影为消息,不计入。
function cutAtTurn(events, idx) {
  let n = 0;
  for (let i = 0; i < events.length; i++) {
    const t = events[i].type;
    if (t === 'user/message' || t === 'compaction/done' || t === 'assistant/message' || t === 'tool/result') {
      if (n === idx) return i + 1;
      n++;
    }
  }
  return -1;
}

export class Agent {
  constructor({ emit }) {
    this.emit = emit;            // (event, payload) => void,由 ws 层转发给前端
    this.llm = null;            // LlmClient,由 llm 配置设置(全会话共享)
    this.llmConfigured = false;
    this.sessionId = null;      // 当前活跃(前端正在查看)会话 id
    this._runtimes = new Map(); // sessionId -> 运行时;多会话各自独立驱动、可并行
    this._chatOnly = false;     // 模型不支持工具调用时置 true,降级为纯对话(模型级,与具体会话无关)
    this._restore();
  }

  // 服务重启后恢复上次活跃会话(失败静默,等价于空会话)
  _restore() {
    try {
      const all = sessions.list();
      if (all.length === 0) sessions.create('新会话');
      this.sessionId = sessions.getActive() || sessions.list()[0]?.id || null;
      if (this.sessionId) {
        this._runtimes.set(this.sessionId, newRuntime(new Session(sessions.loadEvents(this.sessionId))));
        sessions.setActive(this.sessionId);
      }
    } catch (e) {
      console.error('[agent] 恢复会话失败:', e.message);
      this.sessionId = null;
    }
  }

  // 当前活跃会话的事件日志(活跃会话必有运行时)
  get session() {
    return this._runtimes.get(this.sessionId)?.session || EMPTY_SESSION;
  }

  // 派生的 LLM 消息历史(活跃会话;带预算裁剪;兼容外部直接读 .history 的用法)
  get history() {
    return this.session.deriveMessages({ budgetChars: AGENT.HISTORY_BUDGET_CHARS });
  }

  // 前端渲染投影:事件日志 -> 消息数组(工具消息附带 tool_name/tool_args/ok/ms)
  // 运行中的会话直接取其内存日志(含未落盘的进行中事件),空闲会话从磁盘载入
  getHistory(id = this.sessionId) {
    const rt = id != null ? this._runtimes.get(id) : null;
    const events = rt ? rt.session.events : (id != null ? sessions.loadEvents(id) : []);
    return projectEvents(events);
  }

  // 当前任务计划(todo/write 投影):最新整表,turn/start 清空(见 foldTodos)
  currentTodos(id = this.sessionId) {
    const rt = id != null ? this._runtimes.get(id) : null;
    const events = rt ? rt.session.events : (id != null ? sessions.loadEvents(id) : []);
    return foldTodos(events) || [];
  }

  /**
   * 从当前活跃会话创建分支(照搬 harness 的 forkAt 语义):
   * turnIndex 为消息数组(turns 投影)中的索引,>=0 时克隆到该条消息为止的事件日志
   * (截断其后的消息,从分支点另起炉灶);缺省 -1 克隆整个会话。
   * 原会话原封不动,用户可沿另一方向继续。
   * 克隆时 Session 构造的 _heal 会给进行中的工具调用补"中止"结果,快照永远可回放。
   */
  forkSession(turnIndex = -1) {
    const srcId = this.sessionId;
    if (!srcId || !sessions.exists(srcId)) throw new Error('当前没有可分支的会话');
    const rt = this._runtimes.get(srcId);
    const events = rt ? rt.session.events : sessions.loadEvents(srcId);
    // 分支截断点:第 turnIndex 条"消息面 turn"(user/message、compaction/done、
    // assistant/message、tool/result)对应的事件结束位置;turnIndex<0 表示从尾部整体克隆
    let cut = events.length;
    if (turnIndex >= 0) {
      const at = cutAtTurn(events, turnIndex);
      if (at < 0) throw new Error('分支点无效:目标消息不在当前会话中');
      cut = at;
    }
    const log = events.slice(0, cut);
    // 分支标题:剥离旧的分支后缀后重新编号,避免 "(分支)" 层层叠加
    const srcTitle = (sessions.list().find((s) => s.id === srcId)?.title || '新会话')
      .replace(/\s*\(分支(\d+)?\)\s*$/, '').trim() || '新会话';
    const taken = new Set(sessions.list().map((s) => s.title));
    let title = `${srcTitle} (分支)`;
    for (let n = 2; taken.has(title); n++) title = `${srcTitle} (分支${n})`;
    const s = sessions.create(title);
    const cloned = new Session(log.map((e) => ({ type: e.type, data: e.data, time: e.time })));
    sessions.saveEvents(s.id, cloned.events);
    this._runtimes.set(s.id, newRuntime(cloned));
    this.sessionId = s.id;
    this.emit('agent', { event: 'session_switched', id: s.id });
    this.emit('agent', { event: 'sessions_changed' });
    return s;
  }

  // 当前活跃会话 id
  getSessionId() { return this.sessionId; }

  // 会话列表(按最近更新倒序)
  listSessions() { return sessions.list(); }

  // 新建会话并切为活跃(不影响其他会话的运行)
  createSession(title) {
    const s = sessions.create(title);
    this._runtimes.set(s.id, newRuntime(new Session()));
    this.sessionId = s.id;
    this.emit('agent', { event: 'session_switched', id: s.id });
    return s;
  }

  // 切换到指定会话:运行中的会话直接复用其内存事件日志(含进行中未落盘的事件),
  // 切回去即可看到任务进行中的状态;切走的空闲会话释放内存,下次从磁盘载入。
  switchSession(id) {
    if (!sessions.exists(id)) throw new Error(`会话不存在: ${id}`);
    const prevId = this.sessionId;
    let rt = this._runtimes.get(id);
    if (!rt) {
      rt = newRuntime(new Session(sessions.loadEvents(id)));
      this._runtimes.set(id, rt);
    }
    this.sessionId = id;
    sessions.setActive(id);
    if (prevId && prevId !== id) {
      const prev = this._runtimes.get(prevId);
      if (prev && !prev.busy) this._runtimes.delete(prevId); // 空闲会话磁盘即最新
    }
    this.emit('agent', { event: 'session_switched', id });
  }

  // 删除会话(禁止删除当前活跃会话与运行中的会话)
  deleteSession(id) {
    if (id === this.sessionId) throw new Error('不能删除当前正在使用的会话');
    const rt = this._runtimes.get(id);
    if (rt?.busy) throw new Error('会话任务进行中,请先停止再删除');
    this._runtimes.delete(id);
    sessions.remove(id);
    this.emit('agent', { event: 'sessions_changed' });
  }

  // 重命名会话
  renameSession(id, title) {
    sessions.rename(id, title);
    this.emit('agent', { event: 'sessions_changed' });
  }

  // 清空指定会话历史(内存 + 磁盘);运行中的会话禁止清空
  clearHistory(id = this.sessionId) {
    const rt = id != null ? this._runtimes.get(id) : null;
    if (rt?.busy) throw new Error('会话正在运行,请先停止或等待完成');
    if (id != null) {
      this._runtimes.set(id, newRuntime(new Session()));
      sessions.saveEvents(id, []);
    }
    this.emit('agent', { event: 'history_cleared' });
    this.emit('agent', { event: 'sessions_changed' });
  }

  // 手动压缩当前会话上下文(/compact 命令,移植自 harness 的 command-compact):
  // 无条件把早期对话组压缩成一段摘要并 squash 进日志,不依赖自动压缩的阈值水位;
  // 保留最近一段(最高 contextWindow×16%,至少最后一组对话),与自动压缩同款范围选择。
  // 运行中的会话禁止压缩(等待 idle),压缩完成后广播 history_compacted 事件供前端刷新。
  /**
   * @param {string} [id] 会话 id,默认当前活跃会话
   * @returns {Promise<{compacted: boolean, dropCount: number, summary?: string}>}
   */
  async compactNow(id = this.sessionId) {
    const rt = (id != null ? this._runtimes.get(id) : null) || null;
    if (!rt) throw new Error('会话不存在');
    if (rt.busy) throw new Error('会话正在运行,请先停止或等待完成');
    const session = rt.session;
    if (!this.llm || this.llm.isMock) throw new Error('尚未配置可用的 LLM,无法生成摘要');
    const trace = session.deriveMessagesWithTrace({ budgetChars: Infinity });
    const msgs = trace.map((t) => t.msg);
    if (msgs.length < 3) return { compacted: false, dropCount: 0 };

    // 手动压缩保留最近一段(比自动压缩更克制:保留完整最近一组对话兜底)
    const ctxWindow = this.llm.contextWindow || 128000;
    const retainTokens = Math.max(Math.floor(ctxWindow * 0.16), 4000);
    // 至少保留最后一组对话(retainTokens 足够大时 selectCompactRange 退化为只保留首组)
    const groupStarts = [];
    msgs.forEach((m, i) => { if (m.role === 'user') groupStarts.push(i); });
    if (groupStarts.length < 2) return { compacted: false, dropCount: 0 };
    let keep = msgs.length;
    let acc = 0;
    for (let g = groupStarts.length - 1; g >= 0; g--) {
      const part = msgs.slice(groupStarts[g], keep);
      acc += part.reduce((n, m) => n + messageTokens(m), 0);
      keep = groupStarts[g];
      if (acc >= retainTokens) break;
    }
    if (keep === 0) keep = groupStarts[groupStarts.length - 1];
    if (keep <= 0 || keep >= msgs.length) return { compacted: false, dropCount: 0 };
    const dropMsgs = msgs.slice(0, keep);
    if (!dropMsgs.length) return { compacted: false, dropCount: 0 };

    let summary = '';
    if (!this.llm.isMock && this.llmConfigured) {
      try {
        summary = await summarizeWithLlm({
          llm: this.llm, system: this._systemPrompt('off'), dropMsgs, signal: new AbortController().signal
        });
      } catch (e) {
        console.warn(`[compact] 手动压缩摘要生成失败,降级为直接裁剪: ${e?.message || e}`);
      }
    }
    const summaryMsg = summary
      ? `【上下文已手动压缩】为节省上下文窗口,早期对话被压缩为以下摘要(如需细节请让助手展开):\n${summary}`
      : `【上下文已手动压缩】早期 ${dropMsgs.length} 条消息已省略。`;
    const dropSeqs = trace.slice(0, keep).map((t) => t.seq);
    const anchorSeq = trace[keep] ? trace[keep].seq : null;
    session.squash(dropSeqs, summaryMsg, anchorSeq);
    if (id != null) sessions.saveEvents(id, session.events); // 落盘,重启后可恢复
    this.emit('agent', { event: 'history_compacted', sid: id, dropCount: dropMsgs.length });
    return { compacted: true, dropCount: dropMsgs.length, summary: summaryMsg };
  }

  configureLlm(cfg) {
    this.llm = new LlmClient(cfg || {});
    this.llmConfigured = Boolean(this.llm && !this.llm.isMock ? this.llm.apiKey : true);
    this._chatOnly = false; // 换了模型,重置"不支持工具"降级标记,给新模型重新尝试工具的机会
    this.emit('llm', { configured: true, model: this.llm.model, mock: this.llm.isMock });
  }

  // 停止指定会话的当前轮(默认当前活跃会话);未消费的注入一并作废
  stop(id = this.sessionId) {
    const rt = id != null ? this._runtimes.get(id) : null;
    if (!rt) return;
    if (rt.signal) {
      try { rt.signal.abort(); } catch {}
    }
    rt.steer.length = 0;
  }

  // 停止所有运行中的会话(SSH 断开等全局异常时)
  stopAll() {
    for (const rt of this._runtimes.values()) {
      if (rt.signal) {
        try { rt.signal.abort(); } catch {}
      }
      rt.steer.length = 0;
    }
  }

  // 是否有任意会话在运行(兼容旧的单一忙碌语义)
  get busyNow() { return this.busyIds().length > 0; }

  // 运行中的会话 id 列表(前端会话列表显示"运行中"徽标)
  busyIds() {
    return [...this._runtimes].filter(([, rt]) => rt.busy).map(([id]) => id);
  }

  /**
   * 提交一条用户输入到指定会话(= harness 的 followup + wake):
   * 该会话空闲时开新轮;运行中则注入下一步(steer)。每个会话独立驱动,互不阻塞。
   * 返回的 promise 在该会话整个排空过程(含后续排队的输入)结束后 resolve。
   */
  submit(sessionId, userText, { reasoning = 'default' } = {}) {
    if (!this.llm) throw new Error('尚未配置 LLM(设置 -> 模型配置)');
    const rt = sessionId != null ? this._runtimes.get(sessionId) : null;
    if (!rt) throw new Error(`会话不存在: ${sessionId}`);
    const text = String(userText);
    if (rt.busy) {
      rt.steer.push({ text, reasoning });
      this.emit('agent', { event: 'steer', text, sid: sessionId });
      return rt.driving;
    }
    rt.inbox.push({ text, reasoning });
    return this._drive(rt, sessionId);
  }

  // 兼容旧接口:提交到当前活跃会话(运行中自动转为 steer 注入)
  run(userText, opts = {}) { return this.submit(this.sessionId, userText, opts); }
  steer(userText, opts = {}) { return this.submit(this.sessionId, userText, opts); }

  // 唤醒某会话的 driver:同一会话同一时刻只有一个驱动在跑,并发提交复用同一个 promise
  _drive(rt, id) {
    if (rt.driving) return rt.driving;
    rt.driving = this._drain(rt, id);
    return rt.driving.finally(() => { rt.driving = null; });
  }

  // driver 主循环:逐条消费该会话的 inbox,每条输入跑完整一轮(Turn)
  async _drain(rt, id) {
    rt.busy = true;
    this.emit('agent', { event: 'status', status: 'running', sid: id });
    try {
      while (rt.inbox.length > 0) {
        const input = rt.inbox.shift();
        await this._runTurn(rt, id, input);
      }
    } finally {
      rt.busy = false;
      rt.signal = null;
      this.emit('agent', { event: 'status', status: 'idle', sid: id });
    }
  }

  /**
   * 一轮完整交互(Turn):turn/start -> 若干步(step/start -> 模型请求 ->
   * assistant/message -> 工具调用与结果 -> step/end) -> turn/end。
   * 结束时事件日志落盘;中止/异常时给未闭合的工具调用补结果,保证日志永远可回放。
   * 事件全部携带 sid:前端按会话路由显示,多会话并行互不串扰。
   */
  async _runTurn(rt, runSessionId, { text, reasoning }) {
    const session = rt.session; // 锁定本轮操作的运行时与会话,中途切换活跃会话不影响本轮写入
    const signal = (rt.signal = new AbortController());

    // /技能名 [需求] 前缀(对齐 harness tool-skill 的 leadingInput 识别):
    // 用户以 /技能名 起头时,自动加载技能完整正文并注入本轮,让 AI 严格按技能指令行动。
    const slash = /^\/\s*([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (slash) {
      let injected = null;
      try { injected = await getSkillFull(slash[1].toLowerCase()); } catch { injected = null; }
      if (injected && injected.content) {
        const need = (slash[2] || '').trim();
        text = need
          ? `【用户请求使用技能 ${injected.name} 完成以下需求。以下为技能指令,请严格遵循:】\n\n${injected.content}\n\n————\n用户需求:\n${need}`
          : `【用户请求使用技能 ${injected.name}。以下为技能指令,请严格遵循并按其行动:】\n\n${injected.content}`;
      }
      // 未知技能原样交给模型(它可从会话技能目录中发现正确名称)
    }

    // 会话尚无用户消息时,用首条指令自动命名该会话(便于在会话列表里识别)
    if (runSessionId && !session.hasUserMessages()) {
      // 注入技能正文时用技能名 + 需求前缀命名,避免整段指令污染标题
      const original = slash
        ? (slash[2] || '').trim() ? `/${slash[1]} ${(slash[2] || '').trim()}` : `/${slash[1]}`
        : text.trim();
      const t = original.replace(/\s+/g, ' ').slice(0, 24);
      if (t) sessions.rename(runSessionId, t);
    }

    const turnStartSeq = session.seq;
    const turn = session.nextTurn();
    let turnOpened = false;
    let useTools = !this._chatOnly;
    // 当前模型若单独配置了迭代上限则优先使用,否则回退全局默认(AGENT.MAX_ITERS)
    const maxIters = (this.llm && this.llm.maxIters) || AGENT.MAX_ITERS;
    let finalText = '';
    let stepsUsed = 0;
    let endReason = { kind: 'completed' };

    // start 事件只展示原始输入(/技能名 需求),日志里才写注入后的完整指令,避免刷屏
    const displayText = slash ? text.trim() : text;
    this.emit('agent', { event: 'start', text: displayText, sid: runSessionId });
    try {
      // 技能目录:每轮开始按需刷新一次(工作区变化或 TTL 过期),供 system prompt 注入
      if (useTools && skillsCatalogStale()) {
        try { await refreshSkillsCatalog(); } catch { /* 扫描失败不阻塞本轮 */ }
      }
      // 工具调用上下文:todo_write 等需要写会话事件日志的工具从这里拿到所属会话
      const invokeCtx = { sid: runSessionId, session, emit: this.emit };
      for (let step = 1; step <= maxIters; step++) {
        if (signal.signal.aborted) throw new Error('已停止');
        if (!turnOpened) { session.append('turn/start', { turn }); turnOpened = true; }
        session.append('step/start', { turn, step });
        if (step === 1) session.append('user/message', { content: text, source: 'user' });

        // 收件箱:领取运行中注入(steer),作为本步的追加 user 消息
        for (const s of rt.steer.splice(0)) {
          session.append('user/message', { content: s.text, source: 'steer' });
        }

        stepsUsed = step;
        this.emit('agent', { event: 'iteration', iter: step, sid: runSessionId });

        // 模型请求 = system(提示词组装) + 事件日志投影出的派生历史
        // 若模型配置了声明的输入上下文窗口(>0),超过阈值水位时先自动压缩早期历史
        // (见 compact.js:早期对话组压缩成摘要并 squash 进日志,保留最近窗口)
        const systemText = this._systemPrompt(reasoning);
        const trace = session.deriveMessagesWithTrace({ budgetChars: AGENT.HISTORY_BUDGET_CHARS });
        let historyMsgs = trace.map((t) => t.msg);
        const ctxWindow = (this.llm && this.llm.contextWindow) || 0;
        if (ctxWindow > 0 && historyMsgs.length > 2) {
          const c = await compactHistory({
            messages: historyMsgs, system: systemText, llm: this.llm, signal: signal.signal,
            contextWindow: ctxWindow, maxTokens: this.llm.maxTokens
          });
          if (c.compacted) {
            const dropSeqs = trace.slice(0, c.dropCount).map((t) => t.seq);
            const anchorSeq = trace[c.dropCount] ? trace[c.dropCount].seq : null; // 保留区第一条消息的 seq
            session.squash(dropSeqs, c.messages[0].content, anchorSeq);
            historyMsgs = c.messages;
            console.log(`[agent] 上下文超限,已自动压缩早期 ${c.dropCount} 条消息(窗口 ${ctxWindow})`);
          }
        }
        const messages = [{ role: 'system', content: systemText }, ...historyMsgs];

        let res;
        try {
          res = await this.llm.chat({
            messages,
            tools: useTools ? registry.schemas() : [],
            signal: signal.signal,
            reasoning,
            onDelta: (d) => {
              if (d.kind === 'text') this.emit('agent', { event: 'text_delta', text: d.text, sid: runSessionId });
              else if (d.kind === 'reasoning') this.emit('agent', { event: 'reasoning_delta', text: d.text, sid: runSessionId });
            }
          });
        } catch (e) {
          // 模型/上游不支持工具调用(如推理模型):回滚本轮已写事件,降级为纯对话重开。
          // 这是配置级失败而非对话事实,清掉重试比把失败轮留在历史里更干净。
          if (useTools && step === 1 && !signal.signal.aborted && isToolUnsupportedError(e)) {
            const raw = String(e.message || e).slice(0, 300);
            this._chatOnly = true;
            useTools = false;
            session.truncate(turnStartSeq);
            turnOpened = false;
            // 原始错误必须可见:可能是模型真不支持,也可能是网关渠道问题,由用户判断
            this.emit('log', 'warn', `[agent] 工具调用被上游拒绝,已降级为纯对话。原始错误: ${raw}`);
            this.emit('agent', {
              event: 'notice', sid: runSessionId,
              text: `当前模型/上游拒绝了工具调用,已自动降级为纯对话模式(无法在远程读写文件/执行命令)。若是网关临时故障,稍后重开一个会话即可恢复;若是模型确实不支持(如推理模型),请换模型。原始错误: ${raw}`
            });
            step = 0; // 重开本轮(下一循环从 step=1 重新开始)
            continue;
          }
          throw e;
        }

        // 记录本步 assistant 消息(工具调用参数需以 JSON 字符串回传;
        // DeepSeek v4 思考模式下,reasoning_content 必须随历史原样回传,否则 400)
        const assistantMsg = {
          role: 'assistant',
          content: res.content || '',
          tool_calls: (res.toolCalls || []).map((t) => ({
            id: t.id, type: 'function',
            function: { name: t.name, arguments: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments) }
          })),
          ...(res.reasoning ? { reasoning_content: res.reasoning } : {})
        };
        session.append('assistant/message', { turn, step, message: assistantMsg });

        // 模型不再请求工具:本轮自然结束
        if (!res.toolCalls || res.toolCalls.length === 0) {
          finalText = res.content || '';
          session.append('step/end', { turn, step });
          break;
        }

        // 串行执行工具调用(顺序与模型请求一致,结果紧跟对应的 assistant(tool_calls))
        for (const tc of res.toolCalls) {
          if (signal.signal.aborted) throw new Error('已停止');
          const rawArgs = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);
          let pretty = rawArgs;
          try { pretty = JSON.stringify(JSON.parse(rawArgs), null, 2); } catch {}
          this.emit('agent', { event: 'tool_call', tool: tc.name, args: pretty, callId: tc.id, sid: runSessionId });
          session.append('tool/call', { turn, step, callId: tc.id, name: tc.name, arguments: rawArgs });

          const r = await registry.execute({ name: tc.name, args: rawArgs, signal: signal.signal, invokeCtx });
          session.append('tool/result', {
            turn, step, callId: tc.id, name: tc.name,
            isError: r.isError, content: storeCap(r.content), ms: r.ms
          });
          const short = r.content.length > 4000 ? r.content.slice(0, 4000) + `\n…[结果较多,已折叠展示 ${r.content.length} 字符]…` : r.content;
          this.emit('agent', { event: 'tool_result', tool: tc.name, ok: !r.isError, ms: r.ms, result: short, callId: tc.id, sid: runSessionId });
        }

        session.append('step/end', { turn, step });
        if (step === maxIters) {
          endReason = { kind: 'max-iters' };
          this.emit('agent', { event: 'notice', text: `已达单轮最大工具迭代次数(${maxIters}),请把任务拆小继续`, sid: runSessionId });
        }
      }

      this.emit('agent', { event: 'done', text: finalText, iters: stepsUsed, sid: runSessionId });
    } catch (e) {
      if (signal.signal.aborted) {
        endReason = { kind: 'aborted' };
        this.emit('agent', { event: 'stopped', sid: runSessionId });
      } else {
        endReason = { kind: 'error', error: String(e.message || e) };
        this.emit('log', 'error', `Agent 错误: ${e.message}`);
        this.emit('agent', { event: 'error', message: e.message, sid: runSessionId });
      }
    } finally {
      // 自愈:给中止时未闭合的工具调用补结果,保证日志重放出的消息序列永远合法
      for (const c of session.pendingToolCalls()) {
        session.append('tool/result', {
          turn: c.turn, step: c.step, callId: c.callId, name: c.name,
          isError: true, content: '工具执行中止(本轮已停止)', ms: 0
        });
      }
      session.append('turn/end', { turn, reason: endReason });
      // 本轮结束仍未消费的注入转入下一轮输入(非中止时),不丢用户消息
      if (endReason.kind !== 'aborted') {
        for (const s of rt.steer.splice(0)) rt.inbox.push(s);
      }
      if (runSessionId) {
        sessions.saveEvents(runSessionId, session.events); // 落盘,重启后可恢复
        this.emit('agent', { event: 'sessions_changed' }); // 后台会话结束也刷新前端会话列表
      }
    }
  }

  _systemPrompt(reasoning = 'default') {
    const ws = ssh.workspace || '(未设置,请提示用户在界面中选择工作区)';
    // 推理等级:off 关闭思考(直答);xhigh/max 深度推理;其余按默认格式输出
    const thinkingRule = reasoning === 'off'
      ? '7. 输出格式:直接给出结论与操作,不要输出 thinking 代码块,不要展示任何推理过程。'
      : (reasoning === 'xhigh' || reasoning === 'max')
        ? '7. 输出格式:先在 ```thinking(...```) 代码块中进行充分、系统的深度推理(允许较长,逐步分析再下结论),再在正文给出结论与操作;复杂任务务必先想清楚再动手。'
        : '7. 输出格式:任何推理过程请放在 ```thinking(...```) 代码块中(前端会折叠),不要污染正文;正文只给结论与操作。';
    const lines = [
      '你是运行在远程服务器上的 AI 编程助手,通过工具在远程 ssh 服务器上真实地读写文件与执行命令。',
      `远程平台: ${ssh.platform || '未知'}`,
      `工作区: ${ws}`,
      '',
      '规则:',
      '1. 所有文件读写、命令执行都必须通过工具完成,严禁编造文件内容或命令输出;看不到的结果就再查。',
      '2. 命令默认在工作区目录下执行;若需切换目录,请在命令开头显式写 cd。',
      '3. 大文件用 read_file 的 offset/maxBytes 分片读取;修改文件优先 edit_file 精确替换。',
      '4. 写/改/删仅限工作区内;绝不能删除工作区根目录;破坏性命令(rm -rf、drop table 等)必须三思。',
      '5. 重要:对话历史里已有的环境信息与目录结构(如之前的 get_workspace_info / list_directory 结果)可以直接复用,不要重复探测环境;只有任务涉及变化(新文件、需验证结果)时才重新调用。',
      '6. 回答使用用户的提问语言(默认中文)。',
      thinkingRule,
      '8. 任务规划:开始复杂的多步任务前,先用 todo_write 建立任务计划(每个具体步骤一项),每完成一项立即标记 completed 并推进下一项;简单单步任务可跳过计划。',
      '',
      '当用户指令不明确、或工作区缺乏必要信息时,主动调用工具检查,而不是猜测。'
    ];
    // 技能目录(照搬 harness 的 skill catalog 注入):有可用技能时提示模型按需加载
    const skillCatalog = renderSkillCatalog(getSkillsCatalog());
    if (skillCatalog) lines.push('', skillCatalog);
    // 全局指令注入(移植自 dsh-purge):用户自定义的 prompt-inject.md 作为强指令注入
    const inject = renderPromptInjectSection();
    if (inject) lines.push(inject);
    // 纯对话模式(模型不支持工具):明示能力边界,避免模型谎称已执行操作
    if (this._chatOnly) {
      lines.unshift(
        '注意:当前模型不支持工具调用(纯对话模式)。你无法实际读写远程文件或执行命令,',
        '也不要声称执行了任何操作;请基于已有信息给出文字回答,并提醒用户换支持工具的模型来获得完整能力。'
      );
    }
    // 注入最近一次环境探测结果,让模型直接复用,避免每轮重复 get_workspace_info
    const env = getEnvInfo();
    if (env && env.workspace === ssh.workspace) {
      lines.push('', '已知环境信息(来自最近一次探测,若无变化直接使用,无需重复调用 get_workspace_info):');
      lines.push(env.summary);
    }
    return lines.join('\n');
  }
}

export const agent = new Agent({
  emit: (event, payload) => agentHub?.emit(event, payload)
});

// 由 ws 层注入
export let agentHub = null;
export function setAgentHub(h) { agentHub = h; }
