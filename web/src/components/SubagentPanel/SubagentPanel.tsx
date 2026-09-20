// 子代理面板:对话区右上角悬浮胶囊 + 右侧抽屉(派发记录列表 + 某次派发的完整对话)。
//
// 为什么需要它:子代理的过程**刻意不回传父会话**(父会话只多一条 tool/result),
// 但"它到底查了什么、为什么给这个结论"必须可追溯。于是每次派发落一份运行记录
// (server/store/subagent-store.ts),这里只读回看。
//
// 数据来源:
//   列表/详情 = RPC(subagent_list / subagent_get)
//   实时变更  = agent 事件流里的 event='subagent_changed'(带 runId + status,不含正文)
// 只读语义:没有任何写入口(不改、不删、不续聊、不能发送);子代理记录是"已发生事实"的快照。
//
// 展示口径:详情区**照搬正常 AI 对话的样式** —— 父对话下发的提示词是用户气泡,
// 子代理的思考/正文/工具调用用与主对话同一套渲染原子(assistantText + ToolCallList)。
// 不显示步数、调用次数、token 这类过程元信息:它就是一段只读的对话。
//
// 布局:桌面/平板 = 左列表 + 右对话(两栏);手机 = 单栏,选中后进入对话并可返回。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { useIsPhone } from '../../hooks/useMediaQuery';
import { StateDot } from '../StateDot/StateDot';
import { IconArrowLeft16, IconReload16, IconSparkle16 } from '../icons/icons';
import { AssistantSegment, ReasoningSegment } from '../ChatPanel/assistantText';
import { ToolCallList } from '../ToolCallList/ToolCallList';
import type {
  ChatMessage, MsgSegment, ToolCallInfo, SubagentMessage, SubagentRun, SubagentRunInfo
} from '../../types';
import './SubagentPanel.scss';

const POLL_MS = 1500; // 运行中记录的兜底刷新(事件为主,轮询只防丢事件)

/** 状态文案与状态点语义(点=真实状态,不是装饰) */
function statusOf(s: SubagentRunInfo['status']): { text: string; dot: 'ongoing' | 'done' | 'error' | 'warning' } {
  switch (s) {
    case 'running': return { text: '运行中', dot: 'ongoing' };
    case 'error': return { text: '出错', dot: 'error' };
    case 'stopped': return { text: '已停止', dot: 'warning' };
    default: return { text: '已完成', dot: 'done' };
  }
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 把子代理内部消息流组装成"正常对话"的消息数组:
 * - 父对话下发的提示词 → 一条 user 消息;
 * - 其后的所有 assistant/tool 属于同一次回复,按「思考 / 正文 / 连续工具组」的实际发生顺序
 *   合并进一条 assistant 消息(与主对话 turnsToMessages 同一口径:多步迭代合并为一条回复)。
 */
function toConversation(messages: SubagentMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const pushSeg = (msg: ChatMessage, seg: MsgSegment) => {
    if (!msg.segments) msg.segments = [];
    const last = msg.segments[msg.segments.length - 1];
    if (last && last.kind === seg.kind) {
      if (seg.kind === 'tools') last.tools!.push(...(seg.tools || []));
      else last.text = (last.text || '') + (seg.text || '');
    } else {
      msg.segments.push(seg);
    }
  };
  let cur: ChatMessage | null = null;
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text || '' });
      cur = null;
      continue;
    }
    if (!cur) { cur = { role: 'assistant', segments: [] }; out.push(cur); }
    if (m.role === 'assistant') {
      if (m.reasoning && String(m.reasoning).trim()) pushSeg(cur, { kind: 'reasoning', text: String(m.reasoning) });
      if (m.text && String(m.text).trim()) pushSeg(cur, { kind: 'text', text: String(m.text) });
      continue;
    }
    // tool:结果并入当前回复的工具组(与主对话一样,结果不单独成气泡)
    const call: ToolCallInfo = {
      id: m.callId, tool: m.name || '', args: m.args || '',
      ok: m.isError !== true, ms: m.ms ?? null, result: m.content ?? ''
    };
    pushSeg(cur, { kind: 'tools', tools: [call] });
  }
  return out;
}

/** 一次派发的完整对话(只读):与正常 AI 对话同款气泡与工具行 */
function Conversation({ messages }: { messages: SubagentMessage[] }) {
  const conv = useMemo(() => toConversation(messages), [messages]);
  return (
    <div className="sa-chat">
      {conv.map((m, i) => (m.role === 'user' ? (
        <div key={i} className="msg user">
          <div className="bubble user-bubble">{m.content}</div>
        </div>
      ) : (
        <div key={i} className="msg assistant">
          <div className="msg-col">
            <div className="bubble ai-bubble">
              {(m.segments || []).map((seg, si) => {
                if (seg.kind === 'tools') return <ToolCallList key={si} tools={seg.tools || []} />;
                if (seg.kind === 'reasoning') return <ReasoningSegment key={si} text={seg.text || ''} />;
                return <AssistantSegment key={si} text={seg.text || ''} />;
              })}
            </div>
          </div>
        </div>
      )))}
    </div>
  );
}

