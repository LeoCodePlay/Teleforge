// 共享类型定义:前后端 WebSocket 消息为动态结构,这里只描述前端使用到的关键形状

/**
 * 「不使用工作区」哨兵值(与 server/config.ts 的 NO_WORKSPACE 保持一致):
 * 作为 set_workspace / set_local_workspace 的 path 传入,表示该侧不绑定任何目录,
 * AI 的文件边界放宽到整台机器(本机 = 所有盘符,远程 = 整个远程文件系统)。
 */
export const NO_WORKSPACE = 'no-workspace';

/** 不使用工作区时的展示文案:本地侧 = 整台电脑,远程侧 = 整台服务器 */
export const WHOLE_LABEL = { local: '整台电脑', remote: '整台服务器' } as const;

/** 一条 SSH 连接(服务端多连接池中的一个) */
export interface ConnInfo {
  id: string;
  profileId: string | null;
  status: string; // disconnected | connecting | connected | reconnecting
  host: string | null;
  port: number | string | null;
  username: string | null;
  platform: string | null;
  home: string | null;
  workspace: string | null;
  /** 该连接是否处于「不在工作区对话」(全盘模式):为 true 时 workspace 必为 null */
  noWorkspace?: boolean;
  autoReconnect: boolean;
  reason?: string | null;
  retry?: number;
}

/** 已保存的 SSH 服务器配置(存于后端,切换浏览器共享;密码/密钥不下发) */
export interface SshProfileInfo {
  id: string;
  name: string;
  host: string;
  port: string;
  username: string;
  authType: string;
  keyPath: string;
  autoReconnect: boolean;
  hasPassword: boolean;
  hasKey: boolean;
}

/** SSH 连接状态(服务端 status 事件;host/platform 等字段指向「活动连接」) */
export interface ServerStatus {
  status: string;
  host: string | null;
  port: number | string | null;
  username: string | null;
  platform: string | null;
  home: string | null;
  workspace: string | null;
  /** 活动连接是否处于「不在工作区对话」(全盘模式,边界=整台服务器) */
  noWorkspace?: boolean;
  localWorkspace: string | null;
  /** 本机是否处于「不在工作区对话」(全盘模式,边界=整台电脑) */
  localNoWorkspace?: boolean;
  localHome: string | null;
  agentBusy: boolean;
  busySessions: string[];
  llmModel: string | null;
  /** 全部连接(多连接池快照) */
  conns?: ConnInfo[];
  /** 当前活动连接 id */
  activeConn?: string | null;
}

/** 历史会话 */
export interface Session {
  id: string;
  title?: string;
  msgCount?: number;
  updatedAt?: string | number;
  /**
   * 会话最后一次「用户发消息」的时间(服务端 session-store 维护)。
   * 任务列表的活跃排序以它为准:AI 回复只推进 updatedAt,不改 lastUserAt,
   * 否则每轮回复都会把会话/工作区分组顶到最前。旧数据缺失时回退 updatedAt。
   */
  lastUserAt?: number;
  /** 所属作用域:服务器键(username@host:port)或 'local';与当前作用域不同 = 其他服务器后台运行的会话 */
  connKey?: string | null;
  /**
   * 会话绑定的远程工作区(连接服务器时的执行目录)。
   * 路径 / NO_WORKSPACE(不使用工作区,边界=整台服务器)/ null·缺失(未绑定)
   */
  workspace?: string | null;
  /** 会话绑定的本地工作区;同样可为 NO_WORKSPACE(边界=整台电脑)或 null·缺失(未绑定) */
  localWorkspace?: string | null;
  /** 首条用户提问(截断;服务端 session-store.firstPrompt 提供),任务列表悬停时弹出展示 */
  prompt?: string;
}

/** 单个模型的能力声明(可选):未配置时沿用全局字符预算裁剪,不启用自动压缩 */
export interface ModelContextConfig {
  /** 输入上下文窗口(token,含历史与当前输入)。>0 时超过 80% 水位自动压缩早期历史 */
  contextWindow?: number;
  /** 单次输出 token 上限(请求体 max_tokens) */
  maxTokens?: number;
  /** 是否具备多模态(看图)能力:开启后输入框可粘贴/上传图片,随消息注入 image_url */
  multimodal?: boolean;
  /**
   * 是否为「生图模型」:开启后该对话整体切换为生图链路——
   * 每轮直接调用 /images/generations(文生图)或 /images/edits(图生图),
   * 不再走 chat/completions、不注入 system 提示词、不挂工具。
   * 纯图像端点模型(如 gpt-image-2)在 chat/completions 上会被网关 503 拒绝,必须开启本开关。
   */
  imageGen?: boolean;
}

