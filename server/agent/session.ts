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
//     assistant/message {turn, step, message, usage?}  模型回复(含 tool_calls / reasoning_content;usage 为四桶用量)
//     tool/call        {turn, step, callId, name, arguments}   模型请求的工具调用(arguments 保持原始 JSON 字符串)
//     tool/result      {turn, step, callId, name, isError, content, ms, meta?, attachments?} 工具执行结果
//     todo/write       {todos:[{content,status}]}              任务计划整表快照(todo_write 工具写入)
//     deliverable/presented {files:[{path,description}]}        成果物交付声明(present 工具写入;并入前一条 assistant,不占消息面)
//     image/generated  {turn,step,mode,prompt,attachments,…}   生图模型一轮成图(仅前端投影,非消息面)
// - turn/*、step/* 是结构边界,不投影为消息;user/message、assistant/message、
//   tool/result 三类是"消息面",deriveMessages() 只看它们。
// - todo/write 是会话状态而非消息(参照 harness 的 sessionProjections):
//   foldTodos() 折叠出"当前计划"——最新一次 todo/write 的整表:未完成的计划跨 turn/start
//   存活(turn/end 从不清空),面板因此一直显示,模型也接着同一份计划继续做(剩余计划随
//   新一轮指令送达,见 agent.ts 的 planCarryBlock);只有已全部完成的计划才在新一轮作废。

/**
 * 一条 user/message 的来源归属(对齐 dsh 的 MessageSource)。
 *
 * - **字符串**(老口径,保持不动):内部原因,如 'user' / 'steer' / 'runtime' / 'auto-resume'
 *   / 'goal' / 'schedule' / 'compaction' / 'subagent-settled'。
 * - **对象**(dsh 的完整归属):`kind` 决定这一行画什么图标与标题;`form` 决定**怎么渲染** ——
 *   `'notice'` = "刚发生了什么"的通知行(折叠行是标题 + 一行 `summary`,展开才是模型可见正文),
 *   `**不是**用户气泡;`senderSessionId` 是产出这条消息的会话(子代理 / 另一个 agent)。
 *
 * 为什么要有对象形态:通知类消息是**运行时替子代理说的话**,与"用户打的字"必须区分开
 * (dsh 的原话:把两者合并会替子代理认领它从未说过的话),前端也因此不能把它渲染成用户气泡。
 */
export type MessageSource = string | {
  readonly kind: string;
  readonly form?: string;
  /** 折叠行上的一行账(dsh 的 SubagentSettledMessageSource.summary) */
  readonly summary?: string;
  /** 产出这条消息的会话(子代理 id / 另一个 agent 的 id) */
  readonly senderSessionId?: string;
};

/** 取来源的 kind(字符串来源就是它本身;无来源 = '') */
export function sourceKind(source: MessageSource | null | undefined): string {
  if (!source) return '';
  return typeof source === 'string' ? source : String((source as any).kind || '');
}

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

/**
 * 声明了 tool_calls、却没有拿到任何结果的工具调用,在**模型可见面**上补的占位结果。
 * 只存在于投影结果里,日志与前端显示面都不写这条(前端按真实事件渲染工具卡片)。
 * 用途见 deriveMessagesWithTrace:严格网关要求 assistant 的每个 tool_call_id 都被随后的
 * tool 消息应答,否则整次请求 400,且重试永远不会好。
 */
export const UNANSWERED_TOOL_RESULT =
  '（本次工具调用没有返回结果:响应流被中断或本轮在它执行完成前就结束了。'
  + '请视作调用失败;需要该结果时重新发起调用。）';

