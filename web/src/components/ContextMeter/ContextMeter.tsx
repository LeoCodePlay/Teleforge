// 上下文用量指示器(发送按钮左侧,参照 dsh 的 ContextMeter):
// - 常态:圆形进度环(ring)显示当前上下文占用百分比,颜色随水位变化
//   (80% 压缩水位前蓝、80-94% 琥珀、>=95% 红)
// - 鼠标悬浮:弹出横向进度条 + 数字(≈已用/窗口/百分比)+ 分项明细
// - 口径:优先用服务端 context_usage 事件(实际请求 = provider 上报 prompt_tokens,
//   预估 = 服务端按"折叠后模型可见面"计算的启发式值);服务端未上报时
//   才回退到前端对渲染历史的估算(该口径会把 UI 展示用的长结果/思考全算进去,
//   比真实请求明显偏大,仅作参考)。
// contextWindow <= 0(模型未配置)时不渲染。
import React, { useState } from 'react';
import { estimateMessages, estimateBreakdown, estimateTokens, SYSTEM_EST, formatTokens } from '../../utils/tokens';
import type { ChatMessage } from '../../types';
import './ContextMeter.scss';

/** 服务端 context_usage 事件载荷 */
export interface ContextUsage {
  /** 本次实际发送请求(折叠后,含 system)的启发式估算 token */
  estimated: number;
  /** provider 上报的真实输入 token;未上报为 null */
  actual: number | null;
  /** provider 上报的真实输出 token;未上报为 null */
  output: number | null;
  /** 服务端生效的上下文窗口(与请求时一致) */
  window: number;
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
  const serverWin = Number(usage?.window) || 0;
  const win = serverWin > 0 ? serverWin : (Number(contextWindow) || 0);
  if (win <= 0) return null;

  // 服务端口径:actual 优先(真实请求),否则用服务端折叠后预估;两者都没有才回退前端估算
  const serverUsed = usage ? (usage.actual ?? usage.estimated) : null;
  const clientUsed = SYSTEM_EST + estimateMessages(messages) + estimateTokens(input as string) + 20;
  const used = serverUsed != null && serverUsed > 0 ? serverUsed : clientUsed;
  const pct = Math.min(100, Math.round((used / win) * 100));
  const level = pct >= 95 ? ' danger' : pct >= 80 ? ' warn' : '';
  const seg = estimateBreakdown(messages, input);
  const segTotal = seg.system + seg.tools + seg.conversation || 1;
  const segPct = (n: number) => Math.round((n / segTotal) * 100);

  const ringPct = Math.min(1, used / win);
  const offset = CIRC * (1 - ringPct);

  return (
    <div className={`ctx-meter${level}`}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <span className="ctx-ring">
        <svg viewBox="0 0 30 30" width="30" height="30" aria-hidden="true">
          <circle className="ctx-ring-track" cx="15" cy="15" r={R} />
          <circle className="ctx-ring-fill" cx="15" cy="15" r={R}
            strokeDasharray={`${CIRC} ${CIRC}`} strokeDashoffset={offset} />
        </svg>
        <span className="ctx-ring-pct">{pct}%</span>
      </span>

      {show && (
        <div className="ctx-pop">
          <div className="ctx-pop-nums">
            ≈ {formatTokens(used)} <span className="muted">/ {formatTokens(win)}</span>
            <span className="ctx-pop-pct">({pct}%)</span>
          </div>
          {usage && usage.window > 0 && (
            <div className="ctx-pop-nums ctx-pop-actual">
              最近一次请求:{usage.actual != null
                ? <>实际输入 <b>{formatTokens(usage.actual)}</b>{usage.output != null ? ` / 输出 ${formatTokens(usage.output)}` : ''}</>
                : '提供方未上报实际用量'}
              {usage.actual != null && <span className="muted">(服务端预估 {formatTokens(usage.estimated)})</span>}
            </div>
          )}
          <div className="ctx-pop-track"><span className="ctx-pop-fill" style={{ width: pct + '%' }} /></div>
          <div className="ctx-pop-segs">
            {usage && usage.window > 0
              ? <div className="ctx-pop-hint">以上为服务端实际请求口径(旧工具结果已折叠,不再按前端渲染历史估算)</div>
              : <>
                <SegRow name="系统提示词" tokens={seg.system} pct={segPct(seg.system)} cls="sys" />
                <SegRow name="工具调用" tokens={seg.tools} pct={segPct(seg.tools)} cls="tool" />
                <SegRow name="对话消息" tokens={seg.conversation} pct={segPct(seg.conversation)} cls="conv" />
              </>}
          </div>
          <div className="ctx-pop-hint">达到 80% 水位时自动压缩早期对话</div>
        </div>
      )}
    </div>
  );
}

function SegRow({ name, tokens, pct, cls }: { name: string; tokens: number; pct: number; cls: string }) {
  return (
    <div className="ctx-seg">
      <span className="ctx-seg-name">{name}</span>
      <span className="ctx-seg-track"><span className={`ctx-seg-fill ${cls}`} style={{ width: Math.min(100, pct) + '%' }} /></span>
      <span className="ctx-seg-nums">{formatTokens(tokens)} · {pct}%</span>
    </div>
  );
}
