// MCP 接入的总管理器:读取配置清单 → 为每条启用的配置起一个受监督连接 → 暴露状态与重载。
//
// 对应 deepseek-harness 里"每个 server 一行 mcp-client 插件"的整体装配:
// harness 的装配由 cordis.yml 驱动、改哪一行就热替换哪个实例;这里由 data/mcp-servers.json
// 驱动,reconcile(serverName) 做一件等价的事——先完全拆卸该 server 的旧连接,
// 再按新配置重建,其余 server 不受影响(工具名不变,会话历史与权限规则照样对齐)。
import { toolRegistry } from '../agent/agent.ts';
import { listServerConfigs, replaceServerConfigs, type McpServerConfig } from './store.ts';
import { resolveReconnectPolicy, startConnection, type ConnectionHandle, type McpServerStatus } from './connection.ts';
import { renderMcpPromptSections } from './state.ts';

/** 服务器状态 + 它的配置,界面一次拿全。 */
export interface McpServerView {
  config: McpServerConfig;
  status: McpServerStatus;
}

/** 统一日志出口(host 日志里带 [mcp] 前缀,便于和工具日志区分)。 */
function log(level: 'info' | 'warn' | 'error', msg: string): void {
  const line = `[mcp] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

class McpManager {
  /** serverName → 活的连接句柄(仅启用的 server)。 */
  private handles = new Map<string, ConnectionHandle>();
  /** 最近一次加载进来的完整配置清单(含未启用的,供界面展示)。 */
  private configs: McpServerConfig[] = [];

  /**
   * 按当前配置启动全部启用项(由 server/index.ts 调用一次)。
   * 与 harness 一致:单个 server 连接失败只影响它自己(记日志 + 自动重连),
   * 绝不让整个宿主起不来;配了 failOnStartupError 的失败会以 error 级别落日志。
   */
  async start(): Promise<void> {
    this.configs = listServerConfigs();
    for (const config of this.configs) {
      if (config.enabled) this.spawn(config);
    }
  }

  /** 停掉全部连接(进程退出 / 整体重载前)。 */
  async dispose(): Promise<void> {
    const handles = [...this.handles.values()];
    this.handles.clear();
    await Promise.allSettled(handles.map((h) => h.dispose()));
  }

  /**
   * 用一份新的 servers 数组整体替换配置(界面上"编辑那份 JSON 后保存")。
   *
   * 只有**真正变化**的 server 才重建连接:新增的起、删掉的停、改过的先完全拆卸再按新配置重建,
   * 没动过的一律不碰(对应 harness "editing the configuration entry reloads that connection
   * in place, and unchanged names stay unchanged")。
   * 校验失败直接抛出,此时磁盘与现有连接都没被改动。
   */
  async saveAll(rawServers: unknown): Promise<void> {
    const before = new Map(this.configs.map((c) => [c.serverName, JSON.stringify(c)]));
    const saved = replaceServerConfigs(rawServers);
    const after = new Map(saved.map((c) => [c.serverName, JSON.stringify(c)]));
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((n) => before.get(n) !== after.get(n));
    for (const name of changed) await this.reconcile(name);
  }

  /** 整体重载:拆卸全部连接后按当前清单重建。 */
  async reload(): Promise<void> {
    await this.dispose();
    await this.start();
  }

  /**
   * 只重建一个 server 的连接(配置就它变了):旧连接先完全拆卸,
   * 再按最新配置决定"起新的"还是"就此停用"。其余 server 一动不动。
   */
  async reconcile(serverName: string): Promise<void> {
    const existing = this.handles.get(serverName);
    if (existing) {
      this.handles.delete(serverName);
      await existing.dispose();
    }
    this.configs = listServerConfigs();
    const config = this.configs.find((c) => c.serverName === serverName);
    if (config?.enabled) this.spawn(config);
  }

  /** 起一个受监督连接;连接结果异步报告,不阻塞调用方。 */
  private spawn(config: McpServerConfig): void {
    let policy;
    try {
      policy = resolveReconnectPolicy(config.reconnect, `mcp-server(${config.serverName}): reconnect`);
    } catch (error: any) {
      log('error', `mcp-server(${config.serverName}): 重连策略非法,已跳过该 server: ${error?.message || error}`);
      return;
    }
    const handle = startConnection(toolRegistry, config, policy, log);
    this.handles.set(config.serverName, handle);
    // 不阻塞宿主启动:连接与工具发现异步完成,界面通过状态接口查看结果。
    // (harness 会 await 初次连接再让插件激活;这里没有"插件激活"这一步,
    //  先把 HTTP 服务拉起来对用户更友好,工具晚一两秒出现不影响使用。)
    void handle.ready.then((outcome) => {
      if (!this.handles.has(config.serverName)) return; // 期间已被替换/停用:这次报告已过期
      if (outcome.error !== undefined) {
        const level = config.failOnStartupError ? 'error' : 'warn';
        log(level, `mcp-server(${config.serverName}): 初次连接或工具同步失败: ${String((outcome.error as any)?.message || outcome.error)}`);
      } else {
        log('info', `mcp-server(${config.serverName}): 已连接,注册 ${handle.status().toolCount} 个工具`);
      }
    });
  }

  /** 当前状态视图(未启用的配置按"断开、0 工具"呈现)。 */
  statuses(): McpServerView[] {
    return this.configs.map((config) => {
      const handle = this.handles.get(config.serverName);
      return {
        config,
        status: handle
          ? handle.status()
          : { serverName: config.serverName, connected: false, toolCount: 0, tools: [], givenUp: false, error: null, hasInstructions: false }
      };
    });
  }
}

/** 全局单例:由 server/index.ts 启动、由 RPC 层读写。 */
export const mcpManager = new McpManager();

export { renderMcpPromptSections };
