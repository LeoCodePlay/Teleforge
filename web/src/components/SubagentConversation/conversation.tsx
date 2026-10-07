// 子智能体对话的共享渲染层。
//
// 为什么单独一个模块:同一段「把子智能体内部消息流渲染成正常对话」的逻辑有**两个消费者** ——
//   1. 主对话区(点会话头部 catalog 的一行 = DSH 的 openChild,主区换成这个子会话);
//   2. 右侧栏的「子智能体会话」标签页(对照阅读:主对话在中间,某一个子智能体的过程在右边)。
// 抽出来是为了**消除重复**而不是制造重复:两个入口必须显示同一份口径(同样的气泡、同样的
// 工具行、同样的"多步迭代合并为一条回复"规则),否则同一个子智能体在两处看起来会不一样。
//
// 这套口径与 dsh 对子会话的处理一致:子会话就是一段普通对话(父对话下发的提示词
// 就是它的第一条 user 消息),渲染原子与主对话同一套 —— 不额外发明一种"子智能体专属视图"。
import React, { useMemo } from 'react';
import { AssistantSegment, ReasoningSegment } from '../ChatPanel/assistantText';
import { ToolCallList } from '../ToolCallList/ToolCallList';
// 与主对话**同一套**过程分组:思考+工具调用走 ProcessGroup(该折叠折叠、该分组分组)
import { ProcessGroup } from '../ProcessGroup/ProcessGroup';
import { planGroups, isGroupLive, groupedFor, TRANSCRIPT_MODE } from '../../utils/processGroups';
import type { ChatMessage, MsgSegment, ToolCallInfo, SubagentRunInfo, SubagentMessage } from '../../types';

/** 状态文案与状态点语义(点 = 真实状态,不是装饰) */
export function statusOf(s: SubagentRunInfo['status']): { text: string; dot: 'ongoing' | 'done' | 'error' | 'warning' } {
  switch (s) {
    case 'running': return { text: '运行中', dot: 'ongoing' };
    case 'error': return { text: '出错', dot: 'error' };
    case 'stopped': return { text: '已停止', dot: 'warning' };
    default: return { text: '已完成', dot: 'done' };
  }
}

export function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 把子智能体内部消息流组装成"正常对话"的消息数组:
 * - 父对话下发的提示词 → 一条 user 消息;
 * - 其后的所有 assistant/tool 属于同一次回复,按「思考 / 正文 / 连续工具组」的实际发生顺序
 *   合并进一条 assistant 消息(与主对话 turnsToMessages 同一口径:多步迭代合并为一条回复)。
 */
export function toConversation(messages: SubagentMessage[]): ChatMessage[] {
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
export function Conversation({ messages }: { messages: SubagentMessage[] }) {
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
              {(planGroups(m.segments || [])).map((u, ui) => {
                // 正文段:独立渲染(分组规则同主对话:有正文就关组)
                if (u.kind === 'text') {
                  const seg = (m.segments || [])[u.index];
                  return <AssistantSegment key={ui} text={seg?.text || ''} />;
                }
                // 连续的「思考 + 工具」串 = 一个过程组:与主对话同款折叠/汇总
                return (
                  <ProcessGroup key={ui} summary={u.summary} live={isGroupLive(u.items)}
                    collapsed={groupedFor(TRANSCRIPT_MODE, false)}>
                    {u.memberIndexes.map((si) => {
                      const seg = (m.segments || [])[si];
                      if (!seg) return null;
                      if (seg.kind === 'tools') return <ToolCallList key={si} tools={seg.tools || []} />;
                      return <ReasoningSegment key={si} text={seg.text || ''} />;
                    })}
                  </ProcessGroup>
                );
              })}
            </div>
          </div>
        </div>
      )))}
    </div>
  );
}
