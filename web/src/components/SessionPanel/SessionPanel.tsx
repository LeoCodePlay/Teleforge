import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '../../types';
import { NO_WORKSPACE, WHOLE_LABEL } from '../../types';
import { useLongPress } from '../../hooks/useLongPress';
import { sessionDot, sessionDotClass, SESSION_DOT_TIP } from '../../utils/sessionDot';
import { useGroupReorder } from '../../hooks/useGroupReorder';
import { orderGroups } from '../../utils/sessionGroupOrder';
import './SessionPanel.scss';

interface SessionPanelProps {
  sessions?: Session[];
  activeId: string | null;
  busyIds?: string[];
  /** 模型提问挂起(等待用户操作)的会话 id 集合:运行点由绿变黄 */
  askPendingIds?: string[];
  /** 有后台终端(AI 运行终端)在跑的会话 id 集合:会话空闲时状态点显示蓝色 */
  termRunningIds?: string[];
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
  /**
   * 删除整个工作区分组(分组头右键 / 触屏长按):该分组下的对话记录一并永久删除。
   * ids = 组内全部会话;ws = 分组绑定的工作区路径(「未指定工作区」与「不在工作区对话」哨兵为 null);
   * local 区分该路径属于本地还是远程工作区(决定从哪份历史记录里移除)
   */
  onDeleteGroup?: (ids: string[], ws: string | null, local: boolean) => void;
  /** 分组菜单「在资源管理器打开」:仅本地工作区分组可用(path = 该分组的本地工作区目录) */
  onRevealGroup?: (path: string) => void;
}

// 三点菜单的预估尺寸(用于视口边界夹取/向上翻转;宽对齐 .ctxmenu 的 min-width 175px)
const MENU_W = 175;
const MENU_H = 78;

// 分组菜单(右键/触屏长按分组头)的预估尺寸:比三点菜单宽(「删除分组(含 N 个对话)」文案更长)
const GROUP_MENU_W = 220;
const GROUP_MENU_H = 78;

/** 分组元信息:渲染分组头与分组菜单共用(label 显示名 / list 组内会话 / ws 可清理的工作区路径) */
interface GroupMeta {
  key: string;
  sectionId: string;
  label: string;
  list: Session[];
  /** 该分组绑定的工作区路径;「未指定工作区」与「不在工作区对话」哨兵为 null(没有历史记录可清) */
  ws: string | null;
  /** 组内「＋」新建会话要带的工作区参数(未指定工作区时为 null) */
  newWs: string | null;
  /** ws 属于本地工作区历史 */
  local: boolean;
}

/** 分组菜单:被右键/长按的工作区分组 + 屏幕坐标 */
interface GroupMenuState extends Omit<GroupMeta, 'list' | 'newWs'> {
  ids: string[];
  x: number;
  y: number;
}

// 分组内会话的「分页展开」步长:首次展开最多 5 条,超出才在组尾出现「查看更多」文本入口,
// 点一次再放 10 条,直到全部展开(此时入口自行消失)
const GROUP_SHOW_FIRST = 5;
const GROUP_SHOW_STEP = 10;

// 未指定工作区的分组键与显示名
const UNGROUPED = '__ungrouped__';
const UNGROUPED_LABEL = '未指定工作区';

