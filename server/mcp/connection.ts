// MCP 连接监督者:为一个 server 持有"客户端 + 传输"的代际(generation),
// 让注册表里的工具集始终与当前代际一致;连接掉线时按有界指数退避重启。
//
// 逐字对应 deepseek-harness 的 packages/mcp/mcp-client/src/connection.ts:
// - 一次断线共享一个尝试预算(maxAttempts 次连续失败);延迟从 initialDelayMs 起翻倍,
//   封顶 maxDelayMs;连接存活超过 maxDelayMs 视为"上一次断线已结束",下次断线重置预算。
// - 预算耗尽 → 注销该 server 的工具并停止重连(直到重新加载配置或重启)。
// - 每次同步(初次/清单变化通知/重连)都排进同一条串行队列,避免两次同步交错换代码。
import { Client, type Transport } from '@modelcontextprotocol/client';
import type { ToolRegistry } from '../agent/registry.ts';
import { createTransport } from './transport.ts';
import { syncMcpTools, type ToolBridgeOptions, type ToolDisposers } from './tools.ts';
import {
  MAX_TIMER_DELAY_MS,
  MCP_RECONNECT_DEFAULTS,
  type McpReconnectConfig,
  type McpServerConfig
} from './store.ts';
import {
  clearServerInstructions,
  registerResourceProvider,
  setServerInstructions,
  unregisterResourceProvider,
  type McpResourceRequest
} from './state.ts';
import { syncResourceTools, type JsonValue } from './resources.ts';

/** 完全解析后的重连策略(插件加载时冻结)。 */
export type ResolvedReconnectPolicy = Readonly<Required<McpReconnectConfig>>;

const RECONNECT_KEYS = ['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts'] as const;

/**
 * 从原始 reconnect 配置解析出监督者实际执行的策略(harness 的同一"显式解析一步"):
 * 每一项都重新判定默认值与边界,配置错误在加载时就报出来,而不是运行到一半才炸。
 * @param config 原始 reconnect 配置;缺省用默认值
 * @param path 出错信息里的配置位置前缀
 */