/** 单个 API Key 的运行状态(按 Key 字符串索引) */
export interface KeyState {
  /** true = 已判定「余额不足」,自动轮询会跳过它;点「重置」后清除 */
  exhausted?: boolean;
  /** true = 已判定「鉴权失败」(Key 无效/过期/被撤销),同样被轮询跳过;点「重置」后清除 */
  invalid?: boolean;
  /** 判定原因(网关原文摘要),便于排查 */
  reason?: string;
  /** 判定时间(毫秒时间戳) */
  at?: number;
}

/** Key 是否已被判定不可用(余额不足 / 鉴权失败):不可用的 Key 不参与轮询。
 *  两个标记的语义不同(充值 vs 换 Key),但过滤口径一致 —— 统一走这里避免两处判断走偏。 */
export const keyUnusable = (st?: KeyState): boolean => st?.exhausted === true || st?.invalid === true;

/** 提供方协议:决定请求端点、鉴权头与请求/响应体的方言。
 *  openai = OpenAI 兼容(/chat/completions,绝大多数网关与国产厂商都走它);
 *  anthropic = Anthropic Messages(/v1/messages,Claude 官方及兼容该协议的网关);
 *  gemini = Google Gemini 原生(generateContent/streamGenerateContent)。 */
export type LlmProtocol = 'openai' | 'anthropic' | 'gemini';

/** LLM 提供商(预置 + 用户自定义,userProviders 来自服务端配置文件) */
export interface LlmProvider {
  id: string;
  name: string;
  baseUrl: string;
  /** 该提供方使用的协议;缺省(旧配置)按 openai 处理 */
  protocol?: LlmProtocol;
  models: string[];
  apiKey?: string;
  /** 多个 API Key(轮询用):某个 Key 余额不足时自动切换到下一个 */
  apiKeys?: string[];
  /** 每个 Key 的状态(余额不足标记等),key = API Key 本身 */
  keyStates?: Record<string, KeyState>;
  note?: string;
  mock?: boolean;
  /** 每个模型的上下文能力映射(可选),key = 模型名 */
  modelConfig?: Record<string, ModelContextConfig>;
}

/** 提供商表单提交数据(添加/编辑) */
export interface ProviderDraft {
  name: string;
  baseUrl: string;
  /** 协议(见 LlmProtocol);表单总是显式给出 */
  protocol: LlmProtocol;
  models: string[];
  apiKey: string;
  /** 多个 API Key(轮询用);apiKey 由服务端对齐为 apiKeys[0] */
  apiKeys: string[];
  /** 每个模型的上下文能力映射(可选) */
  modelConfig?: Record<string, ModelContextConfig>;
}

/** 远程目录条目 */
export interface DirEntry {
  name: string;
  type: string; // dir | file | link
  size?: number;
  mtime?: number;
}

/** 单次工具调用信息 */
export interface ToolCallInfo {
  id?: string;
  tool: string;
  args?: string | null;
  ok?: boolean;
  ms?: number | null;
  result?: string | null;
  /** 结构化 UI 数据(移植自 deepseek-harness 的 card 意图):终端卡 exitCode/cwd 等 */
  meta?: ToolCallMeta | null;
  /**
   * 该工具产出的图片等附件(服务端元数据,字节经 /api/attachments/:id 取)。
   * 截图类工具(browser_screenshot / computer_screenshot)会带上,
   * 前端在工具卡下方直接渲染成图片,不必展开卡片才看得到。
   */
  attachments?: AttachmentInfo[];
}

/**
 * 工具结果结构化 meta(由后端工具在 tool_result 附加,前端按 card 选择专属视图):
 * - card='terminal':run_command/run_local_command 的终端卡(命令/工作目录/退出码/信号)
 * - card='read':read_file 的读文件卡(path/size/offset/truncated)
 * - card='diff':write/edit 的改动卡(kind=write|edit)
 * - card='search':search_code 的搜索结果卡(pattern)
 * - card='web_search':web_search 的网络搜索结果卡(query/sources)
 */
