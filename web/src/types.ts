// 共享类型定义:前后端 WebSocket 消息为动态结构,这里只描述前端使用到的关键形状

/** SSH 连接状态(服务端 status 事件) */
export interface ServerStatus {
  status: string;
  host: string | null;
  port: number | string | null;
  username: string | null;
  platform: string | null;
  home: string | null;
  workspace: string | null;
  agentBusy: boolean;
  busySessions: string[];
  llmModel: string | null;
}

/** 历史会话 */
export interface Session {
  id: string;
  title?: string;
  msgCount?: number;
  updatedAt?: string | number;
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
}

/** 聊天消息内的分段:文本 / 思考 / 连续工具组,按实际发生顺序排列(思考可穿插在工具组之间) */
export interface MsgSegment {
  kind: 'text' | 'reasoning' | 'tools';
  text?: string;
  tools?: ToolCallInfo[];
}

/** 渲染用聊天消息 */
export interface ChatMessage {
  role: string; // user | assistant | notice ...
  content?: string;
  segments?: MsgSegment[];
  streaming?: boolean;
  /** 分支点:该消息在服务端 turns 数组中的结束索引(>=0 时按此截断克隆,缺省 -1 从尾部) */
  forkTail?: number;
}

/** 任务计划项(todo_write 工具维护,状态对齐 deepseek-harness) */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}