export function resolveReconnectPolicy(config: McpReconnectConfig | undefined, path: string): ResolvedReconnectPolicy {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!(RECONNECT_KEYS as readonly string[]).includes(key)) {
        throw new Error(`${path}.${key} is not a reconnect option`);
      }
    }
  }
  const enabled = config?.enabled ?? MCP_RECONNECT_DEFAULTS.enabled;
  const initialDelayMs = config?.initialDelayMs ?? MCP_RECONNECT_DEFAULTS.initialDelayMs;
  const maxDelayMs = config?.maxDelayMs ?? MCP_RECONNECT_DEFAULTS.maxDelayMs;
  const maxAttempts = config?.maxAttempts ?? MCP_RECONNECT_DEFAULTS.maxAttempts;
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
  }
  if (initialDelayMs > maxDelayMs) {
    throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`);
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`${path}.maxAttempts must be a positive integer`);
  }
  return Object.freeze({ enabled, initialDelayMs, maxDelayMs, maxAttempts });
}

/** 初次连接尝试的结果(供启动等待语义判定)。 */
export interface ConnectionOutcome {
  error?: unknown;
}

/** 对外可读的连接状态(设置面板展示用)。 */
export interface McpServerStatus {
  serverName: string;
  connected: boolean;
  /** 当前注册到本 server 名下的公开工具数。 */
  toolCount: number;
  /** 当前注册到本 server 名下的公开工具名(界面展示 `mcp__server__tool` 用)。 */
  tools: string[];
  /** 已放弃重连(预算耗尽)。 */
  givenUp: boolean;
  /** 最近一次失败原因;成功连接后清空。 */
  error: string | null;
  /** 是否已发布服务器 instructions。 */
  hasInstructions: boolean;
}

/** 一个受监督连接的句柄。 */
export interface ConnectionHandle {
  /** 初次连接尝试结束时 settle(成功或失败);无论成败监督者都已进入自己的重连循环。 */
  ready: Promise<ConnectionOutcome>;
  /** 读取当前 server 上次成功连接发布的 instructions(未连接为空串)。 */
  instructions(): string;
  /** 当前连接代际的资源操作入口。 */
  resources: {
    request(request: McpResourceRequest, ctx: any): Promise<JsonValue>;
  };
  /** 当前状态快照。 */
  status(): McpServerStatus;
  /** 停止重连、关闭连接、等在途同步收敛,再注销该 server 仍持有的所有工具与提示段。 */
  dispose(): Promise<void>;
}

// SDK 的 stdio 传输自带两段 2 秒终止宽限;再加 1 秒等进程关闭事件,
// 证明上一代真的没了。超时按 fail-closed 处理,而不是让两个子进程重叠。
const GENERATION_CLOSE_TIMEOUT_MS = 5_000;

/**
 * 为一个 MCP server 启动受监督的连接,并按重连策略保持存活。
 * @param registry 本工具注册表(工具挂在这里)
 * @param config 已净化的服务器配置
 * @param policy 已解析的重连策略
 * @param log 日志出口(带 `[mcp]` 前缀的宿主日志)
 */
export function startConnection(
  registry: ToolRegistry,
  config: McpServerConfig,
  policy: ResolvedReconnectPolicy,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
): ConnectionHandle {
  const label = `mcp-client(${config.serverName})`;
  const incompleteDisposalMessage = `${label}: transport closure could not be confirmed during disposal — server shutdown may be incomplete`;
  const opts: ToolBridgeOptions = {
    serverName: config.serverName,
    toolCallTimeoutMs: config.toolCallTimeoutMs
  };

  let disposed = false;
  const maxInstructionBytes = config.maxInstructionBytes;
  let serverInstructions = '';
  /** 当前代际:连接中或已连接的客户端;退避等待期间与最终放弃后为 undefined。 */
  let client: Client | undefined;
  /** 与 {@link client} 配对的"感知传输"关闭操作。 */
  let closeClient: (() => Promise<boolean>) | undefined;
  /** 本 server 持有的活的工具注册;只有 {@link enqueueSync} 与 dispose 会换它。 */
  let disposers: ToolDisposers = new Map();
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** 当前断线周期内的连续失败次数。 */
  let failedAttempts = 0;
  /** 当前代际完成 connect + 初次同步的时刻;未连接时为 undefined。 */
  let connectedAt: number | undefined;
  /** 初次尝试的真实错误,供启动等待诊断。 */
  let firstAttemptError: unknown;
  /** 最近一次失败原因(连接成功后清空)。 */
  let lastError: string | null = null;
  /** 是否已放弃重连。 */
  let givenUp = false;

  /** 一个代际只有在它仍是"当前代际"且插件未释放时才可以行动。 */
  const isCurrent = (generation: Client): boolean => !disposed && client === generation;

  /**
   * 串行化每一次 syncMcpTools 调用(初次同步、通知触发的重同步、各代际的重连同步),
   * 保证两次同步的"注销旧一代 / 注册新一代"永不交错(交错会双重注销一代并泄漏另一代)。
   */
  let syncChain: Promise<void> = Promise.resolve();
  function enqueueSync(generation: Client): Promise<void> {
    const run = syncChain.then(async () => {
      if (!isCurrent(generation)) return;
      disposers = await syncMcpTools(generation, registry, opts, disposers, (m) => log('error', m));
    });
    // 队列尾部必须吞掉失败,否则一次失败会卡死之后所有同步;报告由入队方负责。
    syncChain = run.catch(() => {});
    return run;
  }

  /** 每次断线只判定一次:isCurrent 守卫让并发的 close/error 信号天然幂等。 */
  function generationDown(generation: Client): void {
    if (!isCurrent(generation)) return;
    client = undefined;
    closeClient = undefined;
    // 与 harness 一致:断线期间**保持**已注册的工具、资源入口与 instructions
    // ("the last known tools stay listed but calls to them fail until the server
    // recovers")——此时调过去会得到 "server is disconnected",而不是让工具凭空消失
    // 造成工具清单反复抖动(前缀缓存每次都要重建)。资源入口与 instructions 只在
    // 放弃重连或 dispose 时才撤下。
    scheduleReconnect();
  }

  /** 一代连接失败、关闭屏障收尾后,决定重试归属。 */
  function settleFailedGeneration(generation: Client, quiesced: boolean): void {
    if (!isCurrent(generation)) return;
    if (!quiesced) {
      client = undefined;
      closeClient = undefined;
      log('error', `${label}: failed generation could not confirm transport closure — reconnect stopped to avoid overlapping server processes; reload the plugin or restart the Host to retry`);
      return;
    }
    generationDown(generation);
  }

  /** 等传输自己报"已关闭",但不让坏掉的传输把拆卸永远挂住。 */
  function waitForClose(closed: Promise<void>): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => { resolve(false); }, GENERATION_CLOSE_TIMEOUT_MS);
      timeout.unref();
      void closed.then(() => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }

  function scheduleReconnect(): void {
    const lostEstablishedConnection = connectedAt !== undefined;
    if (!policy.enabled) {
      const message = lostEstablishedConnection
        ? 'connection lost and reconnect is disabled — registered tools will fail until a reload or Host restart'
        : 'connection failed and reconnect is disabled — no tools were registered; reload or restart the Host to connect';
      log('error', `${label}: ${message}`);
      return;
    }
    // 连接存活超过稳定窗口(= maxDelayMs,最长退避间隔)即视为上一次断线已结束:重置预算。
    if (connectedAt !== undefined && Date.now() - connectedAt >= policy.maxDelayMs) failedAttempts = 0;
    connectedAt = undefined;
    failedAttempts += 1;
    if (failedAttempts > policy.maxAttempts) {
      // 放弃的动作排进同步队列,避免与在途同步的阶段 2 换代码竞态。
      syncChain = syncChain.then(() => {
        for (const dispose of disposers.values()) dispose();
        disposers = new Map();
        serverInstructions = '';
        clearServerInstructions(config.serverName);
        // 预算耗尽 = "这个 server 不会回来了":连同资源入口一起撤下
        // (harness: exhausted recovery removes the tools and the instructions section)。
        unregisterResourceProvider(config.serverName);
        syncResourceTools(registry);
        givenUp = true;
        registry.invalidateSchemasCache();
      });
      log('error', `${label}: giving up after ${policy.maxAttempts} consecutive failed reconnect attempts — tools unregistered; reload or restart the Host to reconnect`);
      return;
    }
    const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (failedAttempts - 1));
    const action = lostEstablishedConnection ? 'connection lost; reconnecting' : 'connection failed; retrying';
    log('warn', `${label}: ${action} in ${delayMs}ms (attempt ${failedAttempts}/${policy.maxAttempts})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      settling = connectGeneration(false);
    }, delayMs);
    // 已排的重连定时器绝不该单独把进程挂住。
    reconnectTimer.unref();
  }

  /** 自造的 deferred:`Promise.withResolvers` 不在本项目的 lib(ES2022)类型里。 */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  /**
   * 一次连接尝试:全新传输 + 客户端(SDK 把 Protocol 与一个传输终身绑定),连接,
   * 再把初次工具同步排进队列。每个失败都经 {@link generationDown} 汇流;成功则交给
   * onclose 驱动的断线路径。本函数永不 reject。
   */
  async function connectGeneration(startup: boolean): Promise<void> {
    const generation = new Client(
      { name: 'teleforge-mcp-client', version: '0.3.0' },
      {
        capabilities: {},
        versionNegotiation: { mode: 'auto' },
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: () => { void refreshTools(); }
          }
        }
      } as any
    );
    const closed = deferred<void>();
    let attemptSettled = false;
    let closeObserved = false;
    let transport: Transport | undefined;
    const hasClosed = (): boolean => closeObserved;
    client = generation;
    closeClient = closeGeneration;
    generation.onclose = () => {
      closeObserved = true;
      closed.resolve();
      // 连接失败由下面的 catch 路径负责自己的关闭屏障;已建立的代际可以直接从这里下行。
      if (attemptSettled) generationDown(generation);
    };
    /** 未挂载的探测走传输关闭;已挂载的客户端还必须报告传输关闭。 */
    async function closeGeneration(): Promise<boolean> {
      const attached = generation.transport !== undefined;
      try {
        await (attached ? generation.close() : transport?.close());
      } catch {
        if (!attached) return hasClosed();
      }
      return !attached || hasClosed() || await waitForClose(closed.promise);
    }
    async function refreshTools(): Promise<void> {
      if (!isCurrent(generation)) return;
      log('info', `${label}: tool list changed, re-syncing`);
      try {
        await enqueueSync(generation);
      } catch (error: any) {
        if (!disposed) log('error', `${label}: tool re-sync failed: ${String(error?.message || error)}`);
      }
    }
    let instructions: string;
    try {
      transport = createTransport(config);
      await generation.connect(transport);
      if (hasClosed()) {
        attemptSettled = true;
        generationDown(generation);
        return;
      }
      if (!isCurrent(generation)) {
        if (!await closeGeneration()) log('error', incompleteDisposalMessage);
        return;
      }
      const serverText = generation.getInstructions()?.trimEnd() ?? '';
      instructions = serverText ? `### MCP server: ${config.serverName}\n\n${serverText}` : '';
      if (Buffer.byteLength(instructions) > maxInstructionBytes) {
        throw new Error(`${label}: server instructions exceed maxInstructionBytes (${maxInstructionBytes})`);
      }
      await enqueueSync(generation);
    } catch (error: any) {
      if (firstAttemptError === undefined) firstAttemptError = error;
      lastError = String(error?.message || error);
      // dispose 会先清掉"当前代际归属"再关闭代际,所以只有还活着的监督者会报这次失败。
      if (isCurrent(generation)) log('warn', `${label}: connection attempt failed: ${lastError}`);
      const quiesced = await closeGeneration();
      attemptSettled = true;
      settleFailedGeneration(generation, quiesced);
      return;
    }
    attemptSettled = true;
    if (hasClosed()) {
      generationDown(generation);
      return;
    }
    if (!isCurrent(generation)) return;
    serverInstructions = instructions;
    setServerInstructions(config.serverName, instructions);
    registerResourceProvider(config.serverName, {
      async request(request: McpResourceRequest, ctx: any): Promise<JsonValue> {
        return requestResources(generation, request, ctx);
      }
    });
    syncResourceTools(registry);
    connectedAt = Date.now();
    lastError = null;
    givenUp = false;
    if (failedAttempts > 0) log('info', `${label}: reconnected and re-synced tools (attempt ${failedAttempts}/${policy.maxAttempts})`);
  }

  /** 在"当前代际"上执行一次资源操作;断开时明确报错而不是静默返回空。 */
  async function requestResources(generation: Client, request: McpResourceRequest, ctx: any): Promise<JsonValue> {
    if (!isCurrent(generation) || client !== generation || connectedAt === undefined) {
      throw new Error(`${label}: server is disconnected`);
    }
    const options = { signal: ctx?.signal, timeout: config.toolCallTimeoutMs } as any;
    switch (request.method) {
      case 'resources/list':
        return await generation.listResources(request.cursor === undefined ? undefined : { cursor: request.cursor }, options) as unknown as JsonValue;
      case 'resources/templates/list':
        return await generation.listResourceTemplates(request.cursor === undefined ? undefined : { cursor: request.cursor }, options) as unknown as JsonValue;
      case 'resources/read':
        return await generation.readResource({ uri: request.uri }, options) as unknown as JsonValue;
      default:
        throw new Error(`${label}: unsupported resource request`);
    }
  }

  /** 在途(或最后一次已结算)的连接尝试;dispose 会等它,以获得"已收敛"的保证。 */
  let settling = connectGeneration(true);

  // ready 在第一次尝试结束时 settle(无论成败)。若首次失败且开了重连,
  // 监督者此刻已经在排重试了,ready 只如实报告结果。
  const ready: Promise<ConnectionOutcome> = settling.then(() => {
    if (client !== undefined) return {};
    return { error: firstAttemptError ?? new Error(`${label}: initial connection failed`) };
  });

  return {
    ready,
    instructions: () => serverInstructions,
    resources: {
      async request(request: McpResourceRequest, ctx: any): Promise<JsonValue> {
        const generation = client;
        if (!generation || connectedAt === undefined) throw new Error(`${label}: server is disconnected`);
        return requestResources(generation, request, ctx);
      }
    },
    status(): McpServerStatus {
      return {
        serverName: config.serverName,
        connected: client !== undefined && connectedAt !== undefined,
        toolCount: disposers.size,
        tools: [...disposers.keys()].sort(),
        givenUp,
        error: lastError,
        hasInstructions: serverInstructions !== ''
      };
    },
    async dispose(): Promise<void> {
      disposed = true;
      serverInstructions = '';
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const close = closeClient;
      client = undefined;
      closeClient = undefined;
      clearServerInstructions(config.serverName);
      unregisterResourceProvider(config.serverName);
      syncResourceTools(registry);
      if (close !== undefined && !await close()) {
        log('error', incompleteDisposalMessage);
      }
      // 求"收敛"而不只是"请求":在途尝试会在结算前把它的同步排进队列,
      // 两个都 await 之后 disposers 才是最终态。
      await settling;
      await syncChain;
      for (const dispose of disposers.values()) dispose();
      disposers = new Map();
      registry.invalidateSchemasCache();
    }
  };
}
