import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';
import type { ServerStatus, Session, SshProfileInfo } from './types';
import SshConnectModal from './components/SshConnectModal/SshConnectModal';
import SessionPanel from './components/SessionPanel/SessionPanel';
import WorkspacePanel from './components/WorkspacePanel/WorkspacePanel';
import ChatPanel, { NEW_SESSION_ID } from './components/ChatPanel/ChatPanel';
import ConsolePanel from './components/ConsolePanel/ConsolePanel';
import FileViewer, { mediaKindOf } from './components/FileViewer/FileViewer';
import SettingsPanel from './components/SettingsPanel/SettingsPanel';
import TooltipHost from './components/Tooltip/Tooltip';
import BottomBar, { type MobileView } from './components/BottomBar/BottomBar';
import { useIsPhone, useIsTablet, useIsDesktop } from './hooks/useMediaQuery';
import { useVisualViewportInset } from './hooks/useVisualViewport';
import { LlmProvider } from './context/llm-context';
import { useFeedback } from './context/feedback';
import './App.scss';

const STATUS_LABEL: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中…',
  reconnecting: '重连中…',
  disconnected: '未连接'
};

type TabKind = 'agent' | 'console' | 'file';
interface TabItem {
  id: string;
  kind: TabKind;
  name: string;
  path?: string;
  dirty?: boolean;
  /** 文件标签手动置顶:进入固定段不随滚动(命令台同款);最多 TAB_PIN_LIMIT 个 */
  pinnedFile?: boolean;
}
/** 文件标签可置顶的最大数量 */
const TAB_PIN_LIMIT = 3;
const PINNED_TABS: TabItem[] = [
  { id: 'agent', kind: 'agent', name: 'AI 编程助手' },
  { id: 'console', kind: 'console', name: '终端' }
];

// 手机底部标签栏的「伪标签」:文件管理(无文件打开时)与会话列表不是真实标签,
// 用两个哨兵 id 存进 activeTabId 以复用现有持久化(localStorage 'sshai.activeTab')。
// 哨兵值在桌面/平板端由 effActiveTabId 兜底为 agent,不会渲染空白。
const FILES_HOME_ID = 'files';
const SESSIONS_ID = 'sessions';

// 打开的文件标签持久化:刷新页面后恢复之前打开的文件(固定页不存)。
// 只存 {id, kind, name, path},dirty 不存——刷新后内容重新加载,未保存修改自然丢弃。
const FILE_TABS_KEY = 'sshai.fileTabs';
const ACTIVE_TAB_KEY = 'sshai.activeTab';

function loadSavedFileTabs(): TabItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FILE_TABS_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((t) => t && t.kind === 'file' && typeof t.id === 'string' && typeof t.name === 'string')
      .map((t) => ({ id: t.id, kind: 'file' as const, name: t.name, path: typeof t.path === 'string' ? t.path : t.id, dirty: false, pinnedFile: !!t.pinnedFile }));
  } catch { return []; }
}

function loadSavedActiveTab(): string {
  try { return localStorage.getItem(ACTIVE_TAB_KEY) || 'agent'; }
  catch { return 'agent'; }
}

// 文件标签图标按媒体类型区分,普通文件仍用 📄
function tabIcon(name: string): string {
  switch (mediaKindOf(name)) {
    case 'image': return '🖼️';
    case 'video': return '🎬';
    case 'audio': return '🎵';
    case 'pdf': return '📕';
    default: return '📄';
  }
}