export interface SessionEventDataMap {
  'turn/start': { turn: number };
  'turn/end': { turn: number; reason: { kind: string; [k: string]: any } };
  'step/start': { turn: number; step: number };
  'step/end': { turn: number; step: number };
  'user/message': { content: string; source: string };
  'assistant/message': {
    turn: number; step: number; message: LlmMessage;
    /**
     * 本步的提供方用量(四桶:未命中输入/输出/缓存读/缓存写),由 llm.ts 归一。
     * 与 assistant 消息同条落盘,因为"模型输出"与"它的记账"必须一起走 ——
     * 日志里没有第二条 usage 记录,foldTokenUsage 才能原样重建整个会话的用量与缓存命中率。
     * 提供方不报用量时**缺席**(不是零值),因此旧数据/不报用量的网关都不会被算成 0 命中。
     */
    usage?: { uncachedInputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
    /**
     * 本步首个 token 到达的绝对时刻(ms)。落盘理由:统计栏的「首 token 延迟」与
     * 「解码速度」必须能从日志重算 —— 只在内存里记"什么时候收到第一个 delta",
     * 刷新/切会话后就永久丢失了这两项(对齐 harness 把首 token 时间放进事件数据的做法)。
     * 一个 token 都没出时缺席,统计时按"该步不计入 TTFT"处理,而不是记 0。
     */
    firstTokenTime?: number;
  };
  'tool/call': { turn: number; step: number; callId: string; name: string; arguments: string };
  'tool/result': {
    turn: number; step: number; callId: string; name: string; isError: boolean; content: string; ms: number;
    /** 结构化 UI 数据(终端卡 exitCode/cwd、浏览器卡 state、截图卡 screenshot 等);不进模型上下文 */
    meta?: Record<string, any>;
    /**
     * 该工具产出的图片等附件(服务端元数据,字节在附件库、这里只有 id)。
     * 与 image/generated 的 attachments 同字段名同形状,前端用同一套
     * MessageAttachments 渲染,使截图类工具的产物在对话里直接可见。
     */
    attachments?: Array<Record<string, any>>;
  };  'todo/write': { todos: Array<{ content: string; status: string }> };
  /**
   * 已交付的成果物(模型通过 present 工具显式声明)。
   *
   * 与"文件改动"是**两件不同的事**,这也是本工具存在的理由:
   *   - 文件改动(tool/result 的 card='diff')是**观察事实** —— 工作区里哪些文件被改了,
   *     由宿主自动汇总,可能包含模型从未提及的文件;
   *   - 成果物是**交付意图** —— 模型明确说"这些是给你用的最终产物",还带一句人类可读的说明。
   * 二者互补:前者回答"改了什么",后者回答"交给你什么"。
   *
   * 只记路径与说明,**不复制内容**(内容仍在原路径;复制会产生"桌面端改的和工作区不一致"这类问题)。
   * 投影时并入前一条 assistant 消息,因此**不占消息面下标**,不影响回退/分支/删除。
   */
  'deliverable/presented': {
    files: Array<{ path: string; description?: string }>;
  };
  'compaction/done': { summary: string; dropCount?: number; manual?: boolean };
  /**
   * 压缩未完成(摘要生成失败 / 被停止 / 无收益)。压缩是"上下文治理事件",失败同样要留在
   * 记录里:projectEvents 把它投影成一行安静的「上下文压缩 · 未完成(原因)」,刷新/切回会话
   * 后仍在。它与 notice 的区别:不是给用户的告警,不弹提示;同样只进显示面、不进模型上下文。
   */
  'compaction/failed': { reason?: string; manual?: boolean };
  /**
   * 对话流里的可见提示行(⚠)。属于"显示面"而非"消息面":projectEvents 投影给前端渲染,
   * deriveMessages 不投影——提示是给用户看的,绝不能作为 user/assistant 消息发给模型。
   * 落在日志里而不是只广播一次:刷新/切走再切回/继续对话后,这条提示仍在原位置可见。
   */
  'notice': { text: string; level?: 'info' | 'warn'; kind?: string };
  /**
   * 一次模型请求失败后进入重试的记录。同样只进显示面、不进模型上下文:
   * 重试是传输层事件,模型不需要也不知道自己刚才重试过(重复的失败原文只会污染上下文)。
   */
  'llm/retry': {
    retry: number; maxRetries: number; delayMs: number;
    error?: string; discard?: boolean;
    /** 该次重试最终的状态:started=已开始重试 / cancelled=被停止或彻底失败 */
    state?: 'started' | 'cancelled';
  };
  /**
   * 生图模型(imageGen)的一轮成图记录。字节不进日志(与图片附件同规则,只存元数据 id),
   * 由前端投影为 assistant 气泡的 attachments,并可被后续轮次取回作为图生图参考图。
   * 本事件不属于"消息面"(deriveMessages 不投影它):图像端点只吃单个 prompt 字符串、
   * 不吃消息历史,生图轮之间不存在模型侧上下文。
   */
  'image/generated': {
    // 生图对话旁路会带轮次编号;generate_image 工具在工具上下文里拿不到 turn/step,故可选
    turn?: number; step?: number;
    /** 本轮实际走的通路:t2i=文生图(generations),i2i=图生图/改图(edits) */
    mode: 't2i' | 'i2i';
    /** 提交给图像端点的最终提示词(排查与复现用) */
    prompt: string;
    /** 成图的服务端元数据(与附件索引同构,前端按 attachments 渲染) */
    attachments: Array<Record<string, any>>;
    /** 作为参考图送出的张数(i2i 时 >0) */
    refs?: number;
    /** 上游回显的实际尺寸(部分网关忽略请求的 size) */
    size?: string;
    /** 上游回显的实际模型名(网关可能别名路由) */
    upstreamModel?: string;
    /** 生成耗时(ms) */
    ms?: number;
  };
}

/** 任务计划整表快照(todo/write 的载荷;foldTodos 的返回类型) */
export type TodoSnapshot = Array<{ content: string; status: string }>;

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
  /** 这份日志是"用户主动截断"的分支切片(见 Agent.forkSession):尾部未闭合的轮次静默收尾,不写崩溃披露 */
  private _forkCut = false;
  /** 本次构造是否自愈出一个"非正常结束"的轮次(进程中途消失)。上层据此决定要不要自动续跑 */
  healedUncleanTurn = false;
  /** 被自愈的那个未闭合轮,本身是不是"自动续跑"发起的(是则不能再续,防死循环) */
  openTurnStartedByAutoResume = false;

