// 运行终端清单的**共享缓存**(等价 dsh 0.2.1-rc 的 0ae278b935 "share terminal discovery per session")。
//
// 问题:终端清单有两个消费方 —— 会话列表的状态点(useRunningTermSessions)与运行终端面板
// (AiTermPanel)。以前它们各自在挂载时发一次 ai_term_list,同一窗口里同时打开面板 +
// 看会话列表就会打两次同样的请求;面板每次重新挂载又要再拉一次。
//
// 语义(对齐上游 TerminalInventory):
//   - 一次成功的清单与一次失败的结果都**缓存**,直到显式 refresh(避免失败被反复重试成请求风暴);
//   - 并发读共享同一次在途请求;
//   - 清单在途期间收到的 start/exit 增量会合并覆盖,不会被更早发出的旧响应盖回去;
//   - 断线重连(WS open)时由调用方 retry(),重拉一次。
// 服务端 ai_term_list 返回的是**全部**运行中终端(含 sid),所以这份缓存天然是全局一份。
// 显式带 .ts 后缀:本模块的单测用 Node 直接跑(Node ESM 不支持目录 import),
// Vite/tsc 两种解析都能接受(tsconfig 已开 allowImportingTsExtensions)。
import { api } from '../api/index.ts';
import type { AiTermInfo } from '../types';

let items: AiTermInfo[] | null = null;
let inflight: Promise<AiTermInfo[]> | null = null;
/** 已失败的错误:显式 refresh 前一直复用它,不再发请求 */
let failure: Error | null = null;
/** 在途请求期间收到的增量(id → 条目;null = 已消失) */
let pending = new Map<string, AiTermInfo | null>();
const listeners = new Set<(list: AiTermInfo[]) => void>();

function emit(): void {
  const list = items ?? [];
  for (const fn of listeners) fn(list);
}

/** 当前缓存的清单;尚未拉取过时为 null(调用方据此区分"空"与"未知") */
export function termInventory(): AiTermInfo[] | null {
  return items;
}

/**
 * 读清单(共享缓存)。
 * @param refresh 显式重取:替换已成功或已失败的结果;并发调用仍共享同一次请求。
 */
export function readTermInventory(refresh = false): Promise<AiTermInfo[]> {
  if (inflight !== null) return inflight;
  if (!refresh && items !== null) return Promise.resolve(items);
  if (!refresh && failure !== null) return Promise.reject(failure);
  pending = new Map();
  const request = (async () => {
    try {
      const r = await api.request('ai_term_list', {}, 10000, 'ai_term_list');
      const list: AiTermInfo[] = Array.isArray(r?.terms) ? r.terms : [];
      const byId = new Map(list.map((t) => [String(t.id), t]));
      // 增量优先:在途期间确认的 start/exit 比这份响应更新
      for (const [id, info] of pending) {
        if (info === null) byId.delete(id);
        else byId.set(id, info);
      }
      items = [...byId.values()];
      failure = null;
      return items;
    } catch (error) {
      failure = error instanceof Error ? error : new Error('终端清单拉取失败');
      throw failure;
    } finally {
      inflight = null;
      pending = new Map();
    }
  })();
  inflight = request;
  void request.then(emit, () => { /* 失败不广播:调用方各自处理重试 */ });
  return request;
}

/** 断线重连后重拉一次(没有在途请求时才发;缓存里的成功/失败都会被替换) */
export function retryTermInventory(): Promise<AiTermInfo[]> {
  return readTermInventory(true);
}

/** 收到 start 事件:乐观写入缓存;若清单还没拉过就不必造一份(首拉会带上它) */
export function upsertTermInventory(info: AiTermInfo): void {
  if (!info?.id) return;
  if (items !== null) {
    const i = items.findIndex((t) => String(t.id) === String(info.id));
    if (i >= 0) items[i] = info; else items = [...items, info];
  }
  if (inflight !== null) pending.set(String(info.id), info);
  emit();
}

/** 收到 exit / removed 事件:从缓存移除 */
export function removeTermInventory(id: string): void {
  if (!id) return;
  if (items !== null) items = items.filter((t) => String(t.id) !== id);
  if (inflight !== null) pending.set(id, null);
  emit();
}

/** 订阅清单变化(面板/状态点据此重绘);返回退订函数 */
export function subscribeTermInventory(fn: (list: AiTermInfo[]) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * 把 WS 的 ai_term 事件与重连接到缓存上。**全局只挂一次**(引用计数,最后一个订阅者退出时解挂):
 * 两个消费方(会话状态点 / 终端面板)各自再挂一遍就会重复处理同一条事件。
 */
let bridgeRefs = 0;
let detachBridge: (() => void) | null = null;
export function useTermInventoryBridge(): () => void {
  bridgeRefs += 1;
  if (detachBridge === null) {
    const offTerm = api.on('ai_term', (m: any) => {
      const id = String(m?.id || m?.term?.id || '');
      if (!id) return;
      if (m.event === 'start') {
        const term = m?.term as AiTermInfo | undefined;
        if (term) upsertTermInventory(term);
      } else if (m.event === 'exit' || m.event === 'removed') {
        removeTermInventory(id);
      }
    });
    const offOpen = api.on('open', () => { void retryTermInventory().catch(() => { /* 断了就等下次 open */ }); });
    detachBridge = () => { offTerm(); offOpen(); };
  }
  return () => {
    bridgeRefs -= 1;
    if (bridgeRefs <= 0 && detachBridge !== null) { detachBridge(); detachBridge = null; }
  };
}

/** 测试用:清空全部缓存状态 */
export function resetTermInventoryForTest(): void {
  items = null;
  inflight = null;
  failure = null;
  pending = new Map();
  listeners.clear();
}
