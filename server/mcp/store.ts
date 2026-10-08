// MCP(Model Context Protocol)服务器清单的持久化与净化。
//
// 字段逐项对齐 deepseek-harness 的 @deepseek-ai/dsh-mcp-client Config:
//   transport / serverName / command / args / env / cwd / url / headers /
//   toolCallTimeoutMs / failOnStartupError / maxInstructionBytes / reconnect
// 差异只有一处:harness 用 cordis.yml 里"一行一个插件实例"表达启停(删掉那行即停用),
// 这里用一个 enabled 布尔,供界面直接开关(默认 true,与"配了就连"一致)。
//
// 落盘 data/mcp-servers.json(测试可用 MCP_SERVERS_FILE 隔离),原子写防损坏。
import fs from 'node:fs';
import path from 'node:path';
import { MCP_SERVERS_FILE as CONFIG_FILE } from '../config.ts';
import { writeFileAtomic } from '../store/atomic-write.ts';

/** 传输方式:stdio(本机子进程)或 streamable-http(远端 HTTP 服务);与 harness 同名同义。 */
export type McpTransport = 'stdio' | 'streamable-http';

/**
 * 断线自动重连策略(harness 的 ReconnectConfig 原样搬运)。
 * 一次断线共享一个尝试预算:延迟从 initialDelayMs 起每失败一次翻倍,封顶 maxDelayMs;
 * 连续失败 maxAttempts 次后放弃(注销该 server 的工具,直到重新加载配置)。
 */
export interface McpReconnectConfig {
  enabled?: boolean;
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}

/** 一条 MCP 服务器配置(歧义字段按 transport 解释,与 harness 的联合类型等价)。 */
export interface McpServerConfig {
  /** 本机命名空间:`mcp__<serverName>__<rawName>`;`[A-Za-z0-9_-]{1,32}` 且全局唯一。 */
  serverName: string;
  /** 是否启用(等价于 harness 里"这条插件行在不在")。 */
  enabled: boolean;
  transport: McpTransport;
  // ---- stdio ----
  /** 可执行文件。 */
  command: string;
  /** 直接透传的参数,不经 shell 插值。 */
  args: string[];
  /** 叠加在"已擦除凭据的父环境"之上的额外环境变量。 */
  env: Record<string, string>;
  /** 子进程工作目录。 */
  cwd: string;
  // ---- streamable-http ----
  /** MCP 端点 URL。 */
  url: string;
  /** 附加到 MCP 请求上的请求头。 */
  headers: Record<string, string>;
  // ---- 公共 ----
  /** 单次 tools/call 或资源请求的超时(毫秒)。 */
  toolCallTimeoutMs: number;
  /** 初次连接或工具同步失败时,是否让整个接入失败(fail loud);默认 false 只记日志并重连。 */
  failOnStartupError: boolean;
  /** 服务器 instructions 的 UTF-8 字节上限;超限拒绝该次连接。 */
  maxInstructionBytes: number;
  /** 断线重连策略;缺省用默认值。 */
  reconnect: McpReconnectConfig;
}

/** `serverName` 合法形状(harness 原文:keep it below the public tool-name budget)。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** 单次 MCP 工具调用/资源请求的默认超时(harness 同一常量)。 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;

/** 服务器 instructions 的默认字节上限(harness 同一常量)。 */
export const DEFAULT_MAX_INSTRUCTION_BYTES = 32_768;

/** 重连策略默认值(harness 的 RECONNECT_DEFAULTS 原文)。 */
export const MCP_RECONNECT_DEFAULTS: Required<McpReconnectConfig> = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10
});

/** setTimeout 能表达的最大延迟(与 harness 的 MAX_TIMER_DELAY_MS 同义)。 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface StoreFile {
  version: number;
  servers: McpServerConfig[];
}

/** 净化一段字符串字典(env / headers):只保留字符串键值,去掉空键。 */
function sanitizeDict(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(k ?? '').trim();
    if (!key) continue;
    out[key] = String(v ?? '');
  }
  return out;
}

/** 净化字符串数组(args):逐项转字符串,允许空串(有些 server 就靠空参数占位)。 */
function sanitizeStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((v) => String(v ?? '')) : [];
}

/** 约束到 [min, max] 的有限数;非法/缺失回落 fallback。 */
function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 净化重连策略:只保留 harness 认识的四个键,非法键直接丢弃(不静默放过拼写错误之外的语义)。 */
function sanitizeReconnect(raw: unknown): McpReconnectConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: McpReconnectConfig = {};
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  if (r.initialDelayMs !== undefined) out.initialDelayMs = clampInt(r.initialDelayMs, MCP_RECONNECT_DEFAULTS.initialDelayMs, 1, MAX_TIMER_DELAY_MS);
  if (r.maxDelayMs !== undefined) out.maxDelayMs = clampInt(r.maxDelayMs, MCP_RECONNECT_DEFAULTS.maxDelayMs, 1, MAX_TIMER_DELAY_MS);
  if (r.maxAttempts !== undefined) out.maxAttempts = clampInt(r.maxAttempts, MCP_RECONNECT_DEFAULTS.maxAttempts, 1, Number.MAX_SAFE_INTEGER);
  return out;
}

