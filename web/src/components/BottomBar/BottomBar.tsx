// 手机底部导航栏(仅 <768 渲染):💬 AI助手 / ⌨️ 命令台 / 📁 文件 / 🗂 会话
// 高亮规则:view 由 App 传入;文件视图在「有文件打开」时同样点亮 📁(徽标显示标签数)。
import React from 'react';
import './BottomBar.scss';

export type MobileView = 'agent' | 'console' | 'files' | 'sessions';

interface BottomBarProps {
  view: MobileView;
  /** 打开的文件标签数(📁 徽标) */
  fileTabCount: number;
  onSelect: (v: MobileView) => void;
}

export default function BottomBar({ view, fileTabCount, onSelect }: BottomBarProps) {
  const ITEMS: { v: MobileView; icon: string; label: string }[] = [
    { v: 'agent', icon: '💬', label: 'AI助手' },
    { v: 'console', icon: '⌨️', label: '终端' },
    { v: 'files', icon: '📁', label: '文件' },
    { v: 'sessions', icon: '🗂', label: '会话' },
  ];
  return (
    <nav className="bottom-bar" aria-label="主导航">
      {ITEMS.map((it) => (
        <button key={it.v} type="button"
          className={`bb-item${view === it.v ? ' on' : ''}`}
          onClick={() => onSelect(it.v)}>
          <span className="bb-ico">
            {it.icon}
            {it.v === 'files' && fileTabCount > 0 && <span className="bb-badge">{fileTabCount}</span>}
          </span>
          <span className="bb-label">{it.label}</span>
        </button>
      ))}
    </nav>
  );
}