  constructor(events: SessionEvent[] = [], opts: { forkCut?: boolean } = {}) {
    // 载入/迁移的事件统一按位置重排 seq;time 缺失时补当前时间
    this.events = (events || [])
      .filter((ev: any) => ev && ev.type && ev.data && typeof ev.data === 'object')
      .map((ev: any, i: number) => ({ seq: i, time: ev.time ?? Date.now(), type: ev.type, data: ev.data }));
    this._forkCut = !!opts.forkCut;
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
   * 未闭合的工具调用。两类都要报,否则收尾自愈会漏掉一半:
   * 1) 有 tool/call 无 tool/result(执行中被打断);
   * 2) **assistant 声明了 tool_calls 却没有任何 tool/call 事件** —— 响应流被截断时工具
   *    根本不会开始执行(见 agent 的 truncated 分支),并行池被中止时后面的调用也没启动
   *    (agent._runToolCalls 里"未启动的调用不产生 tool/call 事件")。只按 tool/call 统计
   *    会漏掉它们,日志里就留下"assistant 声明了调用但没有任何 tool 消息"的尾巴——
   *    严格网关(agent 的每一次后续请求)都会 400:
   *    An assistant message with 'tool_calls' must be followed by tool messages responding
   *    to each 'tool_call_id'. (insufficient tool messages following tool_calls message)
   * 配对语义与 _heal 一致:user/压缩摘要作废未消费的 id;一个 id 只被一条结果消费。
   * 只报"日志尾部仍未闭合"的声明(中间被 user 消息截断的那批由投影层补占位,不在尾部补写,
   * 否则补出来的 tool 消息会落在 user 之后,反而制造非法序列)。
   */
  pendingToolCalls(): any[] {
    const pending = new Map(); // callId -> {turn,step,callId,name}(有 tool/call、无 tool/result)
    let declared = new Map();  // 最近一条 assistant 声明、尚未被结果消费的调用
    for (const ev of this.events) {
      const d = ev.data || {};
      if (ev.type === 'user/message' || ev.type === 'compaction/done') {
        declared = new Map(); // user / 摘要之后工具 id 失效
      } else if (ev.type === 'assistant/message') {
        declared = new Map();
        const m = d.message || {};
        for (const t of (Array.isArray(m.tool_calls) ? m.tool_calls : [])) {
          if (!t || !t.id) continue;
          declared.set(t.id, { turn: d.turn, step: d.step, callId: t.id, name: t.function?.name });
        }
      } else if (ev.type === 'tool/call') {
        pending.set(d.callId, d);
      } else if (ev.type === 'tool/result') {
        pending.delete(d.callId);
        declared.delete(d.callId);
      }
    }
    for (const [id, info] of declared) {
      if (!pending.has(id)) pending.set(id, { ...info, neverStarted: true });
    }
    return [...pending.values()];
  }

  /**
   * 投影出 OpenAI 兼容的 LLM 消息历史(不含 system):
   * - user/message -> user 消息
   * - assistant/message -> assistant 消息;空内容且无 tool_calls 的跳过
   *   (max-tokens 截断等"无产出"的请求不进入下一份请求)
   * - tool/result -> tool 消息(紧跟带对应 tool_calls 的 assistant 之后)
   * - compaction/done -> user 摘要消息(非破坏压缩检查点:seq ≤ dropThroughSeq 的
   *   早期消息面事件在模型面被摘要顶替,但日志/前端显示仍完整保留)
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
    // 生效压缩检查点 = 日志中最后一条带 dropThroughSeq 的 compaction/done(非破坏压缩:
    // 早期消息仍完整保留在日志里,只是模型面不可见——压缩只削切"可见起点",不删除数据;
    // 前端显示投影 projectEvents 始终完整,刷新后历史完整可回看)。
    // dropThroughSeq = 被压缩区间最后一条消息面事件的 seq,投影时其及更早的消息面事件
    // 跳过(内置前缀区间性质:跳过 [0, dropThroughSeq] 恰好等价于丢弃被压的前缀),
    // 并以摘要 user 消息顶替(序列以 user 开头、工具配对完整);更早的检查点一并被覆盖。
    let cp: { summary?: string; dropThroughSeq?: number; dropCount?: number; manual?: boolean } | null = null;
    let cpSeq = -1;
    for (const ev of this.events) {
      if (ev.type === 'compaction/done' && typeof ev.data?.dropThroughSeq === 'number') {
        cp = ev.data;
        cpSeq = ev.seq;
      }
    }
    // 待消费的 tool_call id(最近一条带 tool_calls 的 assistant 声明的,OpenAI 配对语义)。
    // 两件事都在投影期兜住,否则严格网关(litellm 等)会以
    // 「An assistant message with 'tool_calls' must be followed by tool messages responding
    //   to each 'tool_call_id'. (insufficient tool messages following tool_calls message)」400 拒收:
    //  1) 孤儿 tool/result(前面没有声明的 tool_calls)不投影 —— 构造时自愈(_heal)能清掉落盘
    //     损坏,但运行中会话(旧版压缩/日志错位产生的孤儿仍驻内存)也必须保证序列合法;
    //  2) 声明了却没有结果的 tool_call 必须补一条占位 tool 消息(见 flushUnanswered)——
    //     响应流被截断(工具根本没执行)、中止发生在并行池启动前(只声明未执行)、结果与声明
    //     之间被插入了一条 user 消息……这些历史都会让"按 id 配对"少一条 tool 消息,而网关按
    //     条数校验,于是**每次请求**都被 400 拒(重试再多次也不会好)。
    // pendingIds 保留模型声明的顺序(占位消息按该顺序补,id 重复也逐条补足)。
    let pendingIds: string[] = [];
    let pendingSet = new Set<string>();
    let pendingSeq = -1; // 声明这批调用的 assistant 事件 seq(占位消息沿用它,便于压缩区间映射)
    const resetPending = (ids: string[], seq: number) => {
      pendingIds = ids;
      pendingSet = new Set(ids);
      pendingSeq = seq;
    };
    // 全量结果索引:声明了却没有结果的调用,若日志里存在它的结果(只是位置错位),
    // 用真实内容顶替占位文案,避免白白丢掉工具输出。
    const resultByCall = new Map<string, any>();
    for (const ev of this.events) {
      if (ev.type === 'tool/result' && ev.data?.callId) resultByCall.set(ev.data.callId, ev.data);
    }
    const flushUnanswered = () => {
      for (const id of pendingIds) {
        const r = resultByCall.get(id);
        traced.push({
          seq: pendingSeq,
          msg: {
            role: 'tool',
            tool_call_id: id,
            content: r ? String(r.content ?? '') : UNANSWERED_TOOL_RESULT
          }
        });
      }
      pendingIds = [];
      pendingSet = new Set();
    };
    // 摘要 user 消息的插入时机:进入保留区第一个消息面事件之前。插摘要时清空 alive,
    // 与 user/message 同语义(摘要之后的 tool/result 不能依赖摘要之前的 tool_calls——
    // 切点已对齐"工具配对完整",这里只是安全冗余)。
    let cpPlaced = !cp;
    const placeCp = () => {
      flushUnanswered(); // 摘要 user 消息同样会作废前面的待应答调用:先补占位再落摘要
      traced.push({ seq: cpSeq, msg: { role: 'user', content: cp?.summary || '【上下文已自动压缩】早期对话已省略。' } });
      cpPlaced = true;
    };
    // computer-use 等工具可以把"刚截取的画面"作为图片附件回传给模型看:
    // tool 角色消息在 OpenAI 兼容协议里只能带文本,图片必须另起一条 user 消息。
    // 但 tool/result 与 assistant tool_calls 必须严格配对,而 user 消息会清空 pending,
    // 所以先缓存,等同一条 assistant 声明的全部工具结果都投影完(pending 清空)再插入。
    let pendingVision: any[] = [];
    let visionCaption = '';
    let visionSeq = -1;
    const flushVision = () => {
      if (!pendingVision.length) return;
      traced.push({
        seq: visionSeq,
        msg: { role: 'user', content: visionCaption || '以下是当前屏幕画面。', attachments: pendingVision }
      });
      pendingVision = [];
      visionCaption = '';
    };
    for (const ev of this.events) {
      const d = ev.data || {};
      switch (ev.type) {
        case 'user/message':
          if (cp && ev.seq <= (cp.dropThroughSeq ?? -1)) continue; // 被压缩:模型面不可见
          if (!cpPlaced) placeCp();
          flushUnanswered(); // user 之前先把未应答的工具调用补齐(顺序:tool 消息必须在 user 之前)
          resetPending([], -1); // user 之后工具 id 失效
          traced.push({
            seq: ev.seq,
            msg: {
              role: 'user',
              content: d.content,
              // 附件元数据(图片/文件/视频)随消息携带:agent 在请求期把图片升级为
              // image_url 内容段(仅多模态模型);content 本身保持字符串,便于裁剪/压缩
              ...(Array.isArray(d.attachments) && d.attachments.length ? { attachments: d.attachments } : {})
            }
          });
          break;
        case 'assistant/message': {
          if (cp && ev.seq <= (cp.dropThroughSeq ?? -1)) continue;
          if (!cpPlaced) placeCp();
          const m = d.message || {};
          const hasCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
          if (!m.content && !hasCalls) break;
          flushUnanswered(); // 上一条 assistant 声明的调用若没被应答,先补占位(必须落在本条之前)
          if (pendingVision.length) flushVision(); // 视觉附件消息必须落在完整工具配对之后
          resetPending(hasCalls ? m.tool_calls.map((t: any) => t.id) : [], ev.seq);
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
          if (cp && ev.seq <= (cp.dropThroughSeq ?? -1)) continue;
          if (!cpPlaced) placeCp();
          // 孤儿 tool/result(无前置 assistant tool_calls):跳过,不进入模型可见面
          if (!pendingSet.has(d.callId)) break;
          // 只消费一条声明:同一条 assistant 里 id 重复时(网关偶发)按**条数**配对,
          // 网关也是按条数校验的,少一条就是 400 insufficient tool messages
          pendingIds.splice(pendingIds.indexOf(d.callId), 1);
          pendingSet = new Set(pendingIds);
          traced.push({ seq: ev.seq, msg: { role: 'tool', tool_call_id: d.callId, content: d.content } });
          // 带图片附件的工具结果(如 computer_screenshot):缓存视觉 user 消息,等工具配对完整后插入
          const visionAtt = (d.meta as any)?.visionAttachments;
          if (Array.isArray(visionAtt) && visionAtt.length) {
            pendingVision = visionAtt;
            visionCaption = String((d.meta as any)?.visionCaption || '');
            visionSeq = ev.seq;
          }
          if (pendingSet.size === 0) flushVision();
          break;
        case 'compaction/done':
          // 旧版破坏式压缩遗留(无 dropThroughSeq,早期消息已被物理删除):原位投影摘要
          // user 消息维持旧行为;新版检查点由 placeCp 统一插入,这里只忽略不重复投影。
          if (!cp) {
            flushUnanswered(); // 同上:摘要 user 消息之前补齐待应答调用
            resetPending([], -1); // 压缩摘要 user 消息:工具 id 失效(与 user/message 同语义)
            traced.push({
              seq: ev.seq,
              msg: { role: 'user', content: d.summary || '【上下文已自动压缩】早期对话已省略。' }
            });
          }
          break;
        default:
          break; // turn/*、step/* 等结构事件不投影
      }
    }
    flushUnanswered(); // 收尾:日志尾部仍有未应答的工具调用(截断/中止/日志错位)时补占位
    if (pendingVision.length) flushVision();
    if (!cpPlaced) placeCp(); // 兜底:压缩后保留区没有消息面事件(理论上不会发生)时摘要收尾
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
   * 非破坏压缩:在日志尾部追加一条 compaction/done 压缩检查点,记录
   * "seq ≤ dropThroughSeq 的消息面事件在模型面已被摘要取代"。
   * 与 squash 的本质区别:被压缩的早期事件**完整保留**在日志里——
   * 前端显示投影(projectEvents)与刷新后的历史回放始终完整,
   * 只有模型历史投影(deriveMessagesWithTrace)按检查点跳过早期消息。
   * dropSeqs 为被压缩消息面的前缀 seq(升序,来自 deriveMessagesWithTrace 的 trace
   * 投影);多次压缩时后一个检查点覆盖前一个(取日志最后一条生效)。
   * meta 可选:手动/自动调用方借此携带 dropCount、manual 标记。
   */
  markCompacted(dropSeqs: number[] | string[], summary: string, meta?: { dropCount?: number; manual?: boolean }): SessionEvent {
    const nums = dropSeqs.map(Number).filter((n) => Number.isFinite(n));
    const dropThroughSeq = nums.length ? Math.max(...nums) : null;
    const data = { summary, ...(meta || {}) };
    // dropThroughSeq 必须存在:它既是检查点生效标志,也是模型面跳过阈值。
    // 缺消息面 seq(理论上不发生)时退化为纯摘要记事件、不跳过任何消息。
    if (dropThroughSeq != null) (data as any).dropThroughSeq = dropThroughSeq;
    const ev = this.append('compaction/done', data as any);
    return ev;
  }

  /**
   * 构造载入时的日志自愈:
   * 1) 移除"孤儿工具事件"——无前置 assistant tool_calls 声明的 tool/call 与 tool/result。
   *    旧版行内压缩(squash)只删投影事件、漏删 tool/call 结构事件,轮末自愈又为残留的
   *    tool/call 补了"中止"结果,落盘后就形成这类孤儿;它们投影出"无前置 assistant 的
   *    tool 消息",严格提供商会 400。此处一次性清掉,保证日志永远可安全回放。
   * 2) 仍未闭合的工具调用(进程崩溃/被杀的遗留)补一条"中止"结果。
   * 3) 仍未闭合的轮次(进程被杀/开发模式热重启/断电:turn/start 之后没有 turn/end)
   *    补一条可见披露并闭合它(见 _healOpenTurn)。
   * 说明:只有"从磁盘载入"的会话会走到这里 —— 运行中的会话始终在内存里、由 _runTurn
   * 正常收尾,所以不会把正在流式的轮次误判成异常结束。
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
    this._healOpenTurn();
  }

  /**
   * 未闭合轮次的自愈:补一条可见披露 + turn/end。
   * 场景:服务进程在生成中途被杀/热重启(如 npm run dev 监听 server/ 变更)/断电。
   * 此时磁盘上只有 turn/start 与已经落盘的 user/message,没有 turn/end —— 不补的话这一轮
   * 在对话里"不存在":用户看到的是对话毫无征兆地停住,连自己发的那句话都没了。
   * 例外:分支切片(forkCut)是用户主动选的切点——forkSession 按消息面下标截断,切点常落在
   * 某轮中间,尾部本就没有 turn/end。它不是异常退出,只静默补 turn/end,不写崩溃披露;
   * 否则点任意一条消息的「在新对话中分支」,分支会话里都会凭空多出一条「上一轮对话没有正常结束」。
   */
  _healOpenTurn(): void {
    let open: { turn: number } | null = null;
    let openIdx = -1; // 未闭合轮的 turn/start 下标:据此判断这一轮是不是"自动续跑"发起的
    for (let i = 0; i < this.events.length; i++) {
      const ev = this.events[i];
      if (ev.type === 'turn/start') { open = { turn: Number(ev.data?.turn) || 0 }; openIdx = i; }
      else if (ev.type === 'turn/end') open = null;
    }
    if (!open) return;
    if (!this._forkCut) {
      // 未闭合的这一轮里若已经有"自动续跑"注入的指令,说明上一轮也是被自动续跑的 —— 再续一次
      // 就会形成「崩溃 → 续跑 → 再崩 → 再续跑」的死循环,所以记下来让上层放弃续跑。
      this.openTurnStartedByAutoResume = this.events
        .slice(openIdx)
        .some((e) => e.type === 'user/message' && e.data?.source === 'auto-resume');
      this.append('notice', {
        text: '上一轮对话没有正常结束:服务进程在生成中途退出或被重启(例如开发模式的热重启),'
          + '本轮已落盘的输入保留在上方,生成到一半的内容可能未能落盘。直接继续或重新发送即可。',
        level: 'warn', kind: 'unclean-shutdown'
      });
      this.healedUncleanTurn = true;
    }
    this.append('turn/end', {
      turn: open.turn,
      reason: this._forkCut
        ? { kind: 'aborted', cause: 'fork' }
        : { kind: 'interrupted', cause: 'unclean-shutdown' }
    });
  }
}

