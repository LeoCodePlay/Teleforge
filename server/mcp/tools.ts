// MCP 工具桥:发现外部 MCP server 的工具,按确定性的「服务器限定名」注册进本工具注册表,
// 并在 server 的工具清单变化时做整代切换(re-sync)。
//
// 命名契约(照搬 deepseek-harness 的 mcp-client「Naming invariants」):
//   每个 MCP 工具都有稳定身份 `(serverName, rawName)`;模型可见名固定为
//   `mcp__<serverName>__<rawName>`,并按 DeepSeek function-name 契约做无损归一化
//   (非法字符替换为 `_`;超长/被替换时追加 12 位 SHA-256 身份哈希,保证不同身份绝不塌缩)。
//   rawName 只用于线上协议(`tools/call`),公开名永不回解成 rawName。
//
// 全有或全无:一次同步先取全量、构造完整的新一代定义,再原子换掉旧一代;
// 取列表失败保留旧一代;注册冲突整代回滚(模型要么看到整套,要么一个都看不到)。
import { createHash } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/client';
import type { ToolDef, ToolRegistry } from '../agent/registry.ts';
import { saveAttachment } from '../store/attachments-store.ts';

/** 一次同步代际:公开工具名 → 注销器。 */
export type ToolDisposers = Map<string, () => void>;

/** 桥接选项:服务器命名空间、单次调用超时。 */
export interface ToolBridgeOptions {
  serverName: string;
  toolCallTimeoutMs: number;
}

/** DeepSeek function-name 契约:最长 64 字符(线上协议常量,不是配置)。 */
const MAX_PUBLIC_NAME_LENGTH = 64;

/** DeepSeek function-name 契约:只允许 `[A-Za-z0-9_-]`。 */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;

/** 有损归一化时追加的 SHA-256 身份哈希长度(十六进制字符数)。 */
const HASH_LENGTH = 12;

/** 可持久化为附件的栅格图格式。 */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** 规范 RFC 4648 base64:不接受空白与 URL-safe 别名。 */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * 推导一个 MCP 工具的模型可见公开名。
 * 是 `(serverName, rawName)` 的确定性纯函数:干净情形就是 `mcp__<serverName>__<rawName>`;
 * 发生字符替换或截断时,追加 12 位 SHA-256 身份哈希,避免不同身份塌缩成同名。
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, '_');
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/** 一个上游 MCP 工具,以及取它原始协议结果的回调。 */
export interface McpToolDefinitionOptions {
  /** 注册进注册表的模型可见名(`mcp__<server>__<tool>`)。 */
  name: string;
  /** 上游原名,仅用于线上调用与结果诊断。 */
  rawName: string;
  /** 上游给出的模型可见描述。 */
  description: string;
  /** 上游 JSON 输入 schema(直接透传给模型)。 */
  inputSchema: Record<string, unknown>;
  /** 该工具是否要求本桥不支持的 task 执行扩展。 */
  taskRequired?: boolean;
  /** 取一次原始 MCP 结果。 */
  call: (args: Record<string, unknown>, ctx: any) => Promise<unknown>;
}

/** MCP 内容块的宽松形状(内容来自不可信远端,读字段前逐个判型)。 */
interface McpContentBlock {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
  name?: string;
  uri?: string;
}

/** 判断一个 JSON 值是否为字符串键的对象。 */
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** MIME 是否落在可持久化的图片词汇表内。 */
function isImageMediaType(value: string): boolean {
  return IMAGE_MEDIA_TYPES.includes(value);
}

/**
 * 解码一个 MCP 图片块;只接受规范 base64 与四种栅格格式(照搬 harness 的 decodeImage)。
 * @throws 声明格式不支持、或 data 不是规范 base64 时抛错
 */
function decodeImage(block: McpContentBlock): { buf: Buffer; mediaType: string } {
  const mediaType = String(block.mimeType ?? '');
  if (!isImageMediaType(mediaType)) throw new Error('the declared media type is not PNG, JPEG, WebP, or GIF');
  const data = String(block.data ?? '');
  if (!CANONICAL_BASE64.test(data)) throw new Error('the image data is not canonical base64');
  const buf = Buffer.from(data, 'base64');
  if (buf.toString('base64') !== data) throw new Error('the image data is not canonical base64');
  return { buf, mediaType };
}