export interface ToolCallMeta {
  card?: 'terminal' | 'read' | 'diff' | 'search' | 'todo' | 'ask' | 'web_search' | 'ai_term';
  command?: string;
  cwd?: string;
  exitCode?: number | string | null;
  signal?: string | null;
  timedOut?: boolean;
  /** ai_term 卡:运行终端当前状态(running/exited/failed) */
  state?: 'running' | 'exited' | 'failed';
  path?: string;
  size?: number;
  offset?: number;
  truncated?: boolean;
  kind?: string;
  /** 文件改动卡(write/edit/delete 工具附加):新增行数(addLines)/删除行数(delLines) */
  addLines?: number;
  delLines?: number | null;
  pattern?: string;
  /** web_search 的来源列表(标题/摘要/链接/发布时间),由后端结构化附加 */
  query?: string;
  sources?: WebSearchSourceMeta[];
  /**
   * subagent 卡:这次派发的运行记录(右侧面板据此回看子代理自己的完整对话)。
   * runId 只在子代理跑完后随 tool/result 到达;运行中可从面板列表进入。
   */
  subagent?: {
    description?: string;
    provider?: string;
    runId?: string;
    /** 派发方式:continuable = 后台常驻(默认,可续聊/可暂停);one-shot = 前台等结果的一次性 */
    mode?: 'one-shot' | 'continuable';
    /** 是否是后台派发(返回时还没结果) */
    background?: boolean;
    steps?: number;
    toolCalls?: number;
    ms?: number;
    promptTokens?: number;
    completionTokens?: number;
  };
}

/** 子代理派发记录(列表快照;后端 server/store/subagent-store.ts) */
export interface SubagentRunInfo {
  runId: string;
  /** 归属父会话 id */
  sid: string | null;
  description: string;
  provider: string;
  /** 派发方式:continuable = 常驻后台、可续聊可暂停(默认);one-shot = 前台一次性 */
  mode?: 'one-shot' | 'continuable';
  /** running = 正在跑某一轮;idle = 常驻但当前没在跑(可继续);done/error/stopped = 一次性派发的终局 */
  status: 'running' | 'idle' | 'done' | 'error' | 'stopped';
  /** 还有多少条消息/轮次在排队 */
  queued?: number;
  /** 服务端是否还有常驻 Activation(有才可能续聊/暂停;重启后为 false) */
  resident?: boolean;
  startedAt: number;
  endedAt: number | null;
  ms: number | null;
  steps: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  /** 父对话给的原始字段(任务/边界/回传/线索) */
  brief: { objective?: string; scope?: string; deliverable?: string; context?: string; prompt?: string };
  /** 组装后真正下发的提示词 */
  prompt: string;
  /** 结束补充说明(被停止 / 出错原因) */
  note?: string | null;
  /**
   * 活跃时长口径(服务端按 dsh 的 subagentTiming 折叠):**只累计真正在跑的回合**,
   * 闲置时间不计 —— 常驻子代理停在「当前未运行」时,显示的时间是定住的,不会一直涨。
   */
  settledMs?: number;
  /** 当前开着的那一轮的起点(ms);没有开着的轮 = null(前端据此决定计时器还走不走) */
  activeSince?: number | null;
  /** 开着的这一轮里最后一个事件的时间 */
  activeThrough?: number | null;
  /** 最近一次关闭的轮是否正常完成(前端据此把行显示成「已完成」而不是「当前未运行」) */
  lastTurnCompleted?: boolean | null;
}

/** 子代理内部的一条对话消息 */
export interface SubagentMessage {
  role: 'user' | 'assistant' | 'tool';
  step: number;
  at: number;
  /** user 消息的来源:brief=初始任务,parent=主代理后续消息,human=人类在子会话里发的 */
  from?: 'brief' | 'parent' | 'human';
  text?: string;
  reasoning?: string;
  callId?: string;
  name?: string;
  args?: string;
  isError?: boolean;
  content?: string;
  ms?: number;
}