export default function SubagentPanel({ active, sid, open, runId, onOpen, onClose, embedded = false, onCounts }: {
  /** 当前是否在对话标签页(切走时自动收起) */
  active: boolean;
  /** 当前会话 id(只列这个会话派发的子代理) */
  sid: string | null;
  open: boolean;
  /** 打开时希望定位到的运行记录 id(卡片上的「查看会话」带过来) */
  runId: string | null;
  onOpen: (runId?: string) => void;
  onClose: () => void;
  /** 由外层 ActivityDock 托管:不渲染自己的悬浮胶囊/抽屉/头部,只渲染内容 */
  embedded?: boolean;
  /** 向上汇报派发数量与运行中数量(宿主据此决定整块面板是否显示、标签角标) */
  onCounts?: (c: { count: number; running: number }) => void;
}) {
  const isPhone = useIsPhone();
  const [runs, setRuns] = useState<SubagentRunInfo[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(runId);
  const [run, setRun] = useState<SubagentRun | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [showDetailOnPhone, setShowDetailOnPhone] = useState(false);
  const mountedRef = useRef(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const runningCount = useMemo(() => runs.filter((r) => r.status === 'running').length, [runs]);
  // 草稿会话(还没有 sid)名下不可能有派发记录:一条都不报,宿主也就不会显示子代理分区
  useEffect(() => {
    onCounts?.({ count: sid ? runs.length : 0, running: sid ? runningCount : 0 });
  }, [sid, runs.length, runningCount, onCounts]);
  const selectedInfo = useMemo(() => runs.find((r) => r.runId === selected) || null, [runs, selected]);

  const fetchList = useCallback(async () => {
    // 草稿会话没有 sid:不请求,列表直接清空(绝不把别的会话的记录当成自己的)
    if (!sid) { setRuns([]); setListErr(null); return; }
    try {
      const r = await api.request('subagent_list', { sid }, 10000, 'subagent_list');
      if (!mountedRef.current) return;
      setRuns(Array.isArray(r?.runs) ? r.runs : []);
      setListErr(null);
    } catch (e: any) {
      if (!mountedRef.current) return;
      // 服务端未起/断线:如实显示,不假装"没有记录"
      setListErr(e?.message || '派发记录拉取失败');
    }
  }, [sid]);

  const fetchRun = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const r = await api.request('subagent_get', { runId: id }, 10000, 'subagent_run');
      if (!mountedRef.current) return;
      setRun(r?.run ?? null);
      setDetailErr(null);
    } catch (e: any) {
      if (!mountedRef.current) return;
      setRun(null);
      setDetailErr(e?.message || '这次派发的记录拉取失败');
    } finally {
      if (mountedRef.current) setDetailLoading(false);
    }
  }, []);

  // 会话切换 / 挂载 / 断线重连:重拉列表
  useEffect(() => {
    mountedRef.current = true;
    void fetchList();
    const offOpen = api.on('open', () => { void fetchList(); });
    return () => { mountedRef.current = false; offOpen(); };
  }, [fetchList]);

  // 实时变更:事件只带 runId/status,正文由这里按需重拉
  useEffect(() => {
    const off = api.on('agent', (m: any) => {
      if (m?.event !== 'subagent_changed') return;
      if (sid && m.sid && m.sid !== sid) return;
      void fetchList();
      const id = String(m.runId || '');
      if (id && id === selected) void fetchRun(id);
    });
    return () => { off(); };
  }, [fetchList, fetchRun, selected, sid]);

  // 运行中兜底轮询(事件丢一帧也不至于停在旧状态)
  useEffect(() => {
    if (!open || runningCount === 0) return;
    const t = setInterval(() => {
      void fetchList();
      if (selected) void fetchRun(selected);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [open, runningCount, fetchList, fetchRun, selected]);

  // 外部带 runId 打开(卡片上的「查看会话」)
  useEffect(() => {
    if (!open || !runId) return;
    setSelected(runId);
    setShowDetailOnPhone(true);
    void fetchRun(runId);
  }, [open, runId, fetchRun]);

  // 打开但没指定:默认选最新一条(优先运行中的)
  useEffect(() => {
    if (!open || runId || selected || runs.length === 0) return;
    const next = runs.find((r) => r.status === 'running') || runs[0];
    setSelected(next.runId);
    void fetchRun(next.runId);
  }, [open, runId, selected, runs, fetchRun]);

  // 切走标签页 / 关闭时,手机端回到列表
  useEffect(() => { if (!open) setShowDetailOnPhone(false); }, [open]);
  useEffect(() => { if (!active) onClose(); }, [active, onClose]);

  // Esc 收起
  useEffect(() => {
    if (embedded || !open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [embedded, open, onClose]);

  // 运行中:新消息到达后贴底(用户主动上翻时不打扰)
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !open) return;
    if (selectedInfo?.status !== 'running') return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (near) el.scrollTop = el.scrollHeight;
  }, [run?.messages.length, open, selectedInfo?.status]);

  const pick = (id: string) => {
    setSelected(id);
    setShowDetailOnPhone(true);
    void fetchRun(id);
  };

  // 没有任何派发记录:不占用右上角(胶囊只在有内容时出现)
  // ---- 渲染:派发记录列表 / 该次派发的对话(embedded 与独立使用共用同一份 JSX)----
  const renderList = () => (
    <nav className="sa-list" aria-label="子代理派发记录">
      {listErr && (
        <div className="sa-list-err">
          <span>{listErr}</span>
          <button type="button" className="sa-retry" onClick={() => void fetchList()}>
            <IconReload16 size={12} />重试
          </button>
        </div>
      )}
      {runs.map((r) => {
        const st = statusOf(r.status);
        return (
          <button
            type="button"
            key={r.runId}
            className={`sa-item${r.runId === selected ? ' on' : ''}`}
            aria-current={r.runId === selected}
            onClick={() => pick(r.runId)}
          >
            <span className="sa-item-top">
              <StateDot state={st.dot} />
              <span className="sa-item-desc">{r.description || '(未命名派发)'}</span>
            </span>
            <span className="sa-item-meta">
              <span className={`sa-item-status st-${r.status}`}>{st.text}</span>
              <span className="sa-item-time">{fmtClock(r.startedAt)}</span>
            </span>
          </button>
        );
      })}
      {!runs.length && !listErr && <div className="sa-list-empty">本次会话还没有派发过子代理</div>}
    </nav>
  );

  const renderDetail = () => (
    <section className="sa-detail">
      {isPhone && showDetailOnPhone && (
        <button type="button" className="sa-back" onClick={() => setShowDetailOnPhone(false)}>
          <IconArrowLeft16 size={14} />返回列表
        </button>
      )}
      <div className={`sa-detail-body${run ? ' chat' : ''}`} ref={bodyRef}>
        {detailLoading && !run && (
          <div className="sa-skel" aria-busy="true" aria-label="加载中">
            <span className="sa-skel-line" />
            <span className="sa-skel-line w70" />
            <span className="sa-skel-line w85" />
            <span className="sa-skel-line w60" />
          </div>
        )}
        {detailErr && (
          <div className="sa-detail-err">
            <span>{detailErr}</span>
            {selected && (
              <button type="button" className="sa-retry" onClick={() => void fetchRun(selected)}>
                <IconReload16 size={12} />重试
              </button>
            )}
          </div>
        )}
        {!detailLoading && !detailErr && !run && (
          <div className="sa-detail-empty">
            {selected
              ? '这次派发的记录已不在(可能超出了保留上限,或被清理过)'
              : '从左侧选一次派发,查看子代理的完整过程'}
          </div>
        )}
        {run && (
          <>
            <Conversation messages={run.messages} />
            {run.status === 'running' && <div className="sa-running">子代理还在跑,新内容会自动出现</div>}
          </>
        )}
      </div>
      {run && (
        <footer className="sa-foot">
          <span className={`sa-item-status st-${run.status}`}>{statusOf(run.status).text}</span>
          <span className="sa-foot-gap" />
          <span className="sa-foot-provider">{run.provider}</span>
        </footer>
      )}
      {run?.note && <div className="sa-note">{run.note}</div>}
    </section>
  );

  // 由 ActivityDock 托管:只出内容(没有派发记录时什么都不渲染,宿主自然不显示这一栏)
  if (embedded) {
    if (!sid || runs.length === 0) return null;
    return (
      <div className={`sa-cols${showDetailOnPhone ? ' detail' : ''}`}>
        {renderList()}
        {renderDetail()}
      </div>
    );
  }

  // 独立使用:没有派发记录(或草稿会话)就不显示悬浮胶囊(整块不存在)
  if (!sid || runs.length === 0) return null;

  return (
    <>
      <button
        type="button"
        className={`sa-fab${runningCount > 0 ? ' live' : ''}${open ? ' on' : ''}`}
        data-tip="查看子代理的调研过程"
        aria-label="打开子代理面板"
        aria-expanded={open}
        onClick={() => (open ? onClose() : onOpen())}
      >
        <span className="sa-fab-ico"><IconSparkle16 size={14} /></span>
        <span className="sa-fab-text">子代理</span>
        <span className="sa-fab-count">{runningCount > 0 ? `${runningCount}/${runs.length}` : runs.length}</span>
      </button>

      {open && !isPhone && <div className="sa-backdrop" onClick={onClose} />}

      <aside
        className={`sa-drawer${open ? ' open' : ''}${isPhone ? ' phone' : ''}`}
        aria-label="子代理"
        aria-hidden={!open}
      >
        <header className="sa-head">
          <span className="sa-title"><IconSparkle16 size={14} />子代理</span>
          <span className="sa-sub">
            {runs.length} 次派发{runningCount > 0 ? ` · ${runningCount} 个运行中` : ''}
          </span>
          <span className="sa-head-gap" />
          <button type="button" className="chip-btn" onClick={onClose} aria-label="收起子代理面板">收起</button>
        </header>
        <div className={`sa-cols${showDetailOnPhone ? ' detail' : ''}`}>
          {renderList()}
          {renderDetail()}
        </div>
      </aside>
    </>
  );
}