/** 计划中是否还有未完成项(pending / in_progress);空清单视为无待办 */
export function hasOutstandingTodos(todos: TodoSnapshot | null | undefined): todos is TodoSnapshot {
  return Array.isArray(todos) && todos.length > 0 && todos.some((t) => t?.status !== 'completed');
}

/**
 * 折叠事件日志得到"当前任务计划"(参照 harness 的 todos 投影):
 * 最新一次 todo/write 的整表即当前计划。turn/end 从不清空——本轮跑完的清单保持可见;
 * turn/start 只作废"已全部完成"的计划,仍有未完成项的计划跨轮存活,于是用户接着发
 * 消息时面板不消失、模型也接着同一份计划继续做(剩余计划由 agent.ts 拼进新指令)。
 * @returns 当前计划(无则 null)
 */
export function foldTodos(events: SessionEvent[]): TodoSnapshot | null {
  let todos: TodoSnapshot | null = null;
  for (const ev of events || []) {
    if (ev?.type === 'todo/write') todos = Array.isArray(ev.data?.todos) ? ev.data.todos : null;
    else if (ev?.type === 'turn/start' && !hasOutstandingTodos(todos)) todos = null;
  }
  return todos;
}

/** 整个会话的累计用量(四桶)与派生指标 */
export interface SessionUsageTotals {
  /** 未命中缓存的输入 token */
  uncachedInputTokens: number;
  /** 输出 token(已含推理) */
  outputTokens: number;
  /** 命中缓存读取的输入 token */
  cacheReadTokens: number;
  /** 写入缓存的输入 token */
  cacheWriteTokens: number;
  /** 有上报用量的步数(便于判断"命中率"是否有样本,而不是 0/0) */
  samples: number;
}