// 会话是否绑定了「具体的远程工作区目录」。
// 「不在工作区对话」在服务端把会话绑定值存成哨兵字符串 NO_WORKSPACE(边界=整台服务器),
// 它是真值但不是目录:这类会话正是「连着 SSH 却没选远程工作区、只在本地干活」的那批,
// 按 SessionPanel 下方的分流需求必须归本地任务列表,所以判据不能只看真值。
// 写成类型谓词是为了让 TS 在调用处把 workspace 收窄成 string。
function hasRemoteWorkspace(s: Session): s is Session & { workspace: string } {
  return !!s.workspace && s.workspace !== NO_WORKSPACE;
}

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
  /** 该会话名下有还在跑的后台终端:会话空闲时状态点显示蓝色 */
  termRunning: boolean;
  onSwitch: (id: string) => void;
  onMenu: (e: React.MouseEvent, s: Session) => void;
  onMenuAt: (x: number, y: number, s: Session) => void;
}
function SessionRow({ session: s, active, running, askWaiting, termRunning, onSwitch, onMenu, onMenuAt }: SessionRowProps) {
  const lp = useLongPress((x, y) => onMenuAt(x, y, s));
  // 悬停整行时在右侧弹出首条提问:标题只是前 24 字,完整提问更有辨识度;没有提问则回落标题
  const tip = s.prompt || s.title || '';
  // 绿(任务进行中)> 黄(等待用户操作)> 蓝(会话空闲但有后台终端在跑)> 不显示
  const dot = sessionDot({ running, askWaiting, termRunning });
  const dotTip = SESSION_DOT_TIP[dot];
  return (
    // 悬停整行 → 右侧宽气泡展示该会话的首条提问(气泡由全局 TooltipHost 统一渲染)
    <div key={s.id} className={`session-item ${active ? 'active' : ''}`}
      {...(tip ? { 'data-tip': tip, 'data-tip-side': 'right', 'data-tip-wide': 'true' } : {})}
      {...lp.bind}
      onClick={(ev) => { if (lp.wasLongPress()) return; onSwitch(s.id); }}>
      {/* 状态点常驻占位:空闲行也留一格(仅 visibility 隐藏),
          否则有/无小点的两行会话标题左边缘会参差不齐 */}
      <span className={sessionDotClass(dot)} {...(dotTip ? { 'data-tip': dotTip } : {})} />
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

// 一个工作区分组:分组头(折叠箭头 + 图标 + 路径名 + 尾部槽) + 折叠的会话行
// 尾部槽:静止=「运行状态点 + 任务数」,悬停=「组内新建会话」按钮(两者叠在同一格交叉切换)
// 拖拽排序绑定:分组头一按下就交给 useGroupReorder,拖起态也从这里回灌渲染
interface GroupSortBinding {
  groupKey: string;
  sectionId: string;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  wasDragging: () => boolean;
}
interface WorkspaceGroupProps {
  label: string;
  icon: string;
  sessions: Session[];
  expanded: boolean;
  activeId: string | null;
  busyIds: string[];
  askPendingIds: string[];
  termRunningIds: string[];
  sort: GroupSortBinding;
  onToggle: () => void;
  onNewInGroup: () => void;
  onSwitch: (id: string) => void;
  onMenu: (e: React.MouseEvent, s: Session) => void;
  onMenuAt: (x: number, y: number, s: Session) => void;
}
function WorkspaceGroup({ label, icon, sessions, expanded, activeId, busyIds, askPendingIds, termRunningIds, sort, onToggle, onNewInGroup, onSwitch, onMenu, onMenuAt }: WorkspaceGroupProps) {
  const hasRunning = sessions.some((s) => busyIds.includes(s.id));
  const hasTermRunning = sessions.some((s) => termRunningIds.includes(s.id));
  // 组内可见条数:首次展开只看前 GROUP_SHOW_FIRST 条(会话按用户最近发消息时间倒序下发,留下的正是最近活跃的);
  // 收起分组即复位,下次展开仍回到「首次展开」的样子,不残留上一轮的展开进度
  const [shownCount, setShownCount] = useState(GROUP_SHOW_FIRST);
  useEffect(() => { if (!expanded) setShownCount(GROUP_SHOW_FIRST); }, [expanded]);
  const shown = sessions.slice(0, shownCount);
  const restCount = sessions.length - shown.length;
  return (
    <div className={`s-group${sort.dragging ? ' dragging' : ''}`}
      data-group-key={sort.groupKey} data-section-id={sort.sectionId}>
      <div className={`s-group-header${expanded ? ' open' : ''}`}
        onPointerDown={sort.onPointerDown}
        onContextMenu={sort.onContextMenu}
        onClick={() => { if (sort.wasDragging()) return; onToggle(); }}>
        <span className="s-group-lead" aria-hidden>
          <svg className="s-group-caret" width={14} height={14} viewBox="0 0 14 14" fill="none">
            <path d="M5.3 3.4L9 7l-3.7 3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="s-group-ico">{icon}</span>
        </span>
        <span className="s-group-title" title={label}>{label}</span>
        {/* 尾部只留一格:「运行状态点 + 任务数」与「在此工作区新建会话」按钮叠放在同一格交叉切换。
            悬停分组头时按钮旋入、计数淡出;移开则还原——按钮不再隐形常驻占位,右侧不会空出一片 */}
        <span className="s-group-tail" onClick={(e) => e.stopPropagation()}>
          <span className="s-group-meta">
            {hasRunning
              ? <span className="s-run" data-tip="有任务进行中" />
              : hasTermRunning && <span className="s-run term" data-tip="有后台终端在运行" />}
            <span className="s-group-count">{sessions.length}</span>
          </span>
          <button type="button" className="s-group-add" aria-label="在此工作区新建会话"
            data-tip="在此工作区新建会话"
            // 指针抬起即交还焦点:否则点完「＋」后按钮一直持有焦点,尾部让位规则被钉住,
            // 鼠标移开也回不到「状态点 + 任务数」。键盘 Enter/Space 触发 click 不产生 pointerup,可达性不受影响
            onPointerUp={(e) => e.currentTarget.blur()}
            onClick={() => onNewInGroup()}>
            <svg width={11} height={11} viewBox="0 0 11 11" fill="none" aria-hidden>
              <path d="M5.5 1.7v7.6M1.7 5.5h7.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
        </span>
      </div>
      {/* 展开体常驻 DOM(不卸载),用 grid-template-rows 0fr↔1fr 做高度过渡:
          展开/收起都有平滑动画;收起时 visibility:hidden 保证不可聚焦/不被读到 */}
      <div className={`s-group-body-wrap${expanded ? ' open' : ''}`} aria-hidden={!expanded}>
        <div className="s-group-body-clip">
          <div className="s-group-body">
            {shown.map((s) => {
              const running = busyIds.includes(s.id);
              // 有挂起提问(等待用户操作)时运行点变黄;仅非当前会话才显示
              const askWaiting = askPendingIds.includes(s.id) && s.id !== activeId;
              return (
                <SessionRow key={s.id} session={s}
                  active={s.id === activeId}
                  running={running}
            termRunning={termRunningIds.includes(s.id)}
                  askWaiting={askWaiting}
                  onSwitch={onSwitch}
                  onMenu={onMenu}
                  onMenuAt={onMenuAt} />
              );
            })}
            {/* 还有没放出来的会话:组尾一个纯文本入口(复用全局 button.link 的「可点击文字」样式,
                不是胶囊按钮),点一次多放 GROUP_SHOW_STEP 条,全部展开后自动消失 */}
            {restCount > 0 && (
              <button type="button" className="link s-group-more"
                onClick={() => setShownCount((n) => n + GROUP_SHOW_STEP)}>
                查看更多
              </button>
            )}
          </div>
        </div>
      </div>
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
// - 工作区分组的顺序固定(按路径字典序,不随会话活跃时间抖动),可拖拽自定义:
//   桌面按住分组头拖,触屏长按分组头弹菜单、再由「拖动排序」起拖;顺序存 localStorage,
//   只有「会话行」按最近活跃排序。
// - 分组头右键(桌面)/长按(触屏)弹分组菜单:删除分组 = 该组全部对话记录 + 该工作区历史记录。
export default function SessionPanel({ sessions = [], activeId, busyIds = [], askPendingIds = [], termRunningIds = [], scopeLabel, scopeKey, onNew, onNewInWorkspace, onSwitchForeign, onSwitch, onRename, onDelete, onDeleteGroup, onRevealGroup }: SessionPanelProps) {
  // 三点菜单:当前展开的会话 + 屏幕坐标(portal 到 body、fixed 定位,不被侧栏 overflow 裁剪)
  const [menu, setMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // 重命名弹窗:正在重命名的会话 + 输入框内容
  const [rename, setRename] = useState<Session | null>(null);
  const [renameText, setRenameText] = useState('');
  // 分组菜单(右键 / 触屏长按分组头):当前分组 + 屏幕坐标
  const [groupMenu, setGroupMenu] = useState<GroupMenuState | null>(null);
  const groupMenuRef = useRef<HTMLDivElement>(null);
  // 长按回调只拿得到 key 与坐标:用一张 key -> 分组元信息的表取回分组详情(渲染时登记,见下方 remoteMeta/localMeta)
  const groupMetaRef = useRef(new Map<string, GroupMeta>());
  const closeGroupMenu = () => setGroupMenu(null);
  // 坐标版:夹取到视口内,底部放不下时向上翻转
  const openGroupMenuAt = (x: number, y: number, g: GroupMeta | undefined, key: string, sectionId: string) => {
    if (!g) return;
    let py = y;
    if (py + GROUP_MENU_H > window.innerHeight - 8) py = Math.max(8, y - GROUP_MENU_H - 6);
    setGroupMenu({
      key, sectionId, label: g.label, ids: g.list.map((s) => s.id), ws: g.ws, local: g.local,
      x: Math.max(8, Math.min(x, window.innerWidth - GROUP_MENU_W - 8)), y: py
    });
  };

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

  // 分组:远程任务 = 绑定了具体远程工作区目录的会话(按该目录分组);
  // 本地任务 = 没绑定远程目录的会话(按本地工作区分组)——含未连接时的本地会话,
  // 以及连接了 SSH 但未选远程工作区、仅限本地工作的会话(需求:归本地任务列表);
  // 远程侧「不在工作区对话」的哨兵绑定(NO_WORKSPACE)按「没绑定远程目录」处理,同样归本地列表
  // 仅"已连接服务器"(作用域为服务器键)时分开显示远程任务/本地任务两列表;
  // 断开连接(本地作用域)后不再展示「远程任务列表」——此时无远程可用,绑定了远程
  // 工作区的会话(含错误残留绑定)降级归入本地任务分组,避免远程分组在断线后残留。
  const inRemoteScope = !!scopeKey && scopeKey !== 'local';
  const remoteSessions = inRemoteScope ? mine.filter((s) => hasRemoteWorkspace(s)) : [];
  const localSessions = mine.filter((s) => (inRemoteScope ? !hasRemoteWorkspace(s) : true));
  const remoteKey = (ws: string) => `r:${scopeKey}:${ws}`;
  const localKey = (ws: string) => `l:${ws}`;
  // 分区 id:远程按作用域(每台服务器各排各的),本地与服务器无关——与分组键前缀同源
  const remoteSection = `r:${scopeKey}`;
  const localSection = 'l';

  // 工作区分组顺序(拖拽结果):分区 id -> 该分区内分组 key 的完整顺序,存 localStorage。
  // 只有被拖过的分区才有记录;没记录时按下面的默认规则排,保证工作区顺序固定、
  // 不随会话活跃时间抖动——「按最近活跃」只用在同一工作区内部的会话行上。
  const ORDER_KEY = 'sshai.taskGroupOrder';
  const loadOrder = (): Record<string, string[]> => {
    try {
      const o = JSON.parse(localStorage.getItem(ORDER_KEY) || '{}');
      return o && typeof o === 'object' ? o : {};
    } catch { return {}; }
  };
  const [orderMap, setOrderMap] = useState<Record<string, string[]>>(loadOrder);
  const commitOrder = (sectionId: string, keys: string[]) => {
    setOrderMap((m) => {
      const next = { ...m, [sectionId]: keys };
      try { localStorage.setItem(ORDER_KEY, JSON.stringify(next)); } catch { /* 存储不可用忽略 */ }
      return next;
    });
  };
  // 拖拽排序:桌面按住拖、触屏长按拖;只在同一分区内生效,松手才提交顺序
  const listRef = useRef<HTMLDivElement>(null);
  // 触屏长按分组头 = 弹分组菜单(排序入口挪到菜单里的「拖动排序」)
  const { drag, bindHeader, isBusy, wasDragging, reorder } = useGroupReorder({
    rootRef: listRef,
    onCommit: commitOrder,
    onLongPress: (key, sectionId, x, y) => openGroupMenuAt(x, y, groupMetaRef.current.get(key), key, sectionId)
  });

  const groupSessions = (list: Session[], wsOf: (s: Session) => string | null | undefined, keyOf: (ws: string) => string) => {
    const groups = new Map<string, Session[]>();
    for (const s of list) {
      const ws = wsOf(s) || UNGROUPED;
      const arr = groups.get(keyOf(ws)) || [];
      arr.push(s);
      groups.set(keyOf(ws), arr);
    }
    // 组内保持服务端下发的顺序(会话最近活跃的靠前);组间顺序交给 sortGroups
    return [...groups.entries()];
  };
  // 组间顺序:拖拽过的分区按用户排好的手动顺序(新出现的工作区接在末尾,不插进用户排好的序列);
  // 没拖过的分区按组内「用户最近发消息时间」倒序——刚聊过的工作区浮到最前,
  // 活跃度相同(如都没发过消息)时按工作区路径字典序保持稳定(「未指定工作区」固定最后)。
  // 排序键用 lastUserAt(用户发消息时间)而非 updatedAt,AI 回复不会让工作区分组重排。
  const sortGroups = (groups: [string, Session[]][], sectionId: string, wsOf: (s: Session) => string | null | undefined) =>
    orderGroups(groups, { sectionId, orderMap, wsOf, ungrouped: UNGROUPED });
  // 拖拽中该分区按实时顺序渲染(被拖分组立刻让位/前移);松手后由 orderMap 接管
  const withPreview = (groups: [string, Session[]][], sectionId: string) => {
    if (!drag || drag.sectionId !== sectionId) return groups;
    const out: [string, Session[]][] = [];
    const used = new Set<string>();
    for (const k of drag.keys) {
      const g = groups.find((x) => x[0] === k);
      if (g && !used.has(k)) { out.push(g); used.add(k); }
    }
    for (const g of groups) if (!used.has(g[0])) out.push(g); // 拖拽中才出现的新分组补在末尾
    return out;
  };
  const remoteGroups = withPreview(sortGroups(groupSessions(remoteSessions, (s) => s.workspace, remoteKey), remoteSection, (s) => s.workspace), remoteSection);
  const localGroups = withPreview(sortGroups(groupSessions(localSessions, (s) => s.localWorkspace, localKey), localSection, (s) => s.localWorkspace), localSection);

  // 分组元信息:显示名与「＋ 新建」的工作区参数都从组内首条会话派生(与 groupSessions 的分组依据一致)。
  // 「未指定工作区」与「不在工作区对话」哨兵虽是真值但都不是目录:它们不进工作区历史记录,
  // 所以 ws(删除分组时要一并清理的历史记录)置 null,而 newWs 仍按原样透传(整台电脑/服务器是全盘模式)
  const groupMeta = (groups: [string, Session[]][], wsOf: (s: Session) => string | null | undefined, wholeLabel: string, local: boolean, sectionId: string): GroupMeta[] =>
    groups.map(([key, list]) => {
      const ws = wsOf(list[0]) || '';
      const ungrouped = key.endsWith(`:${UNGROUPED}`);
      return {
        key, sectionId, list, local,
        label: ungrouped ? UNGROUPED_LABEL : (ws === NO_WORKSPACE ? `🌐 ${wholeLabel}` : lastPathSegment(ws)),
        ws: ungrouped || !ws || ws === NO_WORKSPACE ? null : ws,
        newWs: ungrouped ? null : (ws || null)
      };
    });
  const remoteMeta = groupMeta(remoteGroups, (s) => s.workspace, WHOLE_LABEL.remote, false, remoteSection);
  const localMeta = groupMeta(localGroups, (s) => s.localWorkspace, WHOLE_LABEL.local, true, localSection);
  groupMetaRef.current = new Map([...remoteMeta, ...localMeta].map((m) => [m.key, m])); // 长按回调(事件期)按 key 取回分组详情

  // 当前激活会话所在组自动展开(harness SessionTree 行为):仅当该组从未被用户记录过折叠状态时生效,
  // 已手动折叠的组不强行展开
  useEffect(() => {
    if (!activeId) return;
    const active = mine.find((s) => s.id === activeId);
    if (!active) return;
    const key = hasRemoteWorkspace(active)
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

  // 分组菜单「拖动排序」:先收菜单,再把该分组交给拖拽 hook 起拖
  // (触屏此时没有按住状态,靠之后的指针移动跟手;桌面按住分组头即可拖,故菜单项在桌面隐藏,见 SCSS)
  const doReorderGroup = () => {
    const g = groupMenu;
    if (!g) return;
    closeGroupMenu();
    const row = listRef.current?.querySelector<HTMLElement>(`[data-group-key="${g.key}"] > .s-group-header`);
    const r = row?.getBoundingClientRect();
    reorder(g.key, g.sectionId, r ? r.top + r.height / 2 : window.innerHeight / 2);
  };

  // 分组菜单「在资源管理器打开」:只对绑定本机目录的分组可用(远程分组与未绑定工作区的分组
  // 都没有本地目录 —— 菜单项已置灰,这里再兜一道,避免将来新增入口时漏判)
  const doRevealGroup = () => {
    const g = groupMenu;
    if (!g?.local || !g.ws) return;
    closeGroupMenu();
    onRevealGroup?.(g.ws);
  };

  // 分组菜单「删除分组」:分组没了,顺手清掉它在 localStorage 里的折叠状态与拖拽顺序残留,
  // 再把整组会话 id 交给上层执行删除(确认弹窗、RPC、工作区历史清理都在 App 里统一处理)
  const doDeleteGroup = () => {
    const g = groupMenu;
    if (!g) return;
    closeGroupMenu();
    setCollapsedMap((m) => {
      if (!Object.hasOwn(m, g.key)) return m;
      const next = { ...m };
      delete next[g.key];
      try { localStorage.setItem(GROUPS_KEY, JSON.stringify(next)); } catch { /* 存储不可用忽略 */ }
      return next;
    });
    setOrderMap((m) => {
      const list = m[g.sectionId];
      if (!list || !list.includes(g.key)) return m;
      const next = { ...m, [g.sectionId]: list.filter((k) => k !== g.key) };
      try { localStorage.setItem(ORDER_KEY, JSON.stringify(next)); } catch { /* 存储不可用忽略 */ }
      return next;
    });
    onDeleteGroup?.(g.ids, g.ws, g.local);
  };

  // 菜单打开期间:点击外部 / Esc / 滚动 关闭(对齐 FileManager 右键菜单的收拢方式)
  useEffect(() => {
    if (!menu && !groupMenu) return;
    const close = () => { setMenu(null); setGroupMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || groupMenuRef.current?.contains(t)) return;
      close();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu, groupMenu]);

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
  // 分组内有任务在跑:整组删除不可用(与服务端「运行中禁止删除会话」同一条约束)
  const groupBusy = !!groupMenu && groupMenu.ids.some((id) => busyIds.includes(id));
  // 「在资源管理器打开」不可用的原因(undefined = 可用):远程工作区在本机没有对应目录,
  // 「未指定工作区」「不在工作区对话」这类分组也没有具体目录
  const revealTip = !groupMenu ? undefined
    : !groupMenu.local ? '远程工作区在本地没有对应目录,无法在资源管理器打开'
      : groupMenu.ws ? undefined : '该分组未绑定具体工作区目录';

  // 渲染一组会话(共用分组头/行渲染);分组显示名与「＋ 新建」的工作区参数由 groupMeta 派生
  const renderGroup = (groups: GroupMeta[], icon: string, newInGroup: (ws: string | null) => void) =>
    groups.map((g) => (
      <WorkspaceGroup key={g.key} label={g.label} icon={icon} sessions={g.list}
        expanded={isExpanded(g.key)}
        activeId={activeId} busyIds={busyIds} askPendingIds={askPendingIds} termRunningIds={termRunningIds}
        sort={{
          groupKey: g.key,
          sectionId: g.sectionId,
          dragging: drag?.key === g.key,
          onPointerDown: (e) => bindHeader(e, g.key, g.sectionId),
          // 桌面右键 = 打开分组菜单。拖拽/长按途中不弹(isBusy),触屏长按已弹过同一个组也不重复弹
          // (长按后浏览器还会补一个 contextmenu);无论哪种情况都掐掉原生菜单
          onContextMenu: (e) => {
            e.preventDefault();
            if (isBusy() || groupMenu?.key === g.key) return;
            openGroupMenuAt(e.clientX, e.clientY, g, g.key, g.sectionId);
          },
          wasDragging
        }}
        onToggle={() => saveCollapsed(g.key, isExpanded(g.key))}
        onNewInGroup={() => newInGroup(g.newWs)}
        onSwitch={onSwitch}
        onMenu={openMenu}
        onMenuAt={openMenuAt} />
    ));

  return (
    <div className="panel s-panel">
      <div className="panel-title row" style={{ justifyContent: 'space-between' }}>
        <span>任务列表</span>
        <button className="sm" onClick={() => onNew()}>＋ 新建</button>
      </div>
      {scopeLabel && <div className="s-scope">📡 {scopeLabel}</div>}
      <div className={`s-list${drag ? ' reordering' : ''}`} ref={listRef}>
        {noTasks && <div className="muted" style={{ fontSize: 12 }}>暂无任务,点「＋ 新建」开始</div>}
        {remoteGroups.length > 0 && (
          <div className="s-section">
            <div className="s-section-title">远程任务列表</div>
            {renderGroup(remoteMeta, '🖥', (ws) => { if (onNewInWorkspace) onNewInWorkspace(ws, null); else onNew(); })}
          </div>
        )}
        {localGroups.length > 0 && (
          <div className="s-section">
            <div className="s-section-title">本地任务列表</div>
            {renderGroup(localMeta, '📂', (lws) => { if (onNewInWorkspace) onNewInWorkspace(null, lws); else onNew(); })}
          </div>
        )}
        {foreign.length > 0 && (
          <div className="s-foreign">
            <div className="s-foreign-title">其他服务器后台运行中</div>
            {foreign.map((s) => (
              <div key={s.id} className="session-item foreign" data-tip="该会话仍在原服务器后台运行"
                onClick={() => onSwitchForeign?.(s.id, s.connKey || '')}>
                {askPendingIds.includes(s.id)
                  ? <span className="s-run warn" data-tip="等待用户操作" />
                  : <span className="s-run" data-tip="任务进行中" />}
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

      {/* 分组菜单:右键分组头 / 触屏长按分组头打开,portal 到 body,与三点菜单同款悬浮厚玻璃 */}
      {groupMenu && createPortal(
        <div ref={groupMenuRef} className="ctxmenu" style={{ left: groupMenu.x, top: groupMenu.y }} onContextMenu={(e) => e.preventDefault()}>
          {/* 触屏专用入口:长按改弹菜单后,排序只能从这里起拖(桌面按住分组头即可拖,故用 CSS 隐藏本项) */}
          <button className="s-group-menu-reorder" onClick={doReorderGroup}>拖动排序</button>
          <button data-tip={revealTip} disabled={!!revealTip} onClick={doRevealGroup}>在资源管理器打开</button>
          <div className="ctx-sep" />
          <button className="danger"
            data-tip={groupBusy ? '有任务进行中,请先停止再删除' : undefined}
            disabled={groupBusy}
            onClick={doDeleteGroup}>删除分组(含 {groupMenu.ids.length} 个对话)</button>
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
