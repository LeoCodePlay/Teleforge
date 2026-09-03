// 上下文用量指示器(发送按钮左侧, 的 ContextMeter):
// - 常态:圆形进度环(ring)显示当前上下文占用百分比,颜色随水位变化
//   (80% 压缩水位前蓝、80-94% 琥珀、>=95% 红)
// - 鼠标悬浮:弹出横向进度条 + 数字(≈已用/窗口/百分比)+ 分项明细
//   (系统提示词 / 工具调用 / 对话消息 各自的 token 与占比)
// contextWindow <= 0(模型未配置)时不渲染。
import React, { useState } from 'react';
import { estimateMessages, estimateBreakdown, estimateTokens, SYSTEM_EST, formatTokens } from '../utils/tokens';
import type { ChatMessage } from '../types';

interface Props {
  messages: ChatMessage[];
  input: string;
  contextWindow?: number;
}

const R = 12;        // 圆环半径
const CIRC = 2 * Math.PI * R;

export default function ContextMeter({ messages, input, contextWindow }: Props) {
  const [show, setShow] = useState(false);
  const win = Number(contextWindow) || 0;
  if (win <= 0) return null;

  const used = SYSTEM_EST + estimateMessages(messages) + estimateTokens(input as string) + 20;
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
          <div className="ctx-pop-track"><span className="ctx-pop-fill" style={{ width: pct + '%' }} /></div>
          <div className="ctx-pop-segs">
            <SegRow name="系统提示词" tokens={seg.system} pct={segPct(seg.system)} cls="sys" />
            <SegRow name="工具调用" tokens={seg.tools} pct={segPct(seg.tools)} cls="tool" />
            <SegRow name="对话消息" tokens={seg.conversation} pct={segPct(seg.conversation)} cls="conv" />
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