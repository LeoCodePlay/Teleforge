// 共享类型定义:前后端 WebSocket 消息为动态结构,这里只描述前端使用到的关键形状

/**
 * 「不在工作区对话」哨兵值(与 server/config.ts 的 NO_WORKSPACE 保持一致):
 * 作为 set_workspace / set_local_workspace 的 path 传入,表示该侧不绑定任何目录,
 * AI 的文件边界放宽到整台机器(本机 = 所有盘符,远程 = 整个远程文件系统)。
 */
export const NO_WORKSPACE = 'no-workspace';

/** 全盘模式下的展示文案:本地侧 = 整台电脑,远程侧 = 整台服务器 */
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
  /** 所属作用域:服务器键(username@host:port)或 'local';与当前作用域不同 = 其他服务器后台运行的会话 */
  connKey?: string | null;
  /**
   * 会话绑定的远程工作区(连接服务器时的执行目录)。
   * 路径 / NO_WORKSPACE(「不在工作区对话」,边界=整台服务器)/ null·缺失(未绑定)
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

/** LLM 提供商(预置 + 用户自定义,userProviders 来自服务端配置文件) */
export interface LlmProvider {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  apiKey?: string;
  note?: string;
  mock?: boolean;
  /** 每个模型的上下文能力映射(可选),key = 模型名 */
  modelConfig?: Record<string, ModelContextConfig>;
}

/** 提供商表单提交数据(添加/编辑) */
export interface ProviderDraft {
  name: string;
  baseUrl: string;
  models: string[];
  apiKey: string;
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
    steps?: number;
    toolCalls?: number;
    ms?: number;
    promptTokens?: number;
    completionTokens?: number;
    hitStepLimit?: boolean;
  };
}

/** 子代理派发记录(列表快照;后端 server/store/subagent-store.ts) */
export interface SubagentRunInfo {
  runId: string;
  /** 归属父会话 id */
  sid: string | null;
  description: string;
  provider: string;
  status: 'running' | 'done' | 'error' | 'stopped';
  startedAt: number;
  endedAt: number | null;
  ms: number | null;
  steps: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  hitStepLimit: boolean;
  /** 父对话给的原始字段(任务/边界/回传/线索) */
  brief: { objective?: string; scope?: string; deliverable?: string; context?: string; prompt?: string };
  /** 组装后真正下发的提示词 */
  prompt: string;
  maxSteps: number;
  /** 结束补充说明(达到步数上限 / 被停止 / 出错原因) */
  note?: string | null;
}

/** 子代理内部的一条对话消息 */
export interface SubagentMessage {
  role: 'user' | 'assistant' | 'tool';
  step: number;
  at: number;
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
  /** 提示行(role=notice)的级别源自服务端 notice 事件:缺省按普通提示渲染 */
  level?: 'info' | 'warn';
  /** 提示行的语义分类(interrupted / truncated / turn-error / compaction / max-tokens …),
   *  供样式与排查用;不影响渲染内容 */
  kind?: string;
  /** 模型请求失败进入重试的提示消息(role=notice):同一失败重试时原地更新不堆叠。
      渲染为 harness 风格的单行折叠状态行(等待重试实时倒计时 + 可展开的失败详情) */
  retry?: {
    /** 当前第几次重试(从 1 起) */
    retry: number;
    /** 最大重试次数 */
    maxRetries: number;
    /** 本次重试的等待时长(ms) */
    delayMs: number;
    /** 失败原因摘要 */
    error: string;
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
}

/** 任务计划项(todo_write 工具维护,状态对齐 deepseek-harness) */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
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
