// 桌面端自定义标题栏窗口控制按钮:最小化 / 最大化(还原)/ 关闭。
// 只要运行在 Tauri 窗口就渲染(dev/prod 均无边框,都需要按钮);浏览器模式不渲染。
// 拖拽区由 App.tsx 的 .topbar 上的 data-tauri-drag-region 提供,本组件只负责三个按钮。
import React, { useEffect, useState } from 'react';
import { isTauri } from '../../utils/desktop';
import './WindowControls.scss';

interface TauriWindowLike {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onResized: (cb: (e: { payload: unknown }) => void) => Promise<() => void>;
  close: () => Promise<void>;
}

function win(): TauriWindowLike | null {
  const t = (window as any).__TAURI__;
  if (!t?.window?.getCurrentWindow) return null;
  return t.window.getCurrentWindow();
}

export default function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    (async () => {
      const w = win();
      if (!w) return;
      try { setMaximized(await w.isMaximized()); } catch { /* 权限缺失时忽略 */ }
      try {
        un = await w.onResized(() => {
          w.isMaximized().then(setMaximized).catch(() => {});
        });
      } catch { /* 监听失败不阻塞 */ }
    })();
    return () => { un?.(); };
  }, []);

  if (!isTauri()) return null;

  return (
    <div className="winctls">
      <button className="winctl winctl-min" title="最小化" aria-label="最小化"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => { win()?.minimize().catch(() => {}); }}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      </button>
      <button className="winctl winctl-max" title={maximized ? '还原' : '最大化'} aria-label={maximized ? '还原' : '最大化'}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => { win()?.toggleMaximize().catch(() => {}); }}>
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            {/* 还原:两个错位方框,整体包围盒中心 = (5,5) */}
            <rect x="1" y="3" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1.1" />
            <rect x="3" y="1" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        )}
      </button>
      <button className="winctl winctl-close" title="关闭" aria-label="关闭"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => { win()?.close().catch(() => {}); }}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      </button>
    </div>
  );
}