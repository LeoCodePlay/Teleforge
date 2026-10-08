// MCP 活状态注册处:各连接当前发布的「服务器 instructions」与「资源提供者」。
//
// 单独成模块是为了打断循环依赖:agent.ts 只需要读这里的提示段,
// 而连接管理(manager.ts)反过来要往这里写;两者都依赖本模块,本模块不依赖它们。
//
// 提示文本与 deepseek-harness 的 mcp-client / mcp-resources 逐字一致:
//   - instructions 段:  `### MCP server: <serverName>\n\n<服务器原文>`
//   - 资源服务器段:    `## MCP resource servers\n\nUse list_mcp_resources, ...`
// 差异只在承载位置:harness 把它做成 system prompt 的 section;teleforge 的 system 必须
// 逐字节稳定(前缀缓存,见 agent.ts 的 _systemPrompt 注释),因此随 runtime_context
// user 快照下发 —— 语义相同(模型每轮都看得到),连接重建导致文本变化时也只动快照。
import type { JsonValue } from './resources.ts';

/** 一个已连接 server 的资源操作入口(由它的连接代际实现)。 */
export interface McpResourceProvider {
  request(request: McpResourceRequest, ctx: any): Promise<JsonValue>;
}

/** 一次受支持的资源操作,游标与 URI 都由 server 自己给。 */
export type McpResourceRequest =
  | { method: 'resources/list' | 'resources/templates/list'; cursor?: string }
  | { method: 'resources/read'; uri: string };

/** serverName → 当前连接发布的 instructions(仅在连接+工具同步都成功后才写入)。 */
const serverInstructions = new Map<string, string>();

/** serverName → 资源操作入口。 */
const resourceProviders = new Map<string, McpResourceProvider>();

/** 记录一个 server 的 instructions(空串 = 无 instructions,不贡献提示文本)。 */
export function setServerInstructions(serverName: string, text: string): void {
  if (text) serverInstructions.set(serverName, text);
  else serverInstructions.delete(serverName);
}

/** 该 server 断开/放弃重连时清掉它的 instructions。 */
export function clearServerInstructions(serverName: string): void {
  serverInstructions.delete(serverName);
}

/** 该 server 的连接已建立:发布它的资源操作入口。 */
export function registerResourceProvider(serverName: string, provider: McpResourceProvider): void {
  resourceProviders.set(serverName, provider);
}

/** 该 server 的连接代际结束:撤下资源操作入口。 */
export function unregisterResourceProvider(serverName: string): void {
  resourceProviders.delete(serverName);
}

/** 取一个 server 的资源操作入口(资源工具按模型给的 server 名解析)。 */
export function getResourceProvider(serverName: string): McpResourceProvider | undefined {
  return resourceProviders.get(serverName);
}

/** 当前可用的资源服务器名(按字母序,保证提示文本逐字节稳定)。 */
export function resourceServerNames(): string[] {
  return [...resourceProviders.keys()].sort();
}

/** 是否有任何 MCP 连接可用(供界面显示状态)。 */
export function liveServerNames(): string[] {
  return [...serverInstructions.keys()].sort();
}

/**
 * 渲染 MCP 相关提示段(没有内容时返回空串)。
 * 顺序固定:先各 server instructions,再资源服务器清单,保证同一状态渲染结果逐字节一致。
 */
export function renderMcpPromptSections(): string {
  const parts: string[] = [];
  for (const name of [...serverInstructions.keys()].sort()) {
    const text = serverInstructions.get(name);
    if (text) parts.push(text);
  }
  const names = resourceServerNames();
  if (names.length > 0) {
    parts.push('## MCP resource servers\n\n'
      + 'Use list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names '
      + `as the server argument: ${JSON.stringify(names)}.`);
  }
  return parts.join('\n\n');
}