/** 未被采纳的图片块给出的稳定诊断文本(harness 原文措辞)。 */
function imageDiagnostic(block: McpContentBlock, reason: string): string {
  const mediaType = block.mimeType ?? 'unknown media type';
  return `[image unavailable: ${mediaType}; ${reason}; raw image data remains available to programmatic callers]`;
}

/** 已保存为附件、可在对话里看到的那张图,模型侧给出的一行占位说明。 */
function imageSavedNote(block: McpContentBlock, attachmentId: string): string {
  const mediaType = block.mimeType ?? 'unknown media type';
  return `[image: ${mediaType}; 已保存为附件 ${attachmentId} 并在对话中展示给用户;工具结果不能携带图片给模型,故此处以文字占位]`;
}

/**
 * 把有序的 MCP 内容块投影成本工具链能表达的东西:
 * - 文本段按原始顺序换行合并;
 * - 图片段就地落成附件(存不下时退化为上面的诊断文本,绝不静默丢内容);
 * - resource_link / audio / resource / 未知块给出与 harness 逐字一致的诊断文本。
 * @returns `{ content, attachments }`,可直接作为 ToolDef.run 的返回值
 */
async function projectMcpContent(
  mcpContent: unknown[],
  rawToolName: string
): Promise<{ content: string; attachments: Array<Record<string, any>> }> {
  const attachments: Array<Record<string, any>> = [];
  const text: string[] = [];
  // 图片先整批预检:任何一张不合法(或存不下)就整批退化为文字诊断,
  // 与 harness「拒绝时把每张图都投影成诊断文本」的取舍一致,避免出现"半批图片"。
  const decoded: Array<{ index: number; block: McpContentBlock; buf: Buffer; mediaType: string }> = [];
  const validationErrors = new Map<number, string>();
  for (const [index, value] of mcpContent.entries()) {
    if (!isRecord(value) || value.type !== 'image') continue;
    const block = value as unknown as McpContentBlock;
    try {
      const d = decodeImage(block);
      decoded.push({ index, block, buf: d.buf, mediaType: d.mediaType });
    } catch (e: any) {
      validationErrors.set(index, e?.message || 'the image block is invalid');
    }
  }
  const savedByIndex = new Map<number, string>();
  if (decoded.length > 0 && validationErrors.size === 0) {
    try {
      for (const d of decoded) {
        const ext = d.mediaType.split('/')[1] || 'png';
        const meta = await saveAttachment(d.buf, `mcp-${rawToolName}-${d.index + 1}.${ext}`, d.mediaType);
        savedByIndex.set(d.index, String(meta.id));
        attachments.push(meta as unknown as Record<string, any>);
      }
    } catch {
      // 落盘失败同样整批退化:已存的少数几张也一并撤销引用,只留文字诊断
      savedByIndex.clear();
      attachments.length = 0;
      for (const d of decoded) validationErrors.set(d.index, 'durable image storage rejected the result');
    }
  }

  for (const [index, value] of mcpContent.entries()) {
    if (!isRecord(value)) {
      text.push('[unsupported MCP content block: expected an object]');
      continue;
    }
    const block = value as unknown as McpContentBlock;
    switch (block.type) {
      case 'text':
        if (block.text !== undefined) text.push(String(block.text));
        break;
      case 'image': {
        const savedId = savedByIndex.get(index);
        if (savedId) text.push(imageSavedNote(block, savedId));
        else text.push(imageDiagnostic(block, validationErrors.get(index) ?? 'another image in the same result was invalid'));
        break;
      }
      case 'resource_link':
        if (block.name === undefined || block.uri === undefined) {
          text.push('[resource link unavailable: the MCP block is missing its name or URI]');
        } else {
          text.push(`Resource link: ${block.name} (${block.uri})`);
        }
        break;
      case 'audio':
        text.push(`[audio result unsupported: ${block.mimeType ?? 'unknown media type'}; raw audio data remains available to programmatic callers]`);
        break;
      case 'resource':
        text.push('[embedded resource unsupported; raw resource data remains available to programmatic callers]');
        break;
      default:
        text.push(`[unsupported MCP content type: ${block.type}]`);
    }
  }
  const content = text.length > 0 ? text.join('\n') : `(${rawToolName} returned no model-visible content)`;
  return { content, attachments };
}

