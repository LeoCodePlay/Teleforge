// 右侧栏外壳:对外保持原有 props(sid / request / renderBody),内部换成**搬来的 dsh dockkit**。
//
// 为什么保留这层薄壳而不是让 App 直接用 DockSidebar:
//   - 会话 id 决定宽度持久化($_WIDTH_KEY),这是本项目的既有行为,kit 不该知道会话;
//   - 那条最外层拖拽分隔条属于宿主外壳(改的是 aside 宽度),不是停靠面板内部的分隔条;
//   - App 侧不必改一行 —— 迁移风险集中在这一点上。
//
// 标签条 / 分栏 / 拖拽 / 浮动 / 右键菜单 / 空态全部由 DockSurface(dsh 原件)渲染,
// 布局与样式一律来自它的 CSS Modules,见 DockSidebar.tsx 顶部说明。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit';
import DockSidebar, { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH } from './DockSidebar';
import './RightSidebar.scss';

/** 外部请求「在右侧栏打开某内容」;nonce 变化即视为一次新请求(即使内容相同也要能再次触发) */
export interface SidebarOpenRequest {
  kind: string;
  contentId: string;
  title: string;
  nonce: number;
}

interface Props {
  /** 当前会话 id:仅用于宽度持久化(布局存在 dockkit 的 controller 里,按需扩展) */
  sid: string | null;
  /** 收起态:整条侧栏不渲染,主区拿回宽度(布局状态仍保留在 controller 里,展开即恢复) */
  collapsed?: boolean;
  /** 开合回调:右上角按钮与侧栏标签条末端的 ‹ 都走它 */
  onToggleCollapse?: () => void;
  /** 外部打开请求(来自文件树 / 成果物卡 / 文件改动卡) */
  request: SidebarOpenRequest | null;
  /** 渲染某个标签的正文。调用方按 tab.kind 分派;本组件不解释 kind 的含义。 */
  renderBody: (tab: TabRecord, api: { close: () => void; active: boolean }) => React.ReactNode;
  /** 可见性变化时通知外部(供布局/埋点用,外部不需要回控) */
  onVisibilityChange?: (open: boolean) => void;
  /** 右上角标签条末端的宿主控件(已有的收起按钮等) */
  chrome?: React.ReactNode;
}

const WIDTH_KEY = 'teleforge.sidebar-right.width.v1';
/** 主区域最小宽度:右栏再宽也不能把对话区挤到不可用 */
const MIN_MAIN = 420;

function readWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(v) && v >= SIDEBAR_MIN_WIDTH) return v;
  } catch { /* 隐私模式/禁用存储:用默认宽度 */ }
  return SIDEBAR_DEFAULT_WIDTH;
}

export default function RightSidebar({ sid, request, collapsed = false, onToggleCollapse, renderBody, onVisibilityChange, chrome }: Props) {
  const [width, setWidth] = useState(readWidth);
  const dragging = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // 宽度按会话持久化:不同会话的阅读习惯不同,切会话不该互相干扰
  useEffect(() => { try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* 忽略 */ } }, [width]);

  // 拖左边缘改宽度:拖动期间只改本地像素,抬手不再提交别的状态(没有 op 需要回放)。
  // 拖拽期间锁住整页的文字选择并保持 col-resize 光标:不然划过对话区会顺手选中一大片文本。
  const onEdgeDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragging.current = true;
    const handle = e.currentTarget as HTMLElement;
    handle.classList.add('dragging');
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) => {
      if (!dragging.current) return;
      const next = startW + (startX - ev.clientX);
      const maxW = Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - MIN_MAIN);
      setWidth(Math.min(maxW, Math.max(SIDEBAR_MIN_WIDTH, next)));
    };
    const onUp = () => {
      dragging.current = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [width]);

  // 收起态:整条侧栏不渲染(主区拿回宽度)。dockkit 的 controller 挂在 DockSidebar 内部,
  // 这里不渲染它意味着展开时会回到初始布局 —— 与 dsh 的 push 模式一致(收起只是把侧栏推开)。
  if (collapsed) return null;

  return (
    <aside className="sidebar sidebar-right" data-sid={sid ?? ''} style={{ width }} aria-label="右侧栏">
      <div className="resizer resizer-left" onPointerDown={onEdgeDown}
        role="separator" aria-label="调整右侧栏宽度" aria-orientation="vertical" />
      <div className="rsb-dock" ref={bodyRef}>
        {/* key=sid:切换会话时**重建** dockkit 的 controller,让每个会话有自己的一套布局。
            dsh 的 ui-sidebar-right 是「按会话持久化 + 切回来恢复」;这里是第一半(隔离),
            恢复要靠 dockkit 的 ops 回放(replay + recordedOps),等接持久化时再补。 */}
        <DockSidebar
          key={sid ?? 'none'}
          request={request}
          renderBody={renderBody}
          onVisibilityChange={onVisibilityChange}
          chrome={(
            <>
              {chrome}
              {onToggleCollapse && (
                <button type="button" className="rsb-collapse" data-tip="收起右侧栏"
                  aria-label="收起右侧栏" onClick={onToggleCollapse}>›</button>
              )}
            </>
          )}
        />
      </div>
    </aside>
  );
}
