/**
 * @deepseek-ai/dsh-api-remotes/client 的适配。
 *
 * dsh 的「Client Remote」是宿主侧的远程调用面:面板只拿到这个面,不关心背后是
 * WebSocket、HTTP 还是本地调用。Teleforge 的 RPC 走自己的 api 客户端,所以这里
 * 提供**结构一致的类型 + 一个能用的流封装**,真正的实现由宿主接线时注入。
 *
 * 形状来源(逐字对着搬运代码的用法核过,不是猜的):
 *  - `ui-sidebar-files/client/face.ts` 的 `createList`:
 *      `remote.workspaceFiles.list(sessionId, path, signal)` → `{ ok, value: { entries, truncated } }`
 *  - 同文件 `createWatch`:
 *      `remote.$stream<T>({ name, open: lifetime => remote.workspaceFiles.changes(...), ended: () => Error })`
 *      然后 `for await (const item of stream)`, `item.value.kind`, `item.accept()`, `await stream.dispose()`
 *  - 失败分支读 `result.error`(不是 `result.failure`)——见 face.ts 的 `actions.failed(tabId, path, result.error)`
 */
import type { WorkspaceDirectoryEntry, WorkspaceFileWatchFrame } from '../api-workspace-files/index.ts';

export interface RemoteFailure {
  readonly message: string;
  readonly code?: string;
}

export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteFailure };

/** 一帧流数据:accept() 表示「这帧已被消费」(dsh 的背压/确认约定) */
export interface RemoteStreamItem<T> {
  readonly value: T;
  readonly accept: () => void;
}

/** 远程流:既是异步可迭代,也能主动释放 */
export interface RemoteStream<T> extends AsyncIterable<RemoteStreamItem<T>> {
  readonly dispose: () => Promise<void>;
}

export interface RemoteStreamOptions<T = unknown> {
  /** 诊断名(出错信息里用) */
  readonly name: string;
  /** 打开流:lifetime 结束时应当停止 */
  readonly open: (lifetime: AbortSignal) => AsyncIterable<T> | Promise<AsyncIterable<T>>;
  /** 流意外结束时构造的错误 */
  readonly ended: () => Error;
}

/** 目录列举的返回:树只需要 entries + truncated(face.ts 里就是这么裁的) */
export interface WorkspaceFilesListResult {
  readonly entries: readonly WorkspaceDirectoryEntry[];
  readonly truncated: boolean;
}

export interface ClientRemote {
  /** 普通请求/响应调用 */
  readonly call: (method: string, params?: unknown) => Promise<RemoteResult<unknown>>;
  /** 流式调用(目录变更监听走它) */
  readonly $stream: <T>(options: RemoteStreamOptions<T>) => RemoteStream<T>;
  /** 工作区文件命名空间:面板只用到 list(列举)与 changes(变更流) */
  readonly workspaceFiles: {
    readonly list: (
      sessionId: string,
      path: string,
      signal: AbortSignal,
    ) => Promise<RemoteResult<WorkspaceFilesListResult>>;
    readonly changes: (
      sessionId: string,
      path: string,
      lifetime: AbortSignal,
    ) => AsyncIterable<WorkspaceFileWatchFrame>;
  };
}

/**
 * 把一个异步可迭代包装成 `RemoteStream`:每帧带 accept(),dispose 会中止 source。
 * 宿主接线时用它把 Teleforge 的推送(或"无事件"的空流)接上——面板不关心来源。
 */
export function makeRemoteStream<T>(
  name: string,
  source: (lifetime: AbortSignal) => AsyncIterable<T> | Promise<AsyncIterable<T>>,
  ended: () => Error,
): RemoteStream<T> {
  const controller = new AbortController();
  const state = { started: false };
  async function* iterate(): AsyncGenerator<RemoteStreamItem<T>> {
    if (state.started) throw new Error(`Remote stream already consumed: ${name}`);
    state.started = true;
    const inner = await source(controller.signal);
    for await (const value of inner) {
      if (controller.signal.aborted) return;
      yield { value, accept: () => { /* 单消费者流:收到即已交付,无需额外确认 */ } };
    }
    // 源自然结束:dsh 约定此时抛 ended(),由上层决定是重连还是报错
    if (!controller.signal.aborted) throw ended();
  }
  return {
    [Symbol.asyncIterator]: iterate,
    dispose: async () => { controller.abort(); },
  };
}

/** 直接按 options 造流,供宿主实现 `$stream` 时复用 */
export function streamFromOptions<T>(options: RemoteStreamOptions<T>): RemoteStream<T> {
  return makeRemoteStream(options.name, options.open, options.ended);
}
