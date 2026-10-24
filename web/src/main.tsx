import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { FeedbackProvider } from './context/feedback';
import { LlmProvider } from './context/llm-context';
import { initOverlayScrollbar } from './utils/scrollbar-ui';
import { applyChatFont, installChatFontShortcuts, readChatFont } from './utils/chatFont';
import { applyProcFoldTiming, readProcFoldTiming } from './utils/procFold';
import { applyActiveTheme } from './theme/themes';
import './styles.scss';

// 桌面壳(WebView2)里鼠标侧键默认走浏览器前进/后退:启动时历史里还留着 loading 页,
// 一按后退就回到「正在启动后端服务…」且卡住。这是桌面应用,不保留浏览器式 history 导航;
// 在捕获阶段吞掉侧键(button 3/4),并配合 Rust 侧用 location.replace 进入应用页清掉 loading 历史。
const swallowMouseSideButton = (e: MouseEvent | PointerEvent) => {
  if (e.button === 3 || e.button === 4) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
};
for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick'] as const) {
  window.addEventListener(type, swallowMouseSideButton as EventListener, true);
}

// 渲染前应用持久化的激活主题,避免首帧闪回默认色板
applyActiveTheme();
// 对话字号同理:先写 CSS 变量再首帧,避免文字"跳一下"。快捷键是全局的,装一次即可。
applyChatFont(readChatFont(), false);
installChatFontShortcuts();
// 过程收起时机(completion / next-input):把持久化值装进内存态,首帧就按用户偏好渲染
applyProcFoldTiming(readProcFoldTiming(), false);

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