/** 派发记录详情 = 列表快照 + 完整对话 */
export interface SubagentRun extends SubagentRunInfo {
  messages: SubagentMessage[];
}

/** 一条文件变更记录(单轮 AI 回复中某个文件的改动汇总,供回复下方「N 个文件已更改」卡展示) */
export interface FileChangeItem {
  /** 文件绝对路径(远程服务器或本机) */
  path: string;
  /** 变更类型:create=新建, write=覆盖写入, edit=修改, delete=删除 */
  kind: 'create' | 'write' | 'edit' | 'delete';
  /** 新增行数 */
  addLines: number;
  /** 删除行数(null=未知,如覆盖写入的大文件未能读取旧内容) */
  delLines?: number | null;
  /** 变更发生在本机(local_* 工具);缺省 false = 远程服务器。点击打开文件时据此选择远程/本机读取通道 */
  local?: boolean;
}

/** 一条网络搜索结果来源(与后端 web-search.ts 的 WebSearchSource 对齐) */
export interface WebSearchSourceMeta {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}

/** 一个聊天附件的服务端元数据(上传接口返回/会话历史下发);字节经 /api/attachments/:id 访问 */
export interface AttachmentInfo {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'video' | 'file';
  url?: string;
}

/**
 * 一个「成果物」声明(模型通过 present 工具显式交付给用户的文件)。
 *
 * 与「文件改动」不是一回事,两者互补,别合并:
 *   - 文件改动:宿主观察到的**事实** —— 本轮工作区里哪些文件被改了(自动汇总,可能含模型没提过的文件);
 *   - 成果物:模型声明的**交付意图** —— "这些是给你用的最终产物",并附一句人类可读的说明。
 * 只带路径与说明,**不复制内容**:内容仍在原路径,用户打开的是当前文件。
 */
export interface PresentedFile {
  /** 文件路径(服务端已解析成绝对路径;旧会话的历史数据可能还是工作区相对路径) */
  path: string;
  /**
   * 服务端判定的归属侧:true=本机文件,false=远程文件。
   * 旧会话的历史数据没有这个字段,前端回落到"路径落在本机工作区就是本机"的推断。
   */
  local?: boolean;
  /** 给用户看的一句话说明:这是什么、拿来做什么 */
  description?: string;
}

/** 聊天消息内的分段:文本 / 思考 / 连续工具组,按实际发生顺序排列(思考可穿插在工具组之间) */
export interface MsgSegment {
  kind: 'text' | 'reasoning' | 'tools';
  text?: string;
  tools?: ToolCallInfo[];
}

/** 用户 `/技能名` 手动调用的技能记录(服务端注入正文时下发;正文只给前 600 字预览,完整正文模型侧可见) */
export interface LoadedSkill {
  name: string;
  description?: string;
  preview?: string;
}

