// 通用设置页(对齐 dsh 0.2.1-rc 的「设置 → 通用设置」区)。
//
// dsh 把外观、字体与「工作步骤收起时机」都注册在 `settings.general.item` 插槽里;
// 本项目对应成这一页,只放**跨会话生效的显示偏好**:
//   - 界面字号:正文 / 代码 / 终端一起缩放(8096e18504 + 0c6968b649);
//   - 过程收起时机:回答结束后 / 下次有新消息时(a0a9aef5ec + 61112eab8f)。
// 主题(配色)仍留在「主题」页,两页各自只放自己那类设置 —— 之前把收起时机塞进主题页,
// 标题右侧又重复印了一遍当前值,看起来像两条一样的设置(用户反馈"这些又是什么鬼")。
import React, { useEffect, useState } from 'react';
import {
  CHAT_FONT_SIZES, applyChatFont, currentChatFont, onChatFontChange, stepChatFont
} from '../../utils/chatFont';
import {
  PROC_FOLD_TIMINGS, applyProcFoldTiming, currentProcFoldTiming, onProcFoldTimingChange,
  type ProcFoldTiming
} from '../../utils/procFold';
import './GeneralPanel.scss';

/** 收起时机的两个选项文案:与 dsh 的 locale 对齐(settings.collapse.completion / nextInput) */
const TIMING_LABELS: Record<ProcFoldTiming, string> = {
  completion: '回答结束后',
  'next-input': '下次有新消息时'
};

export default function GeneralPanel() {
  const [font, setFont] = useState<number>(() => currentChatFont());
  useEffect(() => onChatFontChange(setFont), []);
  // 过程收起时机:与对话区共用 procFold 里的一份状态
  const [foldTiming, setFoldTiming] = useState<ProcFoldTiming>(() => currentProcFoldTiming());
  useEffect(() => onProcFoldTimingChange(setFoldTiming), []);

  return (
    <div>
      {/* 界面字号(dsh 0.2.1-rc 的 8096e18504 字号快捷键 + 0c6968b649 正文/代码/终端一起缩放) */}
      <div className="panel-title row">
        <span>界面字号</span>
        <span className="grow" />
        <span className="muted sm">{font}px</span>
      </div>
      <div className="gp-row">
        <button className="sm" onClick={() => setFont(stepChatFont(-1))} disabled={font <= CHAT_FONT_SIZES[0]}
          data-tip="缩小界面字号(Ctrl/⌘ + −)">A−</button>
        {CHAT_FONT_SIZES.map((px) => (
          <button key={px} className={'sm' + (px === font ? ' on' : '')} onClick={() => setFont(applyChatFont(px))}>{px}</button>
        ))}
        <button className="sm" onClick={() => setFont(stepChatFont(1))} disabled={font >= CHAT_FONT_SIZES[CHAT_FONT_SIZES.length - 1]}
          data-tip="放大界面字号(Ctrl/⌘ + =)">A＋</button>
      </div>
      <div className="hint">
        快捷键 <b>Ctrl/⌘ + =</b> 放大、<b>Ctrl/⌘ + −</b> 缩小
      </div>

      {/* 过程收起时机:一行标题 + 两个选项,当前档只由高亮表达(不再在标题右侧重复一遍) */}
      <div className="panel-title row gp-gap">
        <span>过程收起时机</span>
        <span className="grow" />
      </div>
      <div className="gp-row">
        {PROC_FOLD_TIMINGS.map((t) => (
          <button key={t} className={'sm' + (t === foldTiming ? ' on' : '')}
            onClick={() => setFoldTiming(applyProcFoldTiming(t))}>
            {TIMING_LABELS[t]}
          </button>
        ))}
      </div>
      <div className="hint">
        选择何时自动收起过程;手动点开过的轮次不受影响。
      </div>
    </div>
  );
}