/** 只用四个桶(不含 samples):foldTokenUsage 内部记录"上一条样本贡献"用 */
type UsageBuckets = Omit<SessionUsageTotals, 'samples'>;

/**
 * 折叠事件日志得到**整个会话**的累计用量(参照 harness 的 tokenUsage 投影)。
 *
 * 为什么 fold 而不是内存累加:会话切换/进程重启/刷新后从磁盘重放,必须得到同一个数;
 * 也只有 fold 才能让"缓存命中率"在任意时刻可重算。
 *
 * 去重语义(照搬 harness usage-projection):
 *  - **同一个 (turn, step) 只用最后一次样本**:流式中间样本会被本条消息的最终样本替换。
 *    实现上是"先减掉该 (turn,step) 上一次贡献的桶,再加上新的",而不是简单累加 ——
 *    否则同一步的流式样本与最终样本会被重复计费。
 *  - **重试计费**:同一步里若换了 Key/重试,该步会**产生多条 assistant/message**
 *    (每条都是上游真实计费的一次尝试)。上一条已经把桶压平,所以减掉它再加新的,
 *    净效果就是"每次尝试各计一次" —— 与 harness 的 llm/retry-started 语义一致。
 *  - 没有 usage 的事件(提供方不报、旧数据)不参与累计,**不会被当成 0 命中样本**。
 *
 * @param events 会话事件日志
 * @returns 四桶累计 + 有样本的步数
 */
