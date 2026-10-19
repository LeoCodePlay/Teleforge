import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { FeedbackProvider } from './context/feedback';
import { LlmProvider } from './context/llm-context';
import { initOverlayScrollbar } from './utils/scrollbar-ui';
import { applyChatFont, installChatFontShortcuts, readChatFont } from './utils/chatFont';
import { applyActiveTheme } from './theme/themes';
import './styles.scss';

// 渲染前应用持久化的激活主题,避免首帧闪回默认色板
applyActiveTheme();
// 对话字号同理:先写 CSS 变量再首帧,避免文字"跳一下"。快捷键是全局的,装一次即可。
applyChatFont(readChatFont(), false);
installChatFontShortcuts();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('找不到 #root 挂载节点');
createRoot(rootEl).render(
  <FeedbackProvider>
    <LlmProvider>
      <App />
    </LlmProvider>
  </FeedbackProvider>
);

// 首帧渲染完成后点亮一次已有滚动容器,此后新出现的滚动容器在滚动时按需接管
window.setTimeout(initOverlayScrollbar, 80);
