// 设置面板:左侧菜单 + 右侧内容区
// 包含「AI 配置」「生图配置」「主题」「技能」「工具插件」「MCP 服务」「全局指令」「关于与更新」;
// 后续设置项在 MENUS 中追加即可。菜单图标是 components/icons/icons.tsx 的内联 SVG
//(与全站同一套 16 号网格),不用 emoji —— 竖排菜单里 emoji 的彩色与字宽差异最扎眼
import React, { useState } from 'react';
import AiConfigPanel from '../AiConfigPanel/AiConfigPanel';
import ImageGenPanel from '../ImageGenPanel/ImageGenPanel';
import SkillsPanel from '../SkillsPanel/SkillsPanel';
import PluginsPanel from '../PluginsPanel/PluginsPanel';
import McpPanel from '../McpPanel/McpPanel';
import PromptInjectPanel from '../PromptInjectPanel/PromptInjectPanel';
import ThemePanel from '../ThemePanel/ThemePanel';
import AboutPanel from '../AboutPanel/AboutPanel';
import { IconClipboard16, IconHub16, IconImage16, IconInfo16, IconPlug16, IconPuzzle16, IconRobot16, IconTheme16 } from '../icons/icons';
import './SettingsPanel.scss';

const MENUS: { id: string; icon: React.ReactNode; label: string }[] = [
  { id: 'ai', icon: <IconRobot16 size={15} />, label: 'AI 配置' },
  { id: 'image', icon: <IconImage16 size={15} />, label: '生图配置' },
  { id: 'theme', icon: <IconTheme16 size={15} />, label: '主题' },
  { id: 'skills', icon: <IconPuzzle16 size={15} />, label: '技能' },
  { id: 'plugins', icon: <IconPlug16 size={15} />, label: '工具插件' },
  { id: 'mcp', icon: <IconHub16 size={15} />, label: 'MCP 服务' },
  { id: 'inject', icon: <IconClipboard16 size={15} />, label: '全局指令' },
  { id: 'about', icon: <IconInfo16 size={15} />, label: '关于与更新' }
];

interface SettingsPanelProps {
  onClose: () => void;
  /** SSH 是否已连接(技能管理/复制到远程需要操作远程文件) */
  connected?: boolean;
  /** 初始打开的菜单项(如顶栏更新角标点击时直达「关于与更新」) */
  initialTab?: string;
}

export default function SettingsPanel({ onClose, connected = false, initialTab = 'ai' }: SettingsPanelProps) {
  const [active, setActive] = useState(initialTab);

  return (
    <div className="modal-overlay settings-overlay" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <span>⚙ 设置</span>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <div className="settings-body">
          <div className="settings-menu">
            {MENUS.map((m) => (
              <button key={m.id} className={active === m.id ? 'on' : ''} onClick={() => setActive(m.id)}>
                <span>{m.icon}</span>{m.label}
              </button>
            ))}
          </div>
          <div className="settings-content">
            {active === 'ai' && <AiConfigPanel />}
            {active === 'image' && <ImageGenPanel />}
            {active === 'theme' && <ThemePanel />}
            {active === 'skills' && <SkillsPanel connected={connected} />}
            {active === 'plugins' && <PluginsPanel />}
            {active === 'mcp' && <McpPanel />}
            {active === 'inject' && <PromptInjectPanel />}
            {active === 'about' && <AboutPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}