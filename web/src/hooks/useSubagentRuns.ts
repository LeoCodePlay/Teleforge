// 子智能体运行记录的数据源 —— 从原 SubagentPanel 里原样抽出来的那段(列表 + 实时事件 + 兜底轮询),
// 现在由会话头部的 catalog(SessionHeader)消费。
//
// 数据来源(与后端一致,没有新增接口):
//   列表     = RPC subagent_list { sid } → { runs: SubagentRunInfo[] }
//   实时变更 = agent 事件流 event='subagent_changed'(只带 runId + status,正文按需另拉)
//   断线重连 = api.on('open') 重拉
//
// 只列**当前会话**派发的记录:草稿会话(sid 为 null)名下不可能有派发,直接给空列表。

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { SubagentRunInfo } from '../types';

/** 运行中记录的兜底刷新间隔(事件为主,轮询只防丢事件;与原面板同一口径)。 */
const POLL_MS = 1500;

export interface SubagentRunsResult {
  runs: SubagentRunInfo[];
  /** 首次加载中(列表还是空的);用于弹层里的「正在加载子智能体…」 */
  loading: boolean;
  /** 拉取失败的原因;非空时弹层显示「无法加载子智能体」+ 重试 */
  error: string | null;
  /** 手动重拉(弹层的重试按钮 / catalog 的 refreshProjection 等价物) */
  refresh: () => void;
}

/**
 * 订阅当前会话的子智能体派发记录。
 * @param sid - 当前会话 id;null(草稿会话)时永远返回空列表。
 * @returns 列表、加载态、错误与重拉函数(refresh 引用稳定)。
 */
export function useSubagentRuns(sid: string | null): SubagentRunsResult {
  const [runs, setRuns] = useState<SubagentRunInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [settledOnce, setSettledOnce] = useState(false);
  const mountedRef = useRef(true);
  const sidRef = useRef(sid);
  sidRef.current = sid;

  const fetchList = useCallback(async () => {
    const want = sidRef.current;
    if (!want) {
      setRuns([]);
      setError(null);
      setSettledOnce(true);
      return;
    }
    try {
      const r = await api.request('subagent_list', { sid: want }, 10000, 'subagent_list');
      if (!mountedRef.current || sidRef.current !== want) return;
      setRuns(Array.isArray(r?.runs) ? r.runs : []);
      setError(null);
    } catch (e) {
      if (!mountedRef.current || sidRef.current !== want) return;
      // 服务端未起/断线:如实显示,不假装「没有记录」
      setError((e as Error)?.message || '派发记录拉取失败');
    } finally {
      if (mountedRef.current) setSettledOnce(true);
    }
  }, []);

  const refresh = useCallback(() => { void fetchList(); }, [fetchList]);

  // 挂载 / 切换会话 / 断线重连:重拉
  useEffect(() => {
    mountedRef.current = true;
    setRuns([]);
    setError(null);
    setSettledOnce(false);
    void fetchList();
    const offOpen = api.on('open', () => { void fetchList(); });
    return () => { mountedRef.current = false; offOpen(); };
  }, [sid, fetchList]);

  // 实时变更:事件只带 runId/status,列表整体重拉(量小,且能顺带带上 recall 的坏帧)
  useEffect(() => {
    const off = api.on('agent', (m: any) => {
      if (m?.event !== 'subagent_changed') return;
      if (sidRef.current && m.sid && m.sid !== sidRef.current) return;
      void fetchList();
    });
    return () => { off(); };
  }, [fetchList]);

  // 运行中兜底轮询
  const runningCount = runs.filter((r) => r.status === 'running').length;
  useEffect(() => {
    if (runningCount === 0) return;
    const timer = setInterval(() => { void fetchList(); }, POLL_MS);
    return () => { clearInterval(timer); };
  }, [runningCount, fetchList]);

  return { runs, loading: !settledOnce, error, refresh };
}