/**
 * 把一个上游 MCP 工具适配成本注册表的 ToolDef。
 *
 * - 未声明的访问类别按注册表 fail-closed 规则落到 'write'(外部 MCP 工具能力不受本机约束,
 *   不能凭它的自述放宽到 read;plan 模式拒绝、confirm 模式审批)。
 * - `isError` 结果抛错,由注册表转成结构化错误结果(模型看得见失败,而不是假成功)。
 */
export function createMcpToolDef(options: McpToolDefinitionOptions): ToolDef {
  const { name, rawName, description, inputSchema } = options;
  return {
    name,
    description,
    parameters: inputSchema,
    access: 'write',
    async run(args: any, ctx: any) {
      if (options.taskRequired) {
        throw new Error(`Tool "${rawName}" requires task-based execution, which this bridge does not support`);
      }
      // 模型给的参数通常是对象,但可能给出裸字符串/数字/null:回落 {} 让 server 自己报
      // "缺少必填参数",这个错误模型能读懂并自我修正(harness 同一取舍)。
      const argsObj = (typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
      const result: any = await options.call(argsObj, ctx);
      if (!isRecord(result) || !Array.isArray(result.content)) {
        throw new Error(`Tool "${rawName}" returned an invalid MCP result: content must be an array`);
      }
      const projected = await projectMcpContent(result.content, rawName);
      // MCP isError → 抛错,让注册表产出 isError 结果给模型(harness 同一行为)
      if (result.isError === true) throw new Error(projected.content);
      return projected.attachments.length > 0
        ? { content: projected.content, attachments: projected.attachments }
        : { content: projected.content };
    }
  };
}

/**
 * 把 MCP server 当前的工具清单同步进注册表。
 *
 * 两阶段保证换代码安全:
 * 1. 取:让 SDK 聚合 `tools/list`,构造完整的新一代定义。此阶段任何失败(网络错误、
 *    重复的 raw 名)都直接抛出,旧一代原样保留;
 * 2. 换:注销旧一代、注册新一代。此处注册冲突只可能是外来注册占用了
 *    `mcp__<serverName>__` 命名空间 —— 整代回滚(该 server 一个工具都不留)并记日志。
 *
 * @returns 公开名 → 注销器的映射(该 server 当前真正持有的一整套注册)
 */
export async function syncMcpTools(
  client: Client,
  registry: ToolRegistry,
  opts: ToolBridgeOptions,
  previous: ToolDisposers,
  log: (msg: string) => void
): Promise<ToolDisposers> {
  // 阶段 1:只取不改注册表
  const definitions = new Map<string, ToolDef>();
  const response: any = client.getServerCapabilities()?.tools === undefined
    ? { tools: [] }
    : await client.listTools(undefined, { cacheMode: 'refresh' } as any);
  for (const tool of (response?.tools ?? []) as any[]) {
    const publicName = publicToolName(opts.serverName, String(tool.name));
    if (definitions.has(publicName)) {
      throw new Error(`mcp-client(${opts.serverName}): server listed tool "${tool.name}" more than once — invalid tool list`);
    }
    definitions.set(publicName, createMcpToolDef({
      name: publicName,
      rawName: String(tool.name),
      description: tool.description ?? '',
      inputSchema: (tool.inputSchema ?? { type: 'object', properties: {}, required: [] }) as Record<string, unknown>,
      taskRequired: tool.execution?.taskSupport === 'required',
      call: (args, ctx) => client.callTool(
        { name: tool.name, arguments: args },
        { signal: ctx?.signal, timeout: opts.toolCallTimeoutMs, toolDefinition: tool } as any
      ) as any
    }));
  }

  // 阶段 2:整代切换
  for (const dispose of previous.values()) dispose();
  const disposers: ToolDisposers = new Map();
  try {
    for (const [publicName, definition] of definitions) {
      disposers.set(publicName, registry.register(definition));
    }
  } catch (error: any) {
    for (const dispose of disposers.values()) dispose();
    log(`mcp-client(${opts.serverName}): tool registration failed, no tools registered: ${String(error)}`);
    registry.invalidateSchemasCache();
    return new Map();
  }
  registry.invalidateSchemasCache();
  return disposers;
}
