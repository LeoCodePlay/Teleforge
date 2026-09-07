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
  /** 分组内「＋」:切到该分组工作区后新建会话(工作区参数二选一,未指定工作区组回落 onNew) */
  onNewInWorkspace?: (ws: string | null, localWs: string | null) => void;
  /** 点击其他服务器正在运行的会话:切回该服务器并打开它 */
  onSwitchForeign?: (id: string, connKey: string) => void;
  onSwitch: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

// 三点菜单的预估尺寸(用于视口边界夹取/向上翻转;宽对齐 .ctxmenu 的 min-width 175px)
const MENU_W = 175;
const MENU_H = 78;

// 未指定工作区的分组键与显示名
const UNGROUPED = '__ungrouped__';
const UNGROUPED_LABEL = '未指定工作区';

// 会话行时间格式化(模块级,SessionRow 复用)
function fmtTime(t: string | number | undefined) {
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// 工作区路径取最后一段作为分组头显示名(兼容 / 与 \ 分隔)
function lastPathSegment(p: string): string {
  const t = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  return i >= 0 ? t.slice(i + 1) : (t || '');
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

// 一个工作区分组:分组头(折叠箭头 + 图标 + 路径名 + 计数 + 组内新建) + 折叠的会话行
interface WorkspaceGroupProps {
  label: string;
  icon: string;
  sessions: Session[];
  expanded: boolean;
  activeId: string | null;
  busyIds: string[];
  askPendingIds: string[];
  onToggle: () => void;
  onNewInGroup: () => void;
  onSwitch: (id: string) => void;
  onMenu: (e: React.MouseEvent, s: Session) => void;
  onMenuAt: (x: number, y: number, s: Session) => void;
}
function WorkspaceGroup({ label, icon, sessions, expanded, activeId, busyIds, askPendingIds, onToggle, onNewInGroup, onSwitch, onMenu, onMenuAt }: WorkspaceGroupProps) {
  const hasRunning = sessions.some((s) => busyIds.includes(s.id));
  return (
    <div className="s-group">
      <div className={`s-group-header${expanded ? ' open' : ''}`} onClick={onToggle}>
        <span className="s-group-caret">▸</span>
        <span className="s-group-ico">{icon}</span>
        <span className="s-group-title" title={label}>{label}</span>
        {hasRunning && <span className="s-run" data-tip="有任务进行中">●</span>}
        <span className="s-group-count">{sessions.length}</span>
        <span className="s-group-actions" onClick={(e) => e.stopPropagation()}>
          <button className="s-group-add" data-tip="在此工作区新建会话" onClick={() => onNewInGroup()}>＋</button>
        </span>
      </div>
      {expanded && (
        <div className="s-group-body">
          {sessions.map((s) => {
            const running = busyIds.includes(s.id);
            // 有挂起提问(等待用户操作)时运行点变黄;仅非当前会话才显示
            const askWaiting = askPendingIds.includes(s.id) && s.id !== activeId;
            return (
              <SessionRow key={s.id} session={s}
                active={s.id === activeId}
                running={running}
                askWaiting={askWaiting}
                onSwitch={onSwitch}
                onMenu={onMenu}
                onMenuAt={onMenuAt} />
            );
          })}
        </div>
      )}
    </div>
  );
}

// 任务列表面板(原「历史会话」):按工作区把会话分组展示(参照 deepseek-harness 侧栏会话树)。
// - 「远程任务列表」= 绑定了远程工作区的会话(按远程工作区分组);
//   「本地任务列表」= 无远程工作区的会话(按本地工作区分组)——连接服务器时两列表分开显示,
//   本地列表不隐藏;未连接时只有本地列表。
// - 分组头可折叠(折叠状态存 localStorage);当前会话所在组自动展开。
// - 分组内「＋」= 切到该工作区后新建会话;行尾「⋯」仍是重命名/删除。
// - 其他服务器后台运行的会话保持跨服务器可见,点击切回原服务器。
export default function SessionPanel({ sessions = [], activeId, busyIds = [], askPendingIds = [], scopeLabel, scopeKey, onNew, onNewInWorkspace, onSwitchForeign, onSwitch, onRename, onDelete }: SessionPanelProps) {
  // 三点菜单:当前展开的会话 + 屏幕坐标(portal 到 body、fixed 定位,不被侧栏 overflow 裁剪)
  const [menu, setMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // 重命名弹窗:正在重命名的会话 + 输入框内容
  const [rename, setRename] = useState<Session | null>(null);
  const [renameText, setRenameText] = useState('');

  // 工作区分组折叠状态:groupKey -> 是否折叠。缺省(未记录)= 展开;
  // 记录折叠的键写入 localStorage,跨刷新保留。分组键带作用域前缀,避免跨服务器冲突。
  const GROUPS_KEY = 'sshai.taskGroups';
  const loadGroupState = (): Record<string, boolean> => {
    try {
      const o = JSON.parse(localStorage.getItem(GROUPS_KEY) || '{}');
      return o && typeof o === 'object' ? o : {};
    } catch { return {}; }
  };
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>(loadGroupState);
  const saveCollapsed = (key: string, collapsed: boolean) => {
    setCollapsedMap((m) => {
      const next = { ...m, [key]: collapsed };
      try { localStorage.setItem(GROUPS_KEY, JSON.stringify(next)); } catch { /* 存储不可用忽略 */ }
      return next;
    });
  };
  const isExpanded = (key: string) => !collapsedMap[key];

  // 其他服务器后台运行的会话:connKey 是其他服务器(排除本地模式会话——连接时本地会话
  // 也始终可见,归入本地任务列表),且仅在运行中(服务端只下发运行中的)
  const foreign = scopeKey ? (sessions || []).filter((s) => s.connKey && s.connKey !== scopeKey && s.connKey !== 'local') : [];
  // 可见会话:仅显示"有对话内容"的(msgCount>0)、正运行中、或当前激活的——
  // 新建会话(尚未发送首条消息,或服务端自动创建的空会话)不占任务列表位
  const mine = (sessions || []).filter((s) => !foreign.includes(s) && (s.id === activeId || busyIds.includes(s.id) || (s.msgCount ?? 0) > 0));
  const foreignLabel = (s: Session) => s.connKey === 'local' ? '本地工作区' : String(s.connKey || '');

  // 分组:远程任务 = 绑定了远程工作区的会话(按远程工作区分组);
  // 本地任务 = 无远程工作区的会话(按本地工作区分组)——含未连接时的本地会话,
  // 以及连接了 SSH 但未选远程工作区、仅限本地工作的会话(需求:归本地任务列表)
  const remoteSessions = mine.filter((s) => s.workspace);
  const localSessions = mine.filter((s) => !s.workspace);
  const remoteKey = (ws: string) => `r:${scopeKey}:${ws}`;
  const localKey = (ws: string) => `l:${ws}`;
  const groupSessions = (list: Session[], wsOf: (s: Session) => string | null | undefined, keyOf: (ws: string) => string) => {
    const groups = new Map<string, Session[]>();
    for (const s of list) {
      const ws = wsOf(s) || UNGROUPED;
      const arr = groups.get(keyOf(ws)) || [];
      arr.push(s);
      groups.set(keyOf(ws), arr);
    }
    // 未指定工作区组排最后,其余按更新时间倒序(会话最近活跃的组靠前)
    return [...groups.entries()].sort((a, b) => {
      if (a[0] === b[0]) return 0;
      if (a[0].endsWith(`:${UNGROUPED}`)) return 1;
      if (b[0].endsWith(`:${UNGROUPED}`)) return -1;
      return (Number(b[1][0]?.updatedAt) || 0) - (Number(a[1][0]?.updatedAt) || 0);
    });
  };
  const remoteGroups = groupSessions(remoteSessions, (s) => s.workspace, remoteKey);
  const localGroups = groupSessions(localSessions, (s) => s.localWorkspace, localKey);

  // 当前激活会话所在组自动展开(harness SessionTree 行为):仅当该组从未被用户记录过折叠状态时生效,
  // 已手动折叠的组不强行展开
  useEffect(() => {
    if (!activeId) return;
    const active = mine.find((s) => s.id === activeId);
    if (!active) return;
    const key = active.workspace
      ? remoteKey(active.workspace)
      : localKey(active.localWorkspace || UNGROUPED);
    if (!Object.hasOwn(collapsedMap, key)) saveCollapsed(key, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, sessions]);

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

  const totalVisible = mine.length;
  const noTasks = totalVisible === 0;

  // 渲染一组会话(共用分组头/行渲染)
  const renderGroup = (groups: [string, Session[]][], wsOf: (s: Session) => string | null | undefined, keyOf: (ws: string) => string, icon: string, newInGroup: (ws: string | null) => void) =>
    groups.map(([key, list]) => {
      const label = key.endsWith(`:${UNGROUPED}`) ? UNGROUPED_LABEL : lastPathSegment(wsOf(list[0]) || '');
      return (
        <WorkspaceGroup key={key} label={label} icon={icon} sessions={list}
          expanded={isExpanded(key)}
          activeId={activeId} busyIds={busyIds} askPendingIds={askPendingIds}
          onToggle={() => saveCollapsed(key, isExpanded(key))}
          onNewInGroup={() => { const ws = key.endsWith(`:${UNGROUPED}`) ? null : wsOf(list[0]) || null; newInGroup(ws); }}
          onSwitch={onSwitch}
          onMenu={openMenu}
          onMenuAt={openMenuAt} />
      );
    });

  return (
    <div className="panel s-panel">
      <div className="panel-title row" style={{ justifyContent: 'space-between' }}>
        <span>任务列表</span>
        <button className="sm" onClick={() => onNew()}>＋ 新建</button>
      </div>
      {scopeLabel && <div className="s-scope">📡 {scopeLabel}</div>}
      <div className="s-list">
        {noTasks && <div className="muted" style={{ fontSize: 12 }}>暂无任务,点「＋ 新建」开始</div>}
        {remoteGroups.length > 0 && (
          <div className="s-section">
            <div className="s-section-title">远程任务列表</div>
            {renderGroup(remoteGroups, (s) => s.workspace, remoteKey, '🖥', (ws) => { if (onNewInWorkspace) onNewInWorkspace(ws, null); else onNew(); })}
          </div>
        )}
        {localGroups.length > 0 && (
          <div className="s-section">
            <div className="s-section-title">本地任务列表</div>
            {renderGroup(localGroups, (s) => s.localWorkspace, localKey, '📂', (lws) => { if (onNewInWorkspace) onNewInWorkspace(null, lws); else onNew(); })}
          </div>
        )}
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
