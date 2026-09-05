import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '../../types';
import { useLongPress } from '../../hooks/useLongPress';
import './SessionPanel.scss';

interface SessionPanelProps {
  sessions?: Session[];
  activeId: string | null;
  busyIds?: string[];
  /** 模型提问挂起(等待用户操作)的会话 id 集合:运行点由绿变黄 */
  askPendingIds?: string[];
  /** 当前作用域标签(连接的服务器或「本地工作区」) */
  scopeLabel?: string;
  /** 当前作用域键(username@host:port 或 'local');用于识别其他服务器后台运行的会话 */
  scopeKey?: string | null;
  onNew: () => void;
  onSwitch: (id: string) => void;
  /** 点击其他服务器正在运行的会话:切回该服务器并打开它 */
  onSwitchForeign?: (id: string, connKey: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

// 三点菜单的预估尺寸(用于视口边界夹取/向上翻转;宽对齐 .ctxmenu 的 min-width 175px)
const MENU_W = 175;
const MENU_H = 78;

// 会话行时间格式化(模块级,SessionRow 复用)
function fmtTime(t: string | number | undefined) {
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// 会话列表单行:独立子组件以便在每行内调用 useLongPress(hook 不能在 map 循环中调用)。
// 长按(触屏)与 ⋮ 按钮(桌面)共用 onMenuAt 打开同一个三点菜单;长按后的 click 被吞掉,不误切会话。
interface SessionRowProps {
  session: Session;
  active: boolean;
  running: boolean;
  /** 有挂起提问(等待用户操作)时运行点变黄;仅非当前会话才显示 */
  askWaiting: boolean;
  onSwitch: (id: string) => void;
  onMenu: (e: React.MouseEvent, s: Session) => void;
  onMenuAt: (x: number, y: number, s: Session) => void;
}
function SessionRow({ session: s, active, running, askWaiting, onSwitch, onMenu, onMenuAt }: SessionRowProps) {
  const lp = useLongPress((x, y) => onMenuAt(x, y, s));
  return (
    <div key={s.id} className={`session-item ${active ? 'active' : ''}`}
      {...lp.bind}
      onClick={(ev) => { if (lp.wasLongPress()) return; onSwitch(s.id); }}>
      {askWaiting
        ? <span className="s-run warn" data-tip="等待用户操作">●</span>
        : running && <span className="s-run" data-tip="任务进行中">●</span>}
      {/* 点击始终触发切换请求(含当前会话):重载失败/加载中的会话可再次点击重试,
          而非被 activeId 守卫挡成 no-op */}
      <span className="s-title">
        {s.title || '新会话'}
      </span>
      <span className="s-meta">{fmtTime(s.updatedAt)}</span>
      <span className="s-actions" onClick={(e) => e.stopPropagation()}>
        <button className="action-icon s-more" data-tip="更多操作" onClick={(e) => onMenu(e, s)}>⋮</button>
      </span>
    </div>
  );
}

// 历史会话面板:新建/切换/重命名/删除会话(当前作用域的会话)
// 多会话并行:busyIds 是正在运行任务的会话集合——随时可新建/切换,切回运行中的会话可看到进行中的状态
// 跨服务器:其他服务器仍在后台运行的会话也显示在列表里(带所属服务器标记与「运行中」,
// 点击可切回该服务器查看);它们只在运行期间可见,结束后回到各自服务器的会话列表。
// 行尾「⋯」展开三点菜单(重命名/删除),重命名通过弹窗完成,不再内嵌编辑框(避免列表高度抖动)。
export default function SessionPanel({ sessions = [], activeId, busyIds = [], askPendingIds = [], scopeLabel, scopeKey, onNew, onSwitch, onSwitchForeign, onRename, onDelete }: SessionPanelProps) {
  // 三点菜单:当前展开的会话 + 屏幕坐标(portal 到 body、fixed 定位,不被侧栏 overflow 裁剪)
  const [menu, setMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // 重命名弹窗:正在重命名的会话 + 输入框内容
  const [rename, setRename] = useState<Session | null>(null);
  const [renameText, setRenameText] = useState('');

  // 其他服务器后台运行的会话:connKey 与当前作用域不同,且仅在运行中(服务端只下发运行中的)
  const foreign = scopeKey ? (sessions || []).filter((s) => s.connKey && s.connKey !== scopeKey) : [];
  // 当前作用域的会话:仅显示"有对话内容"的(msgCount>0)、正运行中、或当前激活的——
  // 新建会话(尚未发送首条消息,或服务端自动创建的空会话)不占历史列表位,
  // 发送开始对话后才按内容出现在列表(服务端只在发言后计入 msgCount)
  const mine = (sessions || []).filter((s) => !foreign.includes(s) && (s.id === activeId || busyIds.includes(s.id) || (s.msgCount ?? 0) > 0));
  const foreignLabel = (s: Session) => s.connKey === 'local' ? '本地工作区' : String(s.connKey || '');

  // 打开三点菜单:右对齐按钮、向下弹出;底部放不下时向上翻转,并夹取到视口内
  const openMenu = (e: React.MouseEvent, s: Session) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenuAt(r.right - MENU_W, r.bottom + 6, s);
  };
  // 坐标版:供触屏长按调用(长按没有 DOM 事件与按钮 rect,直接用手指坐标)
  const openMenuAt = (x: number, y: number, s: Session) => {
    let px = Math.max(8, Math.min(x, window.innerWidth - MENU_W - 8));
    let py = y;
    if (py + MENU_H > window.innerHeight - 8) py = Math.max(8, y - MENU_H - 6);
    setMenu({ session: s, x: px, y: py });
  };
  const closeMenu = () => setMenu(null);

  // 菜单打开期间:点击外部 / Esc / 滚动 关闭(对齐 FileManager 右键菜单的收拢方式)
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      setMenu(null);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  // 重命名弹窗
  const openRename = (s: Session) => { closeMenu(); setRename(s); setRenameText(s.title || ''); };
  const commitRename = () => {
    const t = renameText.trim();
    const id = rename?.id;
    setRename(null);
    if (id && t) onRename(id, t);
  };
  const cancelRename = () => setRename(null);

  return (
    <div className="panel s-panel">
      <div className="panel-title row" style={{ justifyContent: 'space-between' }}>
        <span>历史会话</span>
        <button className="sm" onClick={() => onNew()}>＋ 新建</button>
      </div>
      {scopeLabel && <div className="s-scope">📡 {scopeLabel}</div>}
      <div className="s-list">
        {mine.length === 0 && <div className="muted" style={{ fontSize: 12 }}>暂无历史会话,点「＋ 新建」开始</div>}
        <div className="sessions">
          {mine.map((s) => {
            const running = busyIds.includes(s.id);
            // 有挂起提问(等待用户操作)时运行点变黄;仅非当前会话才显示——
            // 正在看的会话顶部已有提问面板,点保持绿色运行态,避免重复提示
            const askWaiting = askPendingIds.includes(s.id) && s.id !== activeId;
            return (
              <SessionRow key={s.id} session={s}
                active={s.id === activeId}
                running={running}
                askWaiting={askWaiting}
                onSwitch={onSwitch}
                onMenu={openMenu}
                onMenuAt={openMenuAt} />
            );
          })}
        </div>
        {foreign.length > 0 && (
          <div className="s-foreign">
            <div className="s-foreign-title">其他服务器后台运行中</div>
            {foreign.map((s) => (
              <div key={s.id} className="session-item foreign" data-tip="该会话仍在原服务器后台运行"
                onClick={() => onSwitchForeign?.(s.id, s.connKey || '')}>
                {askPendingIds.includes(s.id)
                  ? <span className="s-run warn" data-tip="等待用户操作">●</span>
                  : <span className="s-run" data-tip="任务进行中">●</span>}
                <span className="s-title">
                  {s.title || '新会话'}
                  <span className="s-foreign-badge">📡 {foreignLabel(s)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 三点下拉菜单:portal 到 body,与右键菜单同款悬浮厚玻璃 */}
      {menu && createPortal(
        <div ref={menuRef} className="ctxmenu" style={{ left: menu.x, top: menu.y }} onContextMenu={(e) => e.preventDefault()}>
          <button onClick={() => openRename(menu.session)}>重命名</button>
          <div className="ctx-sep" />
          <button className="danger" data-tip={busyIds.includes(menu.session.id) ? '任务进行中,不能删除' : undefined}
            disabled={busyIds.includes(menu.session.id)}
            onClick={() => { closeMenu(); onDelete(menu.session.id); }}>删除</button>
        </div>,
        document.body
      )}

      {/* 重命名弹窗:复用全局 .modal 玻璃面板;portal 到 body,避免被侧栏 backdrop-filter 的固定定位包含块裁剪 */}
      {rename && createPortal(
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) cancelRename(); }}>
          <div className="modal s-rename-modal" role="dialog" aria-modal="true"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancelRename(); } }}>
            <div className="modal-head">
              <span>重命名会话</span>
              <button type="button" className="ghost" onClick={cancelRename}>✕</button>
            </div>
            <div className="modal-body">
              <input autoFocus value={renameText} onChange={(e) => setRenameText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); }}
                placeholder="会话名称" />
            </div>
            <div className="modal-foot row gap">
              <button type="button" className="grow" onClick={cancelRename}>取消</button>
              <button type="button" className="primary grow" onClick={commitRename}>确定</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
