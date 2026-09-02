import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { FeedbackProvider } from './context/feedback';
import { initOverlayScrollbar } from './utils/scrollbar-ui';
import { applyActiveTheme } from './theme/themes';
import './styles.scss';

// 渲染前应用持久化的激活主题,避免首帧闪回默认色板
applyActiveTheme();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('找不到 #root 挂载节点');
createRoot(rootEl).render(
  <FeedbackProvider>
    <App />
  </FeedbackProvider>
);

// 首帧渲染完成后点亮一次已有滚动容器,此后新出现的滚动容器在滚动时按需接管
window.setTimeout(initOverlayScrollbar, 80);