/** 渲染用聊天消息 */
export interface ChatMessage {
  role: string; // user | assistant | notice
  content?: string;
  segments?: MsgSegment[];
  /** 本步(iteration 事件)开始时的 segments 下标:模型请求中途失败重试时,把本步已流出、
      尚未落盘的半成品段整段回滚(截断到这里),避免重试后的正文与半成品拼接重复 */
  stepSegBase?: number;
  streaming?: boolean;
  /** 消息携带的附件(图片/文件/视频,服务端元数据;图片经 /api/attachments/:id 取字节)。
   *  user 消息 = 用户上传;assistant 消息 = 生图模型本轮生成的成图 */
  attachments?: AttachmentInfo[];
  /** 本轮交付给用户的成果物(模型经 present 工具显式声明):渲染为该气泡下方的成果物卡片。
   *  与 attachments 的区别:附件是**字节**(服务端存了副本、走 /api/attachments 取),
   *  成果物是**路径引用**(内容仍在原路径,卡片点击打开当前文件) */
  deliverables?: PresentedFile[];
  /** 用户本轮用 `/技能名` 手动调用的技能(服务端把技能正文注入用户消息时,随事件与历史下发的记录)。
   *  渲染为用户气泡下方的「已加载技能」折叠行——模型主动调用 skill 工具走 ToolCallList 卡片,
   *  这条补的是手动调用路径的可见反馈;两条路径都必须看得见 */
  skillsInjected?: LoadedSkill[];
  /** 生图模型本轮的生成态(assistant 消息):pending=生成中(耗时数十秒,无流式增量),
   *  mode 标注本轮实际走的通路,供气泡显示「文生图 / 图生图」徽标与参考图数量 */
  imageJob?: { mode: 't2i' | 'i2i'; refs?: number; pending?: boolean; ms?: number };
  /** 分支点:该消息在服务端 turns 数组中的结束索引(>=0 时按此截断克隆,缺省 -1 从尾部) */
  forkTail?: number;
  /** 消息时间戳(毫秒,来自服务端事件 time;实时消息用前端 Date.now()) */
  time?: number;
  /** 本轮的耗时(毫秒,turn/start → turn/end),用于「已完成,用时 2分19秒」折叠行。
   *  服务端在 turn/end 时**回填**到本轮所有 assistant 行(不新增行,所以不影响下标口径) */
  turnElapsedMs?: number;
  /** 本轮结束原因(completed / aborted / error / max-iters);aborted→「已停止」,error→「处理失败」 */
  turnEndReason?: string;
  /** 本轮的 token 用量(四桶,单轮口径:该轮所有步 + 重试尝试)。
   *  服务端在 turn/end 时与 turnElapsedMs 一起回填到本轮各行,并在实时 turn_end 事件下发。
   *  **缺省表示该轮没有任何可用用量样本**(网关不报用量),此时统计行不渲染用量胶囊,
   *  而不是显示"0 tok" */
  turnUsage?: TokenUsageTotals;
  /** 提示行(role=notice)的级别源自服务端 notice 事件:缺省按普通提示渲染 */
  level?: 'info' | 'warn';
  /** 提示行的语义分类(interrupted / truncated / turn-error / compaction / max-tokens …),
   *  供样式与排查用;不影响渲染内容 */
  kind?: string;
  /** 模型请求失败进入重试的提示消息(role=notice):同一失败重试时原地更新不堆叠。
      渲染为 harness 风格的单行折叠状态行(等待重试实时倒计时 + 可展开的失败详情) */
  retry?: {
    /** 连续失败阶段标识,用于实时更新和历史回放一致分组 */
    retryGroup?: string;
    /** 当前第几次重试(从 1 起) */
    retry: number;
    /** 最大重试次数 */
    maxRetries: number;
    /** 本次重试的等待时长(ms);换 Key(kind='switch')时为 0——那是立即重发,不是等待 */
    delayMs: number;
    /** 失败原因摘要 */
    error: string;
    /** 'switch' = 切换到下一个可用 API Key(立即重发);缺省 = 退避后重试同一个 Key */
    kind?: 'retry' | 'switch';
    /** 状态:scheduled=等待重试(倒计时中) → started=已开始重试 / cancelled=已取消 */
    state: 'scheduled' | 'started' | 'cancelled';
    /** 本次重试是否作废了上一次已流出的半成品(true 时该气泡的可变段已被回滚) */
    discard?: boolean;
  };
  /** 上下文压缩标记(compaction/done 投影消息):dropCount=被压缩消息数,manual=手动压缩。
      渲染为对话流中的折叠「压缩标记行」(样式参照 harness 的 CompactionItem)。
      running=摘要摘要生成中的运行态;failed=摘要不可用(压缩未完成,已保持完整历史不裁剪) */
  compaction?: { dropCount?: number; manual?: boolean; running?: boolean; failed?: boolean; reason?: string; modelFaceFrom?: number };
  /** 斜杠命令在对话流中的命令卡片(role='command',本地插入,不持久化):
      压缩中/完成/失败的可见反馈(样式参照 harness 的 GenericCommandCard) */
  command?: { name: string; state: 'running' | 'ok' | 'error'; text?: string };
  /** 命令卡片的本地唯一 id(供异步完成后原地更新;/compact 成功重拉历史时尾部命令卡会被保留,
      patchCmd 依它命中并落完成态——见 utils/commandCard 的 mergeTrailingCommandCards) */
  cmdId?: number;
  /** 单轮回复中修改过的文件汇总(write/edit/delete 工具 meta 聚合):渲染回复下方的「N 个文件已更改」卡片 */
  filesChanged?: FileChangeItem[];
  /** 目标自动续跑轮(服务端 user/message 的 source='goal' 投影):用户气泡渲染成「🎯 目标第 N 轮」 */
  goalRound?: { round: number; revision?: number };
  /** 非人类消息的来源归属(服务端 session.ts 的 MessageSource 对象形态)。
   *  `form='notice'` 的消息(子代理结算 / 自动化任务 / 目标续跑…)渲染成 **通知行**,
   *  而不是用户气泡 —— 它替运行时/子代理说话,不是用户打的字(见 dsh 的 MessageSource)。 */
  source?: { kind: string; form?: string; summary?: string; senderSessionId?: string };
  /** 这条通知是**轮内送达**的(运行中 steer 进来):渲染成轮内通知行(带一行账),
   *  而不是"触发本轮的通知"行(服务端投影与实时事件都用这个标记) */
  inline?: boolean;
}

