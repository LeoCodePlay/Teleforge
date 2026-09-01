import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { FeedbackProvider } from './feedback';
import './styles.scss';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('找不到 #root 挂载节点');
createRoot(rootEl).render(
  <FeedbackProvider>
    <App />
  </FeedbackProvider>
);
