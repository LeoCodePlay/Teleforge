// MCP 资源共享工具:三个由所有已配置 server 共用的模型工具。
//
// 逐字对应 deepseek-harness 的 packages/mcp/mcp-resources:
//   list_mcp_resources / list_mcp_resource_templates / read_mcp_resource
// 参数都以 server(=配置里的 serverName)显式选择服务器;二进制 blob 不进模型上下文,
// 只回一句"有多少 base64 字符、对程序化调用方仍可用"(见 renderResourceResult)。
import type { ToolDef, ToolRegistry } from '../agent/registry.ts';
import { getResourceProvider, resourceServerNames, type McpResourceRequest } from './state.ts';

/** 资源协议结果:原样 JSON,不做有损转换(harness 的 JsonValue)。 */
export type JsonValue = any;

const listParameters = {
  type: 'object',
  properties: {
    server: { type: 'string', description: 'Configured MCP server name.' },
    cursor: { type: 'string', description: 'Continuation cursor returned by this server.' }
  },
  required: ['server']
};

/**
 * 渲染资源 JSON:二进制 payload 只留描述,不进模型历史(harness 的 render.ts 原文)。
 */
export function renderResourceResult(server: string, value: JsonValue): string {
  const rendered = JSON.stringify(value, (key, item: unknown) => {
    if (key === 'blob' && typeof item === 'string') {
      return `[binary resource: ${item.length} base64 characters; available to programmatic callers]`;
    }
    return item as any;
  });
  return `MCP server: ${server}\n${rendered}`;
}

/**
 * 取一个 server 的资源操作入口;不存在时给出与 harness 同义的错误。
 * (harness 按 Agent scope 解析 provider,teleforge 只有一个全局作用域)
 */
function requireProvider(server: string) {
  const provider = getResourceProvider(String(server || ''));
  if (!provider) throw new Error(`MCP resource server "${server}" is unavailable in this agent's scope`);
  return provider;
}

/** 三个共享资源工具的定义(未注册,由 {@link syncResourceTools} 统一挂/撤)。 */
export function resourceToolDefs(): ToolDef[] {
  return [
    {
      name: 'list_mcp_resources',
      description: 'List resources available from an MCP server.',
      parameters: listParameters,
      access: 'read',
      async run(args: any, ctx: any) {
        const req: McpResourceRequest = { method: 'resources/list', ...(args?.cursor === undefined ? {} : { cursor: String(args.cursor) }) };
        return renderResourceResult(String(args?.server ?? ''), await requireProvider(String(args?.server ?? '')).request(req, ctx));
      }
    },
    {
      name: 'list_mcp_resource_templates',
      description: 'List parameterized resource URI templates from an MCP server.',
      parameters: listParameters,
      access: 'read',
      async run(args: any, ctx: any) {
        const req: McpResourceRequest = { method: 'resources/templates/list', ...(args?.cursor === undefined ? {} : { cursor: String(args.cursor) }) };
        return renderResourceResult(String(args?.server ?? ''), await requireProvider(String(args?.server ?? '')).request(req, ctx));
      }
    },
    {
      name: 'read_mcp_resource',
      description: 'Read an MCP resource by URI from the named server. Use a listed URI or an expanded resource template.',
      parameters: {
        type: 'object',
        properties: {
          server: listParameters.properties.server,
          uri: { type: 'string', description: 'Resource URI to read.' }
        },
        required: ['server', 'uri']
      },
      access: 'read',
      async run(args: any, ctx: any) {
        const server = String(args?.server ?? '');
        return renderResourceResult(server, await requireProvider(server).request({ method: 'resources/read', uri: String(args?.uri ?? '') }, ctx));
      }
    }
  ];
}

/** 已挂载的资源工具注销器;null = 当前没有 server 在册。 */
let disposeResourceTools: (() => void) | null = null;

/**
 * 让资源工具的存在与"是否有可用 server"保持一致(harness 的同一可见性规则):
 * 第一个 server 建立连接时挂上三个工具,最后一个撤下时一并注销。
 * 由连接管理器在注册/注销 provider 之后调用(幂等)。
 */
export function syncResourceTools(registry: ToolRegistry): void {
  const want = resourceServerNames().length > 0;
  if (want && !disposeResourceTools) {
    const disposers = resourceToolDefs().map((def) => registry.register(def));
    registry.invalidateSchemasCache();
    disposeResourceTools = () => { for (const d of disposers) d(); };
  } else if (!want && disposeResourceTools) {
    disposeResourceTools();
    disposeResourceTools = null;
    registry.invalidateSchemasCache();
  }
}