export function foldTokenUsage(events: SessionEvent[]): SessionUsageTotals {
  const zero = (): SessionUsageTotals => ({
    uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, samples: 0
  });
  const totals = zero();
  // 上一条带用量的 (turn,step) 及其贡献 —— 同键再来时先减掉它
  let lastKey = '';
  let last: UsageBuckets | null = null;

  for (const ev of events || []) {
    if (ev?.type !== 'assistant/message') continue;
    const u = ev.data?.usage;
    // 形状校验:缺失或字段非法都按"这条没有用量"处理,而不是补 0(补 0 会污染命中率分母口径)
    if (!u || typeof u !== 'object') continue;
    const buckets: UsageBuckets = {
      uncachedInputTokens: Number(u.uncachedInputTokens) || 0,
      outputTokens: Number(u.outputTokens) || 0,
      cacheReadTokens: Number(u.cacheReadTokens) || 0,
      cacheWriteTokens: Number(u.cacheWriteTokens) || 0
    };
    const key = `${ev.data?.turn ?? ''}:${ev.data?.step ?? ''}`;
    // 同一个 (turn,step) 的重复样本:先减掉上一次的贡献(替换而非累加)
    if (last && key === lastKey) {
      totals.uncachedInputTokens -= last.uncachedInputTokens;
      totals.outputTokens -= last.outputTokens;
      totals.cacheReadTokens -= last.cacheReadTokens;
      totals.cacheWriteTokens -= last.cacheWriteTokens;
      totals.samples -= 1;
    }
    totals.uncachedInputTokens += buckets.uncachedInputTokens;
    totals.outputTokens += buckets.outputTokens;
    totals.cacheReadTokens += buckets.cacheReadTokens;
    totals.cacheWriteTokens += buckets.cacheWriteTokens;
    totals.samples += 1;
    lastKey = key;
    last = buckets;
  }

  // 防御:任何路径都不该产生负数,但上游脏数据(负数桶)可能击穿;夹住保证 UI 不会显示负值
  totals.uncachedInputTokens = Math.max(0, totals.uncachedInputTokens);
  totals.outputTokens = Math.max(0, totals.outputTokens);
  totals.cacheReadTokens = Math.max(0, totals.cacheReadTokens);
  totals.cacheWriteTokens = Math.max(0, totals.cacheWriteTokens);
  totals.samples = Math.max(0, totals.samples);
  return totals;
}

