// MCP 传输工厂:按配置产出 stdio 或 Streamable HTTP 传输。
// 逐字对应 deepseek-harness 的 packages/mcp/mcp-client/src/transport.ts。
import type { Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { McpServerConfig } from './store.ts';

/**
 * 凭据形状的环境变量名:KEY / PASSWORD / SECRET / TOKEN 命中即剔除。
 * (harness 的 subprocess 缝同一口径:子进程不该继承宿主的密钥)
 */
const CREDENTIAL_NAME = /KEY|PASSWORD|SECRET|TOKEN/i;

/**
 * 本工具自己的控制变量前缀(teleforge 用 `TELEFORGE_*`),以及 harness 的同一口径
 * `DSH_*`(harness 的 `scrubbedParentEnv()` 剔除的正是 `DSH_*`)。
 * 两者都属于宿主进程、对 MCP 子进程无意义,留着只会误导(例如 DATA_DIR 让子进程写错目录)。
 */
const OWN_PREFIX = /^(?:TELEFORGE_|DSH_)/i;

/**
 * 已擦除凭据与本工具控制变量的父环境。
 * 与 harness 的 `scrubbedParentEnv()` 同义:MCP 子进程默认不继承宿主的密钥。
 */
export function scrubbedParentEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (CREDENTIAL_NAME.test(k) || OWN_PREFIX.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** 子进程环境 = 擦除后的父环境 + 显式配置的 env(显式覆盖永远生效)。 */
export function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra };
}

/**
 * 按配置创建 MCP 传输(未连接状态,由 SDK 的 Client.connect 负责启动)。
 * @param config 已净化的服务器配置(按 transport 判定 stdio / streamable-http)
 */
export function createTransport(config: McpServerConfig): Transport {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: buildChildEnv(config.env),
      cwd: config.cwd
    });
  }
  return new StreamableHTTPClientTransport(
    new URL(config.url),
    { requestInit: { headers: config.headers } }
  );
}
