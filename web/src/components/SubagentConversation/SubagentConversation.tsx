// 子智能体会话的宿主视图(只读) —— 与 dsh 的子会话正文同构:
//   一段普通对话(conversation.tsx)+ 底部把输入框换成的**只读说明框**(SubagentReadOnlyComposer)。
//
// 为什么输入框位置要放一个说明框:本项目的子智能体是**一次性派发**(父对话拿到结论即结束),
// 不支持在子会话里继续发消息。dsh 对 one-shot 子代理做的是同一件事 —— 用一块说明顶掉输入框,
// 而不是给一个禁用的输入框让用户猜为什么打不了字。
//
// 两个消费方共用本组件:
//   1. 主对话区(点会话头部 catalog 的一行);
//   2. 右侧栏的「子智能体会话」标签页。
// 因此它在主区与侧栏里长得完全一样(同一份 conversation.tsx、同一个只读框)。
//
// 数据:subagent_get { runId } → { run: SubagentRun }(列表/详情两个 RPC 见 server/store/subagent-store.ts)

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { IconReload16 } from '../icons/icons';
import { Conversation } from './conversation';
import { SubagentReadOnlyComposer } from '../SessionHeader/SubagentReadOnlyComposer';
import type { SubagentRun } from '../../types';
import './SubagentConversation.scss';

const POLL_MS = 1500; // 运行中兜底刷新(事件为主,轮询只防丢事件)

export default function SubagentConversation({ runId, active = true }: {
  /** 派发记录 id(标签/主区的 contentId 就是它,同一个子智能体不会开出两份) */
  runId: string;
  /** 是否可见:隐藏时不轮询(省掉后台空转) */
  active?: boolean;
}) {
  const [run, setRun] = useState<SubagentRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);

  const fetchRun = useCallback(async (id: string) => {
    try {
      // ⚠ api.request 解析的是**整个应答信封** { type, runId, run }(见 api/index.ts 的 _handle),
      // 所以这里必须取 .run;直接把信封当 run 用会让 run.messages 变成 undefined,
      // 随后 Conversation 遍历它就会抛 "is not iterable"。错误应答由 api.request 内部 reject。
      const r = await api.request('subagent_get', { runId: id }, 10000, 'subagent_run');
      if (!mountedRef.current) return;
      setRun((r?.run as SubagentRun) ?? null);
      setErr(null);
    } catch (e: any) {
      if (!mountedRef.current) return;
      setErr(e?.message || '读取失败');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // 切换 runId(换内容)时重置:否则会短暂显示上一个子智能体的对话
  useEffect(() => {
    mountedRef.current = true;
    setRun(null); setErr(null); setLoading(true);
    void fetchRun(runId);
    return () => { mountedRef.current = false; };
  }, [runId, fetchRun]);

  // 运行中兜底轮询;不可见时停掉
  useEffect(() => {
    if (!active || run?.status !== 'running') return;
    const t = setInterval(() => { void fetchRun(runId); }, POLL_MS);
    return () => clearInterval(t);
  }, [active, run?.status, runId, fetchRun]);

  // 新内容到达时贴底(只读回看,贴底是唯一合理的默认)
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.messages?.length]);

  return (
    <div className="sconv" data-subagent-conversation={runId}>
      <div className="sconv-body" ref={bodyRef}>
        {loading && !run && (
          <div className="sconv-skel" aria-busy="true" aria-label="加载中">
            <span className="sconv-skel-line" />
            <span className="sconv-skel-line w70" />
            <span className="sconv-skel-line w85" />
          </div>
        )}
        {err && !run && (
          <div className="sconv-err">
            <span>{err}</span>
            <button type="button" className="sconv-retry" onClick={() => { setLoading(true); void fetchRun(runId); }}>
              <IconReload16 size={12} />重试
            </button>
          </div>
        )}
        {run && (
          <>
            <Conversation messages={run.messages} />
            {run.status === 'running' && <div className="sconv-running">子智能体还在跑,新内容会自动出现</div>}
          </>
        )}
      </div>
      {/* 输入位:一次性派发的只读说明(dsh 的 SubagentReadOnlyComposer 原件) */}
      {run && <SubagentReadOnlyComposer reason="one-shot" />}
    </div>
  );
}