/**
 * 折叠**最后一次 turn/start 之后**的用量(单轮口径);供「每条回复的统计行」用。
 *
 * 与 foldTokenUsage 同一实现,只是切片起点是最后一个 turn/start —— 一轮内的步顺序
 * 没有被破坏,所以 (turn,step) 去重与重试计费语义完全一致(见 foldTokenUsage 的说明)。
 * 没有任何 turn/start 的日志(极端)则退化为整份日志口径。
 */
export function foldLastTurnTokenUsage(events: SessionEvent[]): SessionUsageTotals {
  const list = events || [];
  let start = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.type === 'turn/start') { start = i; break; }
  }
  return foldTokenUsage(list.slice(start));
}

/**
 * 整个会话的对话统计(照搬 harness 的 sessionStats 投影)。
 *
 * 为什么折叠整份日志而不是"只统计当前窗口":窗口是分页的,压缩还会改写它 ——
 * 只有对完整持久日志做 fold,数字才不会随翻页/压缩而变。
 */
export interface SessionStats {
  /** 有已闭合步的会话轮数(step/end 时轮号变化才 +1) */
  turns: number;
  /** 已闭合的步数(每个 step/end +1;**不是** assistant/message 条数:一步可能不产出消息) */
  steps: number;
  /** 模型墙钟时间之和:step/start → assistant/message,只算真assembled出消息的步 */
  llmMs: number;
  /** 工具墙钟时间之和:tool/call → 匹配的 tool/result(按 callId 配对) */
  toolMs: number;
  /** 首 token 延迟之和(step/start → 首 token) */
  ttftMs: number;
  /** 承载了首 token 的步数(TTFT 的平均值分母) */
  ttftSteps: number;
  /** 解码墙钟之和(首 token → assistant/message),只算同时报了输出 token 的步 */
  decodeMs: number;
  /** 与 decodeMs 同一批步的输出 token 之和(速度的分子;分母分子必须同源) */
  decodeTokens: number;
}

