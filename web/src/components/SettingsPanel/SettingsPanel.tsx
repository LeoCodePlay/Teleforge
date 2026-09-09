// 设置面板:左侧菜单 + 右侧内容区
// 包含「AI 配置」「生图配置」「主题」「技能」「工具插件」「全局指令」「关于与更新」;后续设置项在 MENUS 中追加即可
import React, { useState } from 'react';
import AiConfigPanel from '../AiConfigPanel/AiConfigPanel';
import ImageGenPanel from '../ImageGenPanel/ImageGenPanel';
import SkillsPanel from '../SkillsPanel/SkillsPanel';
import PluginsPanel from '../PluginsPanel/PluginsPanel';
import PromptInjectPanel from '../PromptInjectPanel/PromptInjectPanel';
import ThemePanel from '../ThemePanel/ThemePanel';
import AboutPanel from '../AboutPanel/AboutPanel';
import './SettingsPanel.scss';

const MENUS = [
  { id: 'ai', icon: '🤖', label: 'AI 配置' },
  { id: 'image', icon: '🖼️', label: '生图配置' },
  { id: 'theme', icon: '🎨', label: '主题' },
  { id: 'skills', icon: '🧩', label: '技能' },
  { id: 'plugins', icon: '🔌', label: '工具插件' },
  { id: 'inject', icon: '📌', label: '全局指令' },
  { id: 'about', icon: 'ℹ️', label: '关于与更新' }
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
            {active === 'inject' && <PromptInjectPanel />}
            {active === 'about' && <AboutPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}