/**
 * 净化一条配置:非法输入返回 null(调用方转成 HTTP 400 / RPC 错误)。
 * 校验口径与 harness 的 Schemastery Config 一致:
 * serverName 必须匹配 `[A-Za-z0-9_-]{1,32}`;stdio 必须有 command;streamable-http 必须有 http(s) URL。
 */
export function sanitizeServerConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, any>;
  const serverName = String(r.serverName || '').trim();
  if (!SERVER_NAME_PATTERN.test(serverName)) return null;
  const transport: McpTransport = r.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
  const command = String(r.command || '').trim();
  const url = String(r.url || '').trim().replace(/\/+$/, '');
  if (transport === 'stdio' && !command) return null;
  if (transport === 'streamable-http' && !/^https?:\/\//i.test(url)) return null;
  return {
    serverName,
    enabled: r.enabled !== false,
    transport,
    command: transport === 'stdio' ? command : '',
    args: transport === 'stdio' ? sanitizeStringArray(r.args) : [],
    env: transport === 'stdio' ? sanitizeDict(r.env) : {},
    cwd: transport === 'stdio' ? String(r.cwd || '').trim() : '',
    url: transport === 'streamable-http' ? url : '',
    headers: transport === 'streamable-http' ? sanitizeDict(r.headers) : {},
    toolCallTimeoutMs: clampInt(r.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS, 1, MAX_TIMER_DELAY_MS),
    failOnStartupError: r.failOnStartupError === true,
    maxInstructionBytes: clampInt(r.maxInstructionBytes, DEFAULT_MAX_INSTRUCTION_BYTES, 1, MAX_TIMER_DELAY_MS),
    reconnect: sanitizeReconnect(r.reconnect)
  };
}

/** 读整份清单(文件缺失/损坏按空表处理,绝不因一份坏配置卡死启动)。 */
export function listServerConfigs(): McpServerConfig[] {
  let j: any = null;
  try { j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* 首次启动无文件 */ }
  const raw = Array.isArray(j?.servers) ? j.servers : [];
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const cfg = sanitizeServerConfig(item);
    // 同名只留第一条:harness 里同名第二个实例会在加载时报错并保持前一个不变
    if (!cfg || seen.has(cfg.serverName)) continue;
    seen.add(cfg.serverName);
    out.push(cfg);
  }
  return out;
}

function persist(servers: McpServerConfig[]): void {
  const body: StoreFile = { version: 1, servers };
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  writeFileAtomic(CONFIG_FILE, JSON.stringify(body, null, 2));
}

/**
 * 用一份新的 `servers` 数组整体替换配置(界面上就是"编辑那份 JSON")。
 *
 * 校验口径:
 * - 必须是数组;每一项都必须能净化,否则抛错并指明是第几项、错在哪(不静默丢弃);
 * - `serverName` 不得重复 —— 与 harness 一致:同名第二个实例会让加载失败,而不是悄悄覆盖。
 * 校验全部通过后才落盘,所以一份写坏了的配置不会把现有可用配置毁掉。
 *
 * @returns 净化后的配置(已落盘;`args/env/headers` 的缺省值已补齐,可原样回显给界面)
 */
export function replaceServerConfigs(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) throw new Error('MCP 配置必须是一个数组,每个元素是一个 server 对象(如 [{ "serverName": "fs", "transport": "stdio", "command": "npx" }])');
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  raw.forEach((item: unknown, i: number) => {
    const cfg = sanitizeServerConfig(item);
    if (!cfg) {
      const name = (item as any)?.serverName;
      const why = !item || typeof item !== 'object' || Array.isArray(item)
        ? '不是一个对象'
        : !SERVER_NAME_PATTERN.test(String((item as any).serverName || '').trim())
          ? `serverName 非法(需匹配 [A-Za-z0-9_-]{1,32},当前 ${JSON.stringify(name ?? null)})`
          : (item as any).transport === 'streamable-http'
            ? 'streamable-http 需要合法的 http(s) url'
            : 'stdio 需要填 command';
      throw new Error(`第 ${i + 1} 项配置非法:${why}`);
    }
    if (seen.has(cfg.serverName)) throw new Error(`serverName 重复:${cfg.serverName}(每个 server 的名称必须唯一)`);
    seen.add(cfg.serverName);
    out.push(cfg);
  });
  persist(out);
  return out;
}

