// 上下文用量指示器(发送按钮左侧,参照 dsh 的 ContextMeter):
// - 常态:圆形进度环(ring)显示当前上下文占用百分比,颜色随水位变化
//   (80% 压缩水位前蓝、80-94% 琥珀、>=95% 红)
// - 鼠标悬浮:只弹出「数值 + 占在哪」——总量(≈已用/窗口/百分比)、一条进度条、
//   以及 system/工具/对话三处的 token 占用。**不放任何说明性文字**(口径解释、
//   压缩提示、水位规则等一律不显示,用户要的是数字不是说明书)。
// - 口径:优先用服务端 context_usage 事件(estimated = 服务端按统一口径
//   measureEnvelope 算的 system + 工具 schema + 折叠后历史;actual = provider 上报的
//   prompt_tokens,有则显示 actual);服务端未上报时才回退到前端估算——同样只算
//   "模型可见面"(压缩后从最后一个压缩标记行起,见 utils/tokens 的 modelFaceMessages)。
// contextWindow <= 0(模型未配置)时不渲染。
import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { estimateMessages, estimateBreakdown, estimateTokens, SYSTEM_EST, formatTokens } from '../../utils/tokens';
import type { ChatMessage } from '../../types';
import './ContextMeter.scss';

/** 服务端 context_usage 事件载荷 */
export interface ContextUsage {
  /** 本次实际发送请求(折叠后,含 system 与工具 schema)的启发式估算 token */
  estimated: number;
  /** provider 上报的真实输入 token;未上报为 null */
  actual: number | null;
  /** provider 上报的真实输出 token;未上报为 null */
  output: number | null;
  /** 服务端生效的上下文窗口(与请求时一致) */
  window: number;
  /** system 提示词分项(与服务端压缩阈值同口径);旧版服务端可能不提供 */
  systemTokens?: number;
  /** 工具 schema 分项;旧版服务端可能不提供 */
  toolsTokens?: number;
  /** 历史消息分项;旧版服务端可能不提供 */
  messageTokens?: number;
}

interface Props {
  messages: ChatMessage[];
  input: string;
  contextWindow?: number;
  usage?: ContextUsage | null;
}

const R = 12;        // 圆环半径
const CIRC = 2 * Math.PI * R;

export default function ContextMeter({ messages, input, contextWindow, usage }: Props) {
  const [show, setShow] = useState(false);
  const meterRef = useRef<HTMLDivElement>(null);
  // 弹窗坐标(fixed):本组件位于 composer-box(backdrop-filter)内部,就地渲染时
  // Chromium 不会对其后代应用 backdrop-filter,玻璃模糊失效;故 portal 到 body。
  // 坐标按进度环位置计算:向上弹出、右对齐,与旧 absolute 版视觉一致
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const openPop = () => {
    const r = meterRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.top - 10, right: window.innerWidth - r.right });
    setShow(true);
  };
  const serverWin = Number(usage?.window) || 0;
  const win = serverWin > 0 ? serverWin : (Number(contextWindow) || 0);
  if (win <= 0) return null;

  // 服务端口径:actual 优先(真实请求),否则用服务端折叠后预估。
  // 前端估算对整段历史做 JSON.stringify,仅在服务端未上报时走(此时安全,Hooks
  // 不可条件调用,用按 messages 引用的惰性缓存代替:打字等仅输入变化的重渲染命中缓存)。
  // 服务端正常上报时完全不触发整段历史的序列化,流式增量帧不背这个开销。
  const serverUsed = usage ? (usage.actual ?? usage.estimated) : null;
  const hasServer = serverUsed != null && serverUsed > 0;
  const estCache = useRef<{ key: ChatMessage[] | null; val: number }>({ key: null, val: 0 });
  const estimateMsgs = () => {
    const c = estCache.current;
    if (c.key === messages) return c.val;
    const v = estimateMessages(messages);
    estCache.current = { key: messages, val: v };
    return v;
  };
  const used = hasServer ? serverUsed : SYSTEM_EST + estimateMsgs() + estimateTokens(input as string) + 20;
  const pct = Math.min(100, Math.round((used / win) * 100));
  const level = pct >= 95 ? ' danger' : pct >= 80 ? ' warn' : '';
  // 分项明细:优先用服务端给出的分项(与压缩阈值同源,不会与百分比自相矛盾);
  // 旧版服务端不发分项时,才在悬浮面板打开时按前端渲染历史估算(遍历全部消息,常闭时省掉开销)。
  const serverBreakdown = usage && typeof usage.systemTokens === 'number'
    ? { system: usage.systemTokens, tools: usage.toolsTokens || 0, conversation: usage.messageTokens || 0 }
    : null;
  const breakdown = serverBreakdown ?? (show && pos ? estimateBreakdown(messages, input) : null);
  const segTotal = breakdown ? (breakdown.system + breakdown.tools + breakdown.conversation || 1) : 1;
  const segPct = (n: number) => Math.round((n / segTotal) * 100);

  const ringPct = Math.min(1, used / win);
  const offset = CIRC * (1 - ringPct);

  return (
    <div ref={meterRef} className={`ctx-meter${level}`}
      onMouseEnter={openPop} onMouseLeave={() => setShow(false)}>
      <span className="ctx-ring">
        <svg viewBox="0 0 30 30" width="30" height="30" aria-hidden="true">
          <circle className="ctx-ring-track" cx="15" cy="15" r={R} />
          <circle className="ctx-ring-fill" cx="15" cy="15" r={R}
            strokeDasharray={`${CIRC} ${CIRC}`} strokeDashoffset={offset} />
        </svg>
        <span className="ctx-ring-pct">{pct}%</span>
      </span>

      {show && pos && createPortal(
        // 只呈现数值与分项:总量/进度条/三处占用。不放任何说明性文字。
        <div className="ctx-pop" style={pos}>
          <div className="ctx-pop-nums">
            ≈ {formatTokens(used)} <span className="muted">/ {formatTokens(win)}</span>
            <span className="ctx-pop-pct">({pct}%)</span>
          </div>
          <div className="ctx-pop-track"><span className="ctx-pop-fill" style={{ width: pct + '%' }} /></div>
          {breakdown && (
            <div className="ctx-pop-segs">
              <SegRow name="系统提示词" tokens={breakdown.system} pct={segPct(breakdown.system)} cls="sys" />
              <SegRow name="工具调用" tokens={breakdown.tools} pct={segPct(breakdown.tools)} cls="tool" />
              <SegRow name="对话消息" tokens={breakdown.conversation} pct={segPct(breakdown.conversation)} cls="conv" />
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

function SegRow({ name, tokens, pct, cls }: { name: string; tokens: number; pct: number; cls: string }) {
  return (
    <div className="ctx-seg">
      <span className="ctx-seg-name">{name}</span>
      <span className="ctx-seg-track"><span className={`ctx-seg-fill ${cls}`} style={{ width: Math.min(100, pct) + '%' }} /></span>
      <span className="ctx-seg-nums">{formatTokens(tokens)}</span>
    </div>
  );
}
