// 手机底部导航栏(仅 <768 渲染):AI助手 / 终端 / 自动化 / 文件 / 预览
// 图标与标签条、侧栏同源(components/icons/icons.tsx 的内联 SVG),不用 emoji:
// emoji 的字形随系统字体漂移、粗细不一,和面板内其它图标对不上。
// 会话不占底部栏:由顶栏 ≡ 唤出的会话抽屉承载(ChatGPT 式,任何页面可切会话并跳回对话)
import React from 'react';
import { IconAiChat16, IconBrowser16, IconFolder16, IconSchedule16, IconTerminal16 } from '../icons/icons';
import './BottomBar.scss';

export type MobileView = 'agent' | 'console' | 'files' | 'browser' | 'schedule';

interface BottomBarProps {
  view: MobileView;
  /** 打开的文件标签数(文件图标上的徽标) */
  fileTabCount: number;
  /** 已打开的浏览器预览标签数(预览图标上的徽标) */
  browserTabCount: number;
  onSelect: (v: MobileView) => void;
}

export default function BottomBar({ view, fileTabCount, browserTabCount, onSelect }: BottomBarProps) {
  const ITEMS: { v: MobileView; icon: React.ReactNode; label: string }[] = [
    { v: 'agent', icon: <IconAiChat16 size={20} />, label: 'AI助手' },
    { v: 'console', icon: <IconTerminal16 size={20} />, label: '终端' },
    { v: 'schedule', icon: <IconSchedule16 size={20} />, label: '自动化' },
    { v: 'files', icon: <IconFolder16 size={20} />, label: '文件' },
    { v: 'browser', icon: <IconBrowser16 size={20} />, label: '预览' },
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
            {it.v === 'browser' && browserTabCount > 0 && <span className="bb-badge">{browserTabCount}</span>}
          </span>
          <span className="bb-label">{it.label}</span>
        </button>
      ))}
    </nav>
  );
}
