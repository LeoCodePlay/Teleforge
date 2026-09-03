// 共享类型定义:前后端 WebSocket 消息为动态结构,这里只描述前端使用到的关键形状

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
  localWorkspace: string | null;
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
}

/** 单个模型的上下文能力声明(可选):未配置时沿用全局字符预算裁剪,不启用自动压缩 */
export interface ModelContextConfig {
  /** 输入上下文窗口(token,含历史与当前输入)。>0 时超过 80% 水位自动压缩早期历史 */
  contextWindow?: number;
  /** 单次输出 token 上限(请求体 max_tokens) */
  maxTokens?: number;
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
  card?: 'terminal' | 'read' | 'diff' | 'search' | 'todo' | 'ask' | 'web_search';
  command?: string;
  cwd?: string;
  exitCode?: number | string | null;
  signal?: string | null;
  timedOut?: boolean;
  path?: string;
  size?: number;
  offset?: number;
  truncated?: boolean;
  kind?: string;
  pattern?: string;
  /** web_search 的来源列表(标题/摘要/链接/发布时间),由后端结构化附加 */
  query?: string;
  sources?: WebSearchSourceMeta[];
}

/** 一条网络搜索结果来源(与后端 web-search.ts 的 WebSearchSource 对齐) */
export interface WebSearchSourceMeta {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}

/** 聊天消息内的分段:文本 / 思考 / 连续工具组,按实际发生顺序排列(思考可穿插在工具组之间) */
export interface MsgSegment {
  kind: 'text' | 'reasoning' | 'tools';
  text?: string;
  tools?: ToolCallInfo[];
}

/** 渲染用聊天消息 */
export interface ChatMessage {
  role: string; // user | assistant | notice
  content?: string;
  segments?: MsgSegment[];
  streaming?: boolean;
  /** 分支点:该消息在服务端 turns 数组中的结束索引(>=0 时按此截断克隆,缺省 -1 从尾部) */
  forkTail?: number;
  /** 消息时间戳(毫秒,来自服务端事件 time;实时消息用前端 Date.now()) */
  time?: number;
  /** 请求失败进入重试的提示消息(role=notice),同一失败重试时原地更新不堆叠 */
  retryNotice?: boolean;
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

/** 一道题的回答(回传服务端 / 模型可读) */
export interface AskAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}