/** 任务计划项(todo_write 工具维护,状态对齐 deepseek-harness) */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

// ---- 会话级长期目标(/目标 命令 + get_goal/create_goal/update_goal 工具)----

/** 目标阶段(与 deepseek-harness 的 GoalPhase 一一对应) */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete';

/** 当前目标视图(服务端 get_history 的 goal 字段与 goal_changed 事件同构) */
export interface GoalInfo {
  id: string;
  revision: number;
  objective: string;
  phase: GoalPhase;
  blockedReason?: { code: string; message: string };
  maxGoalRounds: number;
  /** 已计入日志的自动续跑轮数 */
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
  /** 进程内续跑授权:armed=空闲会自动续跑,disarmed=不续跑 */
  activation: 'armed' | 'disarmed';
}

// ---- ask_user_question 工具(模型向用户提问) ----

/** 一道题的候选选项 */
export interface AskOption {
  label: string;
  description?: string;
}

/** 模型提出的一道题 */
export interface AskQuestion {
  id: string;
  question: string;
  header?: string;
  /** 长正文(如计划模式 exit_plan_mode 的完整计划):面板以等宽正文渲染 */
  detail?: string;
  options?: AskOption[];
  multi_select?: boolean;
}

/** 一批提问(agent 事件 ask_user 携带) */
export interface AskRequest {
  askId: string;
  questions: AskQuestion[];
  sid?: string;
}

// ---- AI 运行终端(run_command / run_local_command 以 background=true 拉起的项目进程) ----

/** 服务端上报的一个运行终端(不含日志正文;日志按需通过 ai_term_log 拉取) */
export interface AiTermInfo {
  id: string;
  /** 归属会话 id(仅展示用;面板跨会话可见) */
  sid: string | null;
  /** 人类可读标签(工具 description) */
  label: string;
  command: string;
  target: 'remote' | 'local';
  cwd: string | null;
  /** 远程 user@host:port;本地 '本机' */
  host: string;
  state: 'running' | 'exited' | 'failed';
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  note?: string | null;
}

/** 一道题的回答(回传服务端 / 模型可读) */
export interface AskAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

/** 整个会话的累计用量(四桶,服务端 foldTokenUsage 的结果);统计栏「用量」胶囊用 */
export interface TokenUsageTotals {
  /** 未命中缓存的输入 token */
  uncachedInputTokens: number;
  /** 输出 token(已含推理 token) */
  outputTokens: number;
  /** 命中缓存读取的输入 token */
  cacheReadTokens: number;
  /** 写入缓存的输入 token(多数网关为 0) */
  cacheWriteTokens: number;
  /** 有上报用量的步数;为 0 表示这个会话没有可用的缓存信息 */
  samples: number;
}

/** 整个会话的对话统计(服务端 foldSessionStats 的结果);统计栏「活动」胶囊用 */
export interface SessionStatsInfo {
  turns: number;
  steps: number;
  /** 模型墙钟时间之和(step/start → assistant/message) */
  llmMs: number;
  /** 工具墙钟时间之和(各次工具调用耗时相加,不是墙钟等待时间) */
  toolMs: number;
  /** 首 token 延迟之和 */
  ttftMs: number;
  /** 承载首 token 的步数(TTFT 平均值分母) */
  ttftSteps: number;
  /** 解码墙钟之和 */
  decodeMs: number;
  /** 与 decodeMs 同一批步的输出 token(速度分子) */
  decodeTokens: number;
}