// 本地面板起点:真实家目录来自服务端 status 事件(localHome = os.homedir())
export default function App() {
  const { confirm, toast } = useFeedback();
  const [status, setStatus] = useState<ServerStatus>({
    status: 'disconnected', host: null, port: null, username: null,
    platform: null, home: null, workspace: null, localWorkspace: null, localHome: null, agentBusy: false, busySessions: [], llmModel: null
  });
  const [tabs, setTabs] = useState<TabItem[]>(() => [...PINNED_TABS, ...loadSavedFileTabs()]);
  const [activeTabId, setActiveTabId] = useState(loadSavedActiveTab);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragTabIdRef = useRef<string | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  // 文件标签持久化:标签列表/激活标签变化即写入 localStorage(固定页不存);
  // 恢复时若保存的激活标签已不存在(如远程标签被连接切换清理),回退到最后一个标签
  useEffect(() => {
    try {
      const files = tabs
        .filter((t) => t.kind === 'file')
        .map((t) => ({ id: t.id, kind: t.kind, name: t.name, path: t.path, pinnedFile: !!t.pinnedFile }));
      localStorage.setItem(FILE_TABS_KEY, JSON.stringify(files));
    } catch {}
    setActiveTabId((cur) => (tabs.some((t) => t.id === cur) ? cur
      : (cur === SESSIONS_ID || cur === FILES_HOME_ID ? cur : tabs[tabs.length - 1]?.id || 'agent')));
  }, [tabs]);
  useEffect(() => {
    try { localStorage.setItem(ACTIVE_TAB_KEY, activeTabId); } catch {}
  }, [activeTabId]);
  const [localCwd, setLocalCwd] = useState('');   // 本地面板当前目录
  const [remoteCwd, setRemoteCwd] = useState(''); // 远程面板当前目录
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sshOpen, setSshOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [leftWidth, setLeftWidth] = useState(320);
  const leftRef = useRef<HTMLElement>(null);

  // ---- 响应式断点(与 App.scss/styles.scss 的 @media 数值一一对应) ----
  // <768 手机(底部 Tab 单栏)/ 768-1279 平板(侧栏抽屉化)/ ≥1280 桌面(三栏原样)
  const isPhone = useIsPhone();
  const isTablet = useIsTablet();
  const isDesktop = useIsDesktop();
  // 虚拟键盘遮挡高度(仅 phone 生效):键盘弹出时把 .app 底部顶上去,输入区不被遮挡
  const vkInset = useVisualViewportInset();
  // 平板抽屉:默认收起(桌面仍用 leftOpen;手机不渲染侧栏,此状态无意义但保持无害)
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 手机当前视图:由 activeTabId 推导(files 视图 = 文件管理或正在查看的文件)
  const mobileView: MobileView =
    activeTabId === SESSIONS_ID ? 'sessions'
    : activeTabId === FILES_HOME_ID || tabs.some((t) => t.kind === 'file' && t.id === activeTabId) ? 'files'
    : activeTabId === 'agent' ? 'agent' : 'console';
  // 桌面/平板不允许停留在哨兵视图(窗口从手机放大到更大尺寸时兜底回 agent)
  const effActiveTabId = (isDesktop || isTablet) && (activeTabId === SESSIONS_ID || activeTabId === FILES_HOME_ID)
    ? 'agent' : activeTabId;

  // 手机底部栏回调:选择视图。files 视图「有打开的文件回到上次查看的那个,
  // 否则进文件管理」(浏览器式标签语义);agent/console/sessions 直接切到对应视图
  const selectMobileView = (v: MobileView) => {
    if (v === 'agent' || v === 'console' || v === 'sessions') { setActiveTabId(v); return; }
    const files = tabsRef.current.filter((t) => t.kind === 'file');
    const activeFile = files.find((t) => t.id === activeTabId);
    setActiveTabId(activeFile ? activeFile.id : (files[files.length - 1]?.id ?? FILES_HOME_ID));
  };

  // 左侧边栏拖拽调整宽度
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = leftRef.current?.offsetWidth || 320;
    const onMove = (ev: PointerEvent) => {
      const w = Math.min(Math.max(startW + ev.clientX - startX, 220), window.innerWidth * 0.6);
      setLeftWidth(w);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  // ---- 侧栏上下分栏:历史会话区占比(0~1),localStorage 持久化,拖动分隔条实时更新 ----
  const SPLIT_KEY = 'sshai.sideSplit';
  const loadSideRatio = (): number => {
    try {
      const v = Number(localStorage.getItem(SPLIT_KEY));
      if (Number.isFinite(v) && v > 0 && v < 1) return v;
    } catch { /* 存储不可用时用默认值 */ }
    return 0.42;
  };
  const [sideRatio, setSideRatio] = useState(loadSideRatio);
  const sideRatioRef = useRef(sideRatio);
  useEffect(() => { sideRatioRef.current = sideRatio; }, [sideRatio]);
  const startSideSplit = (e: React.PointerEvent) => {
    e.preventDefault();
    const rect = leftRef.current?.getBoundingClientRect();
    if (!rect) return;
    const onMove = (ev: PointerEvent) => {
      const r = Math.min(Math.max((ev.clientY - rect.top) / rect.height, 0.18), 0.82);
      sideRatioRef.current = r;
      setSideRatio(r);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.classList.remove('splitting');
      try { localStorage.setItem(SPLIT_KEY, String(sideRatioRef.current)); } catch { /* 存储不可用忽略 */ }
    };
    document.body.classList.add('splitting');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  // ---- 历史会话状态 ----
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionSeq, setSessionSeq] = useState(0); // 会话切换/新建后自增,触发 ChatPanel 重载
  // 模型提问挂起的会话集合(ask_user_question):会话在后台提问、用户不在当前会话时,
  // 会话列表的运行点显示为黄色"待用户操作";切回后提问面板展示并可作答。
  // 完全由 agent 事件驱动(ask_user 加入 / ask_user_cancelled 移除),与服务端挂起提问一致
  const [pendingAskIds, setPendingAskIds] = useState<string[]>([]);
  // 新建会话草稿态:点击「新建」时先不创建服务端会话(sid=占位符),输入内容按固定键缓存;
  // 发送首条消息时由 ChatPanel 真正 session_create 并通过 onSessionCreated 回调刷新。
  const pendingNewRef = useRef(false);

  // 会话操作版本:每次「主动会话操作」(新建/切换/分支/草稿态建会话成功/删除)自增。
  // 异步 session_list 响应在其发起后若版本已变化,说明期间用户已做了更新的会话操作,
  // 该响应就是过期快照,丢弃以免把前端视图覆盖回旧会话,导致前端 sid 与后端活跃
  // 会话失步(后果:发送的消息进后端活跃会话,但事件按 sid 路由被前端过滤,界面无反应)。
  const opRef = useRef(0);
  const bumpOp = () => { opRef.current += 1; };

  const refreshFrom = (r: any) => {
    setSessions(r.sessions || []);
    setActiveSessionId(r.active ?? null);
  };

  // 会话按服务器/本地模式隔离:活动连接(或连接状态)变化时,重新拉取当前作用域的会话列表
  const scopeKey = status.status === 'connected' && status.host
    ? `${status.username}@${status.host}:${status.port || 22}`
    : status.status === 'disconnected' ? 'local' : null;
  const prevScopeRef = useRef('local'); // 初始为本地模式,避免挂载时重复拉取
  useEffect(() => {
    if (!scopeKey || scopeKey === prevScopeRef.current) return;
    prevScopeRef.current = scopeKey;
    const my = opRef.current; // 记录发起时版本:期间用户新建/切换了会话则丢弃过期快照
    api.request('session_list', {}, 8000)
      .then((r) => {
        if (opRef.current !== my) return;
        setSessions(r.sessions || []);
        if (!pendingNewRef.current) setActiveSessionId(r.active || null);
        setSessionSeq((n) => n + 1);
      })
      .catch(() => {});
  }, [scopeKey]);

  // 当前作用域标签(左上角会话面板标题提示用)
  const scopeLabel = status.status === 'connected' && status.host ? `${status.username}@${status.host}` : '本地工作区';

  // 初始化拉取会话列表;并按服务端推送的 sessions 快照刷新(新消息/清空后 msgCount 与时间变化)
  useEffect(() => {
    const my = opRef.current; // 初始快照:用户若在响应到达前新建/切换了会话,则丢弃过期结果
    api.request('session_list', {}, 8000)
      .then((r) => {
        if (opRef.current !== my) return;
        setSessions(r.sessions || []);
        if (!pendingNewRef.current) setActiveSessionId(r.active || null);
      })
      .catch(() => {});
    const off = api.on('sessions', (m: any) => {
      setSessions(m.sessions || []);
      // 新会话草稿态(尚未创建服务端会话):忽略服务端推送的 active,避免被拉回旧会话
      if (!pendingNewRef.current) setActiveSessionId(m.active ?? null);
    });
    // 后台会话任务结束时也会推送 sessions_changed:静默刷新列表,不打扰当前聊天视图
    const offChanged = api.on('agent', (m: any) => {
      if (m.event !== 'sessions_changed') return;
      const my = opRef.current;
      api.request('session_list', {}, 8000)
        .then((r) => {
          if (opRef.current !== my) return;
          setSessions(r.sessions || []);
          if (!pendingNewRef.current) setActiveSessionId(r.active ?? null);
        })
        .catch(() => {});
    });
    // 全局跟踪"有待作答提问"的会话(不按当前会话过滤):会话在后台提问时,
    // 会话列表的运行点由绿变黄提示等待用户操作;作答/取消/超时统一走 ask_user_cancelled 移除
    const offAsk = api.on('agent', (m: any) => {
      if (!m || typeof m.event !== 'string') return;
      if (m.event === 'ask_user' && m.sid) {
        setPendingAskIds((prev) => (prev.includes(m.sid) ? prev : [...prev, m.sid]));
      } else if (m.event === 'ask_user_cancelled' && m.sid) {
        setPendingAskIds((prev) => (prev.length ? prev.filter((x) => x !== m.sid) : prev));
      }
    });
    // 后端重启/WS 断线重连后:后端会话状态(列表/活跃会话)已按磁盘恢复,与前端内存可能脱节。
    // 重连成功后重新拉取对齐;期间用户已新建/切换过会话(草稿态)则保持不动,避免打断当前操作。
    const offOpen = api.on('open', () => {
      const my = opRef.current;
      api.request('session_list', {}, 8000)
        .then((r) => {
          if (opRef.current !== my) return;
          setSessions(r.sessions || []);
          if (!pendingNewRef.current) setActiveSessionId(r.active ?? null);
        })
        .catch(() => {});
    });
    // RPC 同步错误(如 speak 因 LLM 未配置/未选工作区被拒)无 reqId,默认无人处理会静默
    // 成"发送没反应",这里显式 toast,让失败原因可见
    const offErr = api.on('server_error', (m: any) => {
      toast.error(m?.error || '服务器错误');
    });
    return () => { off(); offChanged(); offAsk(); offOpen(); offErr(); };
  }, []);

  const refreshSessions = (r: any, opts?: { forceActive?: boolean }) => {
    setSessions(r.sessions || []);
    if (opts?.forceActive || !pendingNewRef.current) setActiveSessionId(r.active ?? null);
    setSessionSeq((n) => n + 1);
  };
  // 新建会话:进入"新会话草稿态"(sid=占位符,不创建服务端会话、不进入历史列表)。
  // 输入内容按固定键缓存;只有发送首条消息(ChatPanel 内 session_create)后才真正创建并显示到历史列表。
  const newSession = () => {
    bumpOp(); // 使在飞 session_list 快照失效,防止旧响应覆盖切回旧会话
    pendingNewRef.current = true;
    setActiveSessionId(NEW_SESSION_ID);
    setSessionSeq((n) => n + 1);
  };
  // 切换会话(点击当前会话也会重新触发 session_switch + 重载,用于加载失败/进行中时重试)
  const switchSession = (id: string) => {
    bumpOp();
    pendingNewRef.current = false;
    api.request('session_switch', { id }, 8000).then(refreshSessions).catch((e) => toast.error(`切换会话失败: ${(e as Error).message}`));
  };
  // 点击其他服务器后台运行的会话:先切回该服务器(conn_switch),再打开该会话。
  // connKey = 服务端作用域键(username@host:port 或 'local');'local' 需断开连接才可达,直接忽略
  const switchForeignSession = (id: string, connKey: string) => {
    if (connKey === scopeKey) { switchSession(id); return; }
    if (connKey === 'local') return;
    bumpOp();
    pendingNewRef.current = false;
    const conn = (status.conns || []).find((c) => `${c.username}@${c.host}:${c.port || 22}` === connKey && c.status === 'connected');
    if (!conn) return;
    api.request('conn_switch', { id: conn.id }, 8000)
      .then(() => api.request('session_switch', { id }, 8000))
      .then(refreshSessions)
      .catch((e) => toast.error(`切换会话失败: ${(e as Error).message}`));
  };
  // 在新对话中分支:克隆当前会话为新会话并切换。at 为 turns 索引时截断到该条消息
  // (用于从任意历史消息处分支),缺省 -1 从尾部整体克隆
  const forkSession = (at = -1) => {
    bumpOp();
    pendingNewRef.current = false;
    api.request('session_fork', { at }, 8000).then(refreshSessions).catch(() => {});
  };
  const renameSession = (id: string, title: string) => api.request('session_rename', { id, title }, 8000).then(refreshSessions).catch(() => {});
  // 新会话草稿态发送首条消息:ChatPanel 创建服务端会话成功后回调,把会话列入历史列表并激活
  const handleSessionCreated = (r: any) => {
    bumpOp();
    pendingNewRef.current = false;
    refreshSessions(r, { forceActive: true });
  };
  const deleteSession = async (id: string) => {
    if (id === activeSessionId) return;
    const ok = await confirm({
      title: '删除会话',
      message: '删除该会话?其对话记录将被永久删除,不可恢复',
      confirmLabel: '删除',
      danger: true
    });
    if (!ok) return;
    bumpOp();
    api.request('session_delete', { id }, 8000).then(refreshSessions).catch(() => {});
  };

  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    api.connect();
    const offStatus = api.on('status', setStatus);
    return () => { offStatus(); api.close(); };
  }, []);

  // 活动连接变化(切换/断开)后,远程文件标签页已不属于当前服务器:
  // 立即关闭,避免看到旧服务器内容或将编辑误保存到新服务器(本地文件标签不受影响)。
  // 首次状态快照(页面加载/刷新后收到第一条 status)不触发清理——
  // 否则刷新时若已连上服务器,恢复的远程文件标签会被当成"连接切换"误删。
  const prevActiveRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const next = status.activeConn ?? null;
    if (prevActiveRef.current === next) return;
    const first = prevActiveRef.current === undefined;
    prevActiveRef.current = next;
    if (first) return;
    const cur = tabsRef.current;
    const kept = cur.filter((t) => t.kind !== 'file' || (t.path || '').startsWith('local:'));
    if (kept.length === cur.length) return;
    setTabs(kept);
    setActiveTabId((a) => (kept.some((t) => t.id === a) ? a
      : (a === SESSIONS_ID || a === FILES_HOME_ID ? a : kept[kept.length - 1]?.id || 'agent')));
  }, [status.activeConn]);

  const connected = status.status === 'connected';
  // 多连接池:统计当前在线连接数(含活动连接),用于顶栏提示「可快速切换」
  const connCount = (status.conns || []).filter((c) => c.status === 'connected').length;
  const multiConn = connCount > 1;

  // 已保存的 SSH 配置:顶栏连接信息显示「配置名称 · IP」,连接切换/弹窗关闭后刷新
  const [profiles, setProfiles] = useState<SshProfileInfo[]>([]);
  useEffect(() => {
    api.request('ssh_profiles_list', {}, 8000)
      .then((m) => setProfiles(m.profiles || []))
      .catch(() => {});
  }, [status.activeConn, sshOpen]);

  // 活动连接对应的已保存配置(按配置 id 或 host/port/user 兜底匹配),用于顶栏显示服务器名称
  const activeProfile = useMemo(() => {
    const c = (status.conns || []).find((x) => x.id === status.activeConn);
    if (c) {
      return profiles.find((p) => p.id === c.profileId
        || (c.host === p.host && String(c.port) === String(p.port || '22') && c.username === p.username)) || null;
    }
    if (!status.host) return null;
    return profiles.find((p) => status.host === p.host
      && String(status.port || '22') === String(p.port || '22')
      && status.username === p.username) || null;
  }, [profiles, status.activeConn, status.conns, status.host, status.port, status.username]);
  // 多会话并行:busySessions 是运行中的会话集合;聊天区只关心"当前活跃会话"是否在运行
  const busySessions = status.busySessions || [];
  const activeBusy = activeSessionId != null && busySessions.includes(activeSessionId);

  // ---- 浏览器式标签页:打开文件 = 在固定页右侧追加标签(已存在则仅激活) ----
  // 文件标签面板常驻挂载,切走仅 CSS 隐藏,未保存修改不丢失
  const openFileTab = (path: string, name: string) => {
    setTabs((prev) => (prev.some((t) => t.id === path)
      ? prev
      : [...prev, { id: path, kind: 'file' as const, name, path, dirty: false }]));
    setActiveTabId(path);
  };

  const handleOpenFile = (path: string) => {
    openFileTab(path, path.split('/').filter(Boolean).pop() || path);
  };

  // 本地文件用 local: 前缀区分,FileViewer 内按前缀分流读取/保存
  const handleOpenLocalFile = (path: string) => {
    openFileTab(`local:${path}`, path.split(/[\\/]/).filter(Boolean).pop() || path);
  };

  const updateTabDirty = (id: string, dirty: boolean) => {
    setTabs((prev) => {
      const cur = prev.find((t) => t.id === id);
      if (!cur || cur.dirty === dirty) return prev;
      return prev.map((t) => (t.id === id ? { ...t, dirty } : t));
    });
  };

  // 关闭文件标签:有未保存修改先确认;关闭后激活相邻标签(优先右侧),固定页不可关
  const closeTab = async (id: string) => {
    const t = tabsRef.current.find((x) => x.id === id);
    if (!t || t.kind !== 'file') return;
    if (t.dirty) {
      const ok = await confirm({
        title: '关闭标签',
        message: `「${t.name}」有未保存的修改,关闭后将丢失,确定关闭?`,
        confirmLabel: '丢弃并关闭',
        danger: true
      });
      if (!ok) return;
    }
    const idx = tabsRef.current.findIndex((x) => x.id === id);
    const next = tabsRef.current.filter((x) => x.id !== id);
    setTabs(next);
    setActiveTabId((cur) => {
      if (cur !== id) return cur;
      const nb = next[idx] || next[idx - 1];
      // 手机端关闭最后一个文件后回到文件管理(桌面维持回 AI 助手)
      if (nb) return nb.id;
      return isPhone ? FILES_HOME_ID : 'agent';
    });
  };

  // 标签拖拽排序(仅文件页):按指针处于目标标签左/右半侧决定插入位,
  // 插入下标始终钳制在固定页数量之后,保证固定页永远排最前
  const onTabDragStart = (e: React.DragEvent, id: string) => {
    dragTabIdRef.current = id;
    setDraggingId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };
  const onTabDragOver = (e: React.DragEvent, overId: string) => {
    const dragId = dragTabIdRef.current;
    if (!dragId || dragId === overId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const insertBefore = e.clientX < rect.left + rect.width / 2;
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.id === dragId);
      const to = prev.findIndex((t) => t.id === overId);
      if (from < 0 || to < 0) return prev;
      let at = insertBefore ? to : to + 1;
      if (at > from) at -= 1; // 先移除拖动项,再换算成新数组里的插入下标
      at = Math.max(prev.filter((t) => t.kind !== 'file').length, at);
      if (at === from) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(at, 0, moved);
      return next;
    });
  };
  const onTabDragEnd = () => { dragTabIdRef.current = null; setDraggingId(null); };

  // ---- 标签右键菜单:置顶/取消置顶 + 关闭全部/关闭当前(文件标签) ----
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tab: TabItem } | null>(null);
  const tabMenuRef = useRef<HTMLDivElement>(null);
  const openTabMenu = (e: React.MouseEvent, tab: TabItem) => {
    e.preventDefault();
    e.stopPropagation();
    setTabMenu({
      x: Math.max(0, Math.min(e.clientX, window.innerWidth - 190 - 8)),
      y: Math.max(0, Math.min(e.clientY, window.innerHeight - 170 - 8)),
      tab
    });
  };
  useEffect(() => {
    if (!tabMenu) return;
    const closeMenu = () => setTabMenu(null);
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (tabMenuRef.current && tabMenuRef.current.contains(t)) return;
      setTabMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTabMenu(null); };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [tabMenu]);

  // 当前已置顶的文件标签数(上限 TAB_PIN_LIMIT)
  const pinnedFileCount = tabs.filter((t) => t.kind === 'file' && t.pinnedFile).length;

  // 置顶/取消置顶文件标签
  const togglePinTab = (id: string) => {
    setTabs((prev) => {
      const t = prev.find((x) => x.id === id);
      if (t?.kind !== 'file') return prev;
      if (!t.pinnedFile && prev.filter((x) => x.kind === 'file' && x.pinnedFile).length >= TAB_PIN_LIMIT) return prev;
      return prev.map((x) => (x.id === id ? { ...x, pinnedFile: !x.pinnedFile } : x));
    });
    setTabMenu(null);
  };

  // 关闭全部文件标签:有未保存修改先统一确认一次
  const closeAllTabs = async () => {
    const dirtyFiles = tabs.filter((t) => t.kind === 'file' && t.dirty);
    if (dirtyFiles.length > 0) {
      const ok = await confirm({
        title: '关闭全部标签',
        message: `有 ${dirtyFiles.length} 个标签存在未保存的修改,全部关闭后将丢失,确定关闭?`,
        confirmLabel: '全部关闭',
        danger: true
      });
      if (!ok) { setTabMenu(null); return; }
    }
    setTabs((prev) => prev.filter((t) => t.kind !== 'file'));
    setActiveTabId((cur) => (cur !== 'agent' && cur !== 'console' ? (isPhone ? FILES_HOME_ID : 'agent') : cur));
    setTabMenu(null);
  };

  // 关闭除指定标签外的其它文件标签(右键选中的标签保留):有未保存修改先统一确认一次
  const closeOtherTabs = async (keepId: string) => {
    const dirtyFiles = tabs.filter((t) => t.kind === 'file' && t.dirty && t.id !== keepId);
    if (dirtyFiles.length > 0) {
      const ok = await confirm({
        title: '关闭其它标签',
        message: `有 ${dirtyFiles.length} 个标签存在未保存的修改,关闭后将丢失,确定关闭?`,
        confirmLabel: '全部关闭',
        danger: true
      });
      if (!ok) { setTabMenu(null); return; }
    }
    setTabs((prev) => prev.filter((t) => t.kind !== 'file' || t.id === keepId));
    // 若当前激活的是被关闭的标签,切到保留的标签;固定页/保留标签保持不变
    setActiveTabId((cur) => (cur === keepId || cur === 'agent' || cur === 'console' ? cur : keepId));
    setTabMenu(null);
  };

  // 单个标签渲染(固定页/文件页共用;固定页不可拖、无关闭钮;置顶文件不可拖但有关闭钮)
  const renderTab = (t: TabItem) => {
    const fixed = t.kind !== 'file';          // 内置固定页(AI 助手/命令台)
    const pinned = fixed || !!t.pinnedFile;   // 不参与滚动:pinned 区
    return (
      <div
        key={t.id}
        data-tab-id={t.id}
        className={`btab${activeTabId === t.id ? ' active' : ''}${pinned ? ' pinned' : ''}${draggingId === t.id ? ' dragging' : ''}${t.dirty ? ' dirty' : ''}`}
        draggable={!pinned}
        title={t.kind === 'file' ? t.path : `${t.name}(固定标签)`}
        onDragStart={(e) => onTabDragStart(e, t.id)}
        onDragOver={(e) => onTabDragOver(e, t.id)}
        onDragEnd={onTabDragEnd}
        onDrop={(e) => e.preventDefault()}
        onClick={() => setActiveTabId(t.id)}
        onAuxClick={(e) => { if (e.button === 1) closeTab(t.id); }}
        onContextMenu={(e) => { if (t.kind === 'file') openTabMenu(e, t); }}
      >
        <span className="btab-icon">{t.kind === 'agent' ? '💬' : t.kind === 'console' ? '⌨️' : tabIcon(t.name)}</span>
        <span className="btab-label">{t.name}</span>
        {!fixed && (
          <button
            className="btab-close"
            title={t.dirty ? '有未保存修改' : '关闭标签'}
            onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
          >
            {t.dirty ? '●' : '✕'}
          </button>
        )}
      </div>
    );
  };

  // 标签条溢出时滚轮横向滚动:直接用 React 合成 onWheel(挂在滚动容器上,
  // 不依赖 useEffect/ref 时序,只要组件渲染必然生效);当前布局为 100vh 无
  // 页面纵向滚动,passive 限制(不能 preventDefault)不影响功能
  const onStripWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth + 1) return;
    el.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  };

  // 激活标签自动滚入可视区(打开新标签/切换时)
  useEffect(() => {
    stripRef.current
      ?.querySelector(`[data-tab-id="${CSS.escape(activeTabId)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length]);

  // ---- 按服务器保存的工作区历史:key = "host:port",每个服务器记住添加/打开过的工作区 ----
  const WS_KEY = 'sshai.wsByHost';
  const loadWsByHost = (): Record<string, string[]> => {
    try {
      const o = JSON.parse(localStorage.getItem(WS_KEY) || '{}');
      return o && typeof o === 'object' ? o : {};
    } catch { return {}; }
  };
  const saveWsByHost = (m: Record<string, string[]>) => localStorage.setItem(WS_KEY, JSON.stringify(m));
  const [wsByHost, setWsByHost] = useState<Record<string, string[]>>(loadWsByHost);

  // ---- 本机保存的本地工作区历史(跨服务器全局,最近使用的排最前),与远程历史对称 ----
  const LOCAL_WS_KEY = 'sshai.localWorkspaces';
  const loadLocalWs = (): string[] => {
    try {
      const a = JSON.parse(localStorage.getItem(LOCAL_WS_KEY) || '[]');
      return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
    } catch { return []; }
  };
  const saveLocalWs = (list: string[]) => localStorage.setItem(LOCAL_WS_KEY, JSON.stringify(list));
  const [localWs, setLocalWs] = useState<string[]>(loadLocalWs);

  // 选择本地工作区:通知服务端切换,记录到历史,并在状态里记住
  const onSetLocalWorkspace = (p: string) =>
    api.request('set_local_workspace', { path: p }, 20000)
      .then(() => {
        setStatus((s) => ({ ...s, localWorkspace: p }));
        setLocalWs((m) => {
          const cur = m || [];
          // 保持原顺序:已存在则原位不动,新路径追加到末尾(不再"最近用的排最前",避免切换乱序)
          const next = cur.includes(p) ? cur : [...cur, p];
          saveLocalWs(next);
          return next;
        });
      })
      .catch(() => {});

  const onWorkspaceSet = (ws: string) => {
    setStatus((s) => ({ ...s, workspace: ws }));
    // 记录到当前服务器的历史,方便下次连接该服务器时直接切换
    const st = statusRef.current;
    const key = st.host ? `${st.host}:${st.port || 22}` : '';
    if (!key) return;
    setWsByHost((m) => {
      const cur = m[key] || [];
      // 保持原顺序:已存在则原位不动,新路径追加到末尾(不再"最近用的排最前",避免切换乱序)
      const next = cur.includes(ws) ? cur : [...cur, ws];
      const obj = { ...m, [key]: next };
      saveWsByHost(obj);
      return obj;
    });
  };

  // 从当前服务器的工作区历史中删除一条记录(仅删快捷记录,不影响远程目录)
  const onDeleteWs = (ws: string) => {
    const st = statusRef.current;
    const key = st.host ? `${st.host}:${st.port || 22}` : '';
    if (!key) return;
    setWsByHost((m) => {
      const list = (m[key] || []).filter((x) => x !== ws);
      const next = { ...m, [key]: list };
      saveWsByHost(next);
      return next;
    });
  };

  // 从本地工作区历史中删除一条记录
  const onDeleteLocalWs = (p: string) => {
    setLocalWs((m) => {
      const next = (m || []).filter((x) => x !== p);
      saveLocalWs(next);
      return next;
    });
  };

  return (
    <LlmProvider>
    <div className="app" style={isPhone && vkInset > 0 ? { paddingBottom: vkInset } : undefined}>
      <header className="topbar">
        <div className="topbar-left">
          {/* 手机:导航由底部栏承担,隐藏侧栏开关钮;平板:☰ 开抽屉;桌面:◀/▶ 收起侧栏 */}
          {isPhone ? null : (
            <button className="ghost edge-toggle" data-tip={isTablet ? '展开左侧栏' : (leftOpen ? '收起左侧栏' : '展开左侧栏')}
              onClick={() => (isTablet ? setDrawerOpen((v) => !v) : setLeftOpen((v) => !v))}>
              {isTablet ? '☰' : (leftOpen ? '◀' : '▶')}
            </button>
          )}
          <div className="brand"><img className="brand-logo" src="/logo-64.png" alt="" /> Teleforge</div>
        </div>
        <div className="topbar-right">
          <button
            className={`conn-chip ${connected ? 'ok' : status.status === 'disconnected' ? 'off' : 'warn'}`}
            onClick={() => setSshOpen(true)}
          >
            {connected
              ? `● 已连接 ${activeProfile?.name ? `${activeProfile.name} · ${status.host}` : status.host}${multiConn ? ` · 在线${connCount}台(点开可切换)` : ''}`
              : status.status === 'disconnected'
                ? '● 未连接 · 点击 SSH 连接'
                : `● ${STATUS_LABEL[status.status] || status.status}`}
          </button>
          <button className="ghost edge-toggle settings-btn" onClick={() => setSettingsOpen(true)}>⚙</button>
        </div>
      </header>

      <div className="layout">
        {/* 侧栏:桌面=常驻三栏;平板=覆盖式抽屉(☰ 开、遮罩关);手机=不渲染,内容由底部栏视图承载 */}
        {!isPhone && (
          <>
          <aside ref={leftRef}
            style={isTablet ? undefined : { width: leftWidth }}
            className={`sidebar sidebar-left${isTablet ? (drawerOpen ? ' drawer-open' : ' drawer') : (leftOpen ? '' : ' hidden')}`}>
            {!isTablet && <div className="resizer" onPointerDown={startResize} />}
            <div className="side-top" style={{ flexBasis: `${sideRatio * 100}%` }}>
              <SessionPanel
                sessions={sessions}
                activeId={activeSessionId}
                busyIds={busySessions}
                askPendingIds={pendingAskIds}
                scopeLabel={scopeLabel}
                scopeKey={scopeKey}
                onNew={newSession}
                onSwitch={(id) => { switchSession(id); setDrawerOpen(false); }}
                onSwitchForeign={(id, key) => { switchForeignSession(id, key); setDrawerOpen(false); }}
                onRename={renameSession}
                onDelete={deleteSession}
              />
            </div>
            <div className="side-divider" onPointerDown={startSideSplit} />
            <div className="side-bottom">
              <WorkspacePanel
                connected={connected}
                workspace={status.workspace}
                home={status.home}
                connId={status.activeConn ?? null}
                localWorkspace={status.localWorkspace}
                localHome={status.localHome}
                localCwd={localCwd}
                remoteCwd={remoteCwd}
                onLocalCwdChange={setLocalCwd}
                onRemoteCwdChange={setRemoteCwd}
                onOpenFile={(p) => { handleOpenFile(p); setDrawerOpen(false); }}
                onOpenLocalFile={(p) => { handleOpenLocalFile(p); setDrawerOpen(false); }}
              />
            </div>
          </aside>
          {isTablet && drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
          </>
        )}

        <main className="main">
          <div
            className="tabstrip"
            onDragOver={(e) => { if (dragTabIdRef.current) e.preventDefault(); }}
            onDrop={(e) => e.preventDefault()}
          >
            {/* 固定段:AI 编程助手/命令台永远显示;置顶的文件标签同样固定于此,不受文件标签滚动影响 */}
            <div className="tabstrip-pinned">
              {tabs.filter((t) => t.kind !== 'file' || t.pinnedFile).map(renderTab)}
            </div>
            {/* 滚动段:普通文件标签可横向滚动(滚轮/拖拽到边缘);用项目悬浮滚动条引擎(不占布局,高度不变)。
               手机端 pinned 段被 CSS 隐藏(见 App.scss),置顶文件也放滚动段保证可见 */}
            <div className="tabstrip-scroll" ref={stripRef} onWheel={onStripWheel}>
              {tabs.filter((t) => t.kind === 'file' && (!t.pinnedFile || isPhone)).map(renderTab)}
            </div>
          </div>
          {tabMenu && createPortal(
            <div
              ref={tabMenuRef}
              className="ctxmenu"
              style={{ left: tabMenu.x, top: tabMenu.y }}
              onContextMenu={(e) => e.preventDefault()}
            >
              {tabMenu.tab.pinnedFile ? (
                <button onClick={() => togglePinTab(tabMenu.tab.id)}><span className="ctx-ico">📌</span>取消置顶</button>
              ) : (
                <button
                  disabled={pinnedFileCount >= TAB_PIN_LIMIT}
                  data-tip={pinnedFileCount >= TAB_PIN_LIMIT ? `最多置顶 ${TAB_PIN_LIMIT} 个标签` : '置顶后固定在顶部,不随标签滚动'}
                  onClick={() => togglePinTab(tabMenu.tab.id)}
                >
                  <span className="ctx-ico">📌</span>置顶标签
                </button>
              )}
              <div className="ctx-sep" />
              <button onClick={() => { closeTab(tabMenu.tab.id); setTabMenu(null); }}><span className="ctx-ico">✕</span>关闭当前标签</button>
              <button
                disabled={tabs.filter((t) => t.kind === 'file' && t.id !== tabMenu.tab.id).length === 0}
                onClick={() => void closeOtherTabs(tabMenu.tab.id)}
              ><span className="ctx-ico">🗂</span>关闭其它标签</button>
              <button className="danger" onClick={() => void closeAllTabs()}><span className="ctx-ico">🗑</span>关闭全部标签</button>
            </div>,
            document.body
          )}
          <div className="tab-body">
            {/* ChatPanel 常驻挂载:切走仅 CSS 隐藏(对齐终端/文件面板),手机端底部栏频繁切换不重载会话历史 */}
            <div className={`tab-pane ${effActiveTabId === 'agent' ? '' : 'hide'}`}>
              <ChatPanel connected={connected} workspace={status.workspace} localWorkspace={status.localWorkspace} remoteCwd={remoteCwd} localCwd={localCwd} busy={activeBusy} sid={activeSessionId} sessionSeq={sessionSeq}
              home={status.home} savedWs={wsByHost[status.host ? `${status.host}:${status.port || 22}` : ''] || []}
              localHome={status.localHome} savedLocalWs={localWs}
              onWorkspaceSet={onWorkspaceSet} onLocalWorkspaceSet={onSetLocalWorkspace}
              onDeleteWs={onDeleteWs} onDeleteLocalWs={onDeleteLocalWs} onFork={forkSession}
              onSessionCreated={handleSessionCreated} />
            </div>
            {/* 终端常驻挂载:切走再切回不销毁会话,用 CSS 隐藏 */}
            <div className={`tab-pane ${effActiveTabId === 'console' ? '' : 'hide'}`}>
              <ConsolePanel connected={connected} visible={effActiveTabId === 'console'} activeConn={status.activeConn ?? null} hostIp={status.host} />
            </div>
            {/* 手机:会话列表(底部栏「🗂 会话」) */}
            {isPhone && mobileView === 'sessions' && (
              <div className="tab-pane mobile-pane">
                <SessionPanel
                  sessions={sessions}
                  activeId={activeSessionId}
                  busyIds={busySessions}
                  askPendingIds={pendingAskIds}
                  scopeLabel={scopeLabel}
                  scopeKey={scopeKey}
                  onNew={() => { newSession(); setActiveTabId('agent'); }}
                  onSwitch={(id) => { switchSession(id); setActiveTabId('agent'); }}
                  onSwitchForeign={(id, key) => { switchForeignSession(id, key); setActiveTabId('agent'); }}
                  onRename={renameSession}
                  onDelete={deleteSession}
                />
              </div>
            )}
            {/* 手机:文件管理(底部栏「📁 文件」且无文件打开时);打开文件后由文件标签页接管 */}
            {isPhone && mobileView === 'files' && effActiveTabId === FILES_HOME_ID && (
              <div className="tab-pane mobile-pane">
                <WorkspacePanel
                  connected={connected}
                  workspace={status.workspace}
                  home={status.home}
                  connId={status.activeConn ?? null}
                  localWorkspace={status.localWorkspace}
                  localHome={status.localHome}
                  localCwd={localCwd}
                  remoteCwd={remoteCwd}
                  onLocalCwdChange={setLocalCwd}
                  onRemoteCwdChange={setRemoteCwd}
                  onOpenFile={handleOpenFile}
                  onOpenLocalFile={handleOpenLocalFile}
                />
              </div>
            )}
            {/* 文件标签页同样常驻挂载:切走仅隐藏,未保存的编辑内容不丢失 */}
            {tabs.filter((t) => t.kind === 'file').map((t) => (
              <div key={t.id} className={`tab-pane ${effActiveTabId === t.id ? '' : 'hide'}`}>
                <FileViewer path={t.path || t.id} name={t.name}
                  onDirtyChange={(d) => updateTabDirty(t.id, d)}
                  onClose={() => closeTab(t.id)}
                  onBack={isPhone ? () => setActiveTabId(FILES_HOME_ID) : undefined} />
              </div>
            ))}
          </div>
        </main>
      </div>

      {/* 手机底部导航栏:仅 <768 渲染,视图切换 */}
      {isPhone && (
        <BottomBar
          view={mobileView}
          fileTabCount={tabs.filter((t) => t.kind === 'file').length}
          onSelect={selectMobileView}
        />
      )}

      {settingsOpen && <SettingsPanel connected={connected} onClose={() => setSettingsOpen(false)} />}
      {sshOpen && <SshConnectModal status={status} onClose={() => setSshOpen(false)} />}
      <TooltipHost />
    </div>
    </LlmProvider>
  );
}