/**
 * 折叠事件日志得到整个会话的对话统计。
 *
 * 口径要点(每条都有理由,改动前请先读):
 *  - `steps` 用 `step/end` 计数,不用 `assistant/message`:一步可能没有产出消息
 *    (被中止、空响应),按消息数会漏;而 step/end 是步生命周期的唯一权威。
 *  - `llmMs` 只累加"真的组出了消息"的步:被中止的步没有 assistant/message,
 *    它的部分流时长不该混进模型耗时。
 *  - `toolMs` 按 `callId` 配对,**必须用 Object.hasOwn 判断**:callId 来自模型产出的
 *    JSON,可能是 `constructor`/`toString` 这类原型上的名字,直接索引会取到继承的函数,
 *    `time - 函数` = NaN,把整个 toolMs 污染成 NaN。
 *  - `decodeMs`/`decodeTokens` **必须同源**:只有既有首 token 又有输出 token 的步才同时累加,
 *    否则会把"等待工具的时间"算进解码速度,得出人为偏低的 tok/s。
 *  - 缺 `firstTokenTime` 的旧数据不参与 TTFT/速度(显示时那两行不出现),**不记 0**。
 *
 * 已知口径:toolMs 是各次调用耗时之**和**,不是墙钟等待时间 —— 工具池是并行的
 * (MAX_PARALLEL_TOOL_CALLS),同批并行工具会让它大于实际等待。UI 上应表述为
 * 「工具耗时(合计)」而不是「工具等待」。
 *
 * @param events 会话事件日志
 * @returns 统计结果(任何字段都从第一次贡献开始累加,无贡献为 0)
 */
export function foldSessionStats(events: SessionEvent[]): SessionStats {
  const stats: SessionStats = {
    turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0
  };
  let lastTurn: number | null = null;
  // 本步的边界事实;null = 不在步内或该步已结算
  let openStep: { turn: number; step: number; startTime: number; firstTokenTime: number | null } | null = null;
  // 已派发但结果还没到的工具调用(callId -> 派发时刻);用 Object.create(null) 避免原型链干扰
  let pendingCalls: Record<string, number> = Object.create(null);

  for (const ev of events || []) {
    const d = ev?.data || {};
    switch (ev?.type) {
      case 'step/start':
        openStep = { turn: d.turn, step: d.step, startTime: ev.time, firstTokenTime: null };
        break;

      case 'assistant/message': {
        const open = openStep;
        if (!open || open.turn !== d.turn || open.step !== d.step) break;
        // 该步只结算一次:闭合边界后重复消息不会再累加
        const firstToken = typeof d.firstTokenTime === 'number' && Number.isFinite(d.firstTokenTime)
          ? d.firstTokenTime : null;
        stats.llmMs += Math.max(0, ev.time - open.startTime);
        openStep = null;
        if (firstToken !== null) {
          stats.ttftMs += Math.max(0, firstToken - open.startTime);
          stats.ttftSteps += 1;
          const out = d.usage && typeof d.usage.outputTokens === 'number' && Number.isFinite(d.usage.outputTokens)
            ? d.usage.outputTokens : null;
          // 同源判定:有首 token 且有输出 token 才计入解码时长
          if (out !== null) {
            stats.decodeMs += Math.max(0, ev.time - firstToken);
            stats.decodeTokens += out;
          }
        }
        break;
      }

      case 'tool/call':
        pendingCalls[String(d.callId)] = ev.time;
        break;

      case 'tool/result': {
        const callId = String(d.callId);
        // 必须 Own 判定:见上面 callId 原型污染说明
        if (!Object.hasOwn(pendingCalls, callId)) break;
        const dispatched = pendingCalls[callId];
        delete pendingCalls[callId];
        if (typeof dispatched === 'number') stats.toolMs += Math.max(0, ev.time - dispatched);
        break;
      }

      case 'step/end':
        // 轮号与上一条不同才算新的一轮(轮号由宿主单调分配)
        if (lastTurn !== d.turn) { stats.turns += 1; lastTurn = d.turn; }
        stats.steps += 1;
        openStep = null;
        break;

      case 'turn/end':
        // 结果永远落在它自己的轮里;未落地的调用属于被中止的轮,丢弃而不是让状态无限增长
        if (Object.keys(pendingCalls).length) pendingCalls = Object.create(null);
        break;
    }
  }

  // 防御:上游脏时间戳不得产生负数
  for (const k of Object.keys(stats) as Array<keyof SessionStats>) stats[k] = Math.max(0, stats[k]);
  return stats;
}

// 按"对话组"裁剪的通用核心:超预算时从头部整组丢弃(一组 = 一条 user 到下一条 user 之前),// 保证剩余历史仍以 user 开头、assistant/tool_calls 配对完整。
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
      push('user/message', {
        content: String(m.content || ''),
        source: 'user',
        ...(Array.isArray(m.attachments) && m.attachments.length ? { attachments: m.attachments } : {})
      });
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
