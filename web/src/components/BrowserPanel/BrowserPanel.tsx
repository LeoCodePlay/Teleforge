// 浏览器预览面板:一个真实 Chromium 的远程画面 + 输入回传。
// 画面:服务端 CDP screencast 的 JPEG 帧经 /ws/browser 二进制下发,这里转成 objectURL 渲染;
// 输入:鼠标(指针事件)/滚轮/键盘(隐藏 textarea 承载输入法)归一化后回传,实现"可交互的预览";
// AI 操控的是同一个页面(服务端 browser_* 工具驱动的就是这条会话),所见即所控。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { normalizePreviewInput, ownerSessionLabel, previewLabel, touchDragDelta } from '../../utils/preview';
import { openExternal } from '../../utils/updater';
import {
  IconArrowLeft16, IconArrowRight16, IconCheck16, IconCopy16, IconExternal16,
  IconGlobe16, IconKeyboard16, IconLock16, IconReload16,
} from '../icons/icons';
import './BrowserPanel.scss';

interface PageState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
}

export interface BrowserPanelProps {
  /** 服务端浏览器会话 id(形如 `会话id:序号`,归属会话编在 id 里) */
  sessionId: string;
  /** 用户当前所在的会话 id:画面通道带着它上报,服务端据此允许/拒绝输入 */
  viewerSid?: string | null;
  /** 该预览绑定的会话 id(null = 无归属的共享预览,谁都能操作) */
  ownerSid?: string | null;
  /** 归属会话的标题(左下角"已连接的会话"显示用) */
  ownerTitle?: string;
  /** 归属会话就是用户当前所在的会话(据此决定是否允许交互) */
  ownerIsCurrent?: boolean;
  /** 归属会话是否存在且可切换过去(会话已被删除时为 false) */
  canSwitchOwner?: boolean;
  /** 点「绑定到当前会话」:把这个预览改绑给用户当前所在会话(会重建浏览器,页面状态丢失) */
  onBindHere?: () => void;
  /** 要打开的地址;变化时驱动导航(空 = 未指定,面板显示手动打开入口) */
  url?: string;
  /** 是否为当前可见标签:不可见时断开画面通道以省 CPU */
  active?: boolean;
  /** 空面板的「最近地址」候选(手动打开时给用户直接可点的台阶) */
  suggestions?: string[];
  /** 标题/地址回传,供标签名实时更新与持久化 */
  onState?: (s: { url: string; title: string }) => void;
}

const EMPTY: PageState = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: null };

export default function BrowserPanel({
  sessionId, viewerSid = null, ownerSid = null, ownerTitle = '',
  ownerIsCurrent = true, canSwitchOwner = false, onBindHere,
  url, active = true, suggestions = [], onState
}: BrowserPanelProps) {
  const [page, setPage] = useState<PageState>(EMPTY);
  const [frame, setFrame] = useState('');
  const [addr, setAddr] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [direct, setDirect] = useState('');
  const [copied, setCopied] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const [conn, setConn] = useState(false);
  // 画面铺满方式:视口与容器等比时 fill(铺满);尺寸被服务端钳制(容器过窄/过矮)时退回 contain,避免拉伸变形
  const [fitMode, setFitMode] = useState<'fill' | 'contain'>('fill');
  // 触摸设备:工具栏多出「⌨ 唤起软键盘」按钮,并把拖动解释成页面滚动而非鼠标拖拽
  const [isTouch, setIsTouch] = useState(false);
  const [kbOpen, setKbOpen] = useState(false);
  // 右键 / 长按菜单(位置相对画面舞台):复制·粘贴·全选等操作在手机上没有别的入口
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // 归属锁定:这个预览属于别的会话(或服务端拒绝了本次输入)。锁定 = 只许看,不许点/打字,
  // 并给出「绑定到当前会话」的出口——预览是别人的对话资产,不能被当前对话顺手改掉。
  const [ownerLive, setOwnerLive] = useState<{ ownerSid: string | null; ownerTitle: string | null } | null>(null);
  const [lockedHint, setLockedHint] = useState('');
  const locked = !ownerIsCurrent;

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const imeRef = useRef<HTMLTextAreaElement>(null);
  const addrRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const frameUrlRef = useRef('');
  const lastNavRef = useRef('');
  const sizeRef = useRef({ width: 0, height: 0 });
  const navigatedRef = useRef(false);
  const stateCbRef = useRef(onState);
  stateCbRef.current = onState;
  const kbRef = useRef(false);
  kbRef.current = kbOpen;
  // 最近一次同步给服务端的视口尺寸(去重:尺寸没变不重复发)
  const lastVpRef = useRef({ width: 0, height: 0 });
  // 锁定态在原生事件监听(wheel)里也要读到最新值
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  /** 量一次预览容器尺寸;隐藏(display:none)时返回 null,不覆盖已记录的尺寸 */
  const measure = () => {
    const r = stageRef.current?.getBoundingClientRect();
    if (!r || r.width < 80 || r.height < 80) return null;
    sizeRef.current = { width: Math.round(r.width), height: Math.round(r.height) };
    return sizeRef.current;
  };

  /** 把容器尺寸同步成远程页面的视口:画面通道已连上就走它,否则回落到 RPC */
  const syncViewport = (force = false) => {
    const size = sizeRef.current;
    if (size.width < 80 || size.height < 80) return;
    if (!force && lastVpRef.current.width === size.width && lastVpRef.current.height === size.height) return;
    lastVpRef.current = { width: size.width, height: size.height };
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'viewport', apply: true, width: size.width, height: size.height }));
    } else {
      api.request('browser_resize', { id: sessionId, width: size.width, height: size.height }, 30000).catch(() => {});
    }
  };

  // 触摸设备判定:粗指针或存在触摸点(平板带鼠标时以事件里的 pointerType 为准)
  useEffect(() => {
    const mq = window.matchMedia?.('(pointer: coarse)');
    const update = () => setIsTouch(!!mq?.matches || (navigator.maxTouchPoints || 0) > 0);
    update();
    mq?.addEventListener?.('change', update);
    return () => mq?.removeEventListener?.('change', update);
  }, []);

  // 软键盘:⌨ 打开时把隐藏输入框切成可输入并聚焦;收起时 blur 让键盘落下。
  // 关闭态用 inputMode=none:点画面只聚焦(硬件键盘可用)但不会弹出软键盘。
  useEffect(() => {
    const ta = imeRef.current;
    if (!ta) return;
    if (kbOpen) {
      ta.setAttribute('inputmode', 'text');
      try { ta.blur(); ta.focus({ preventScroll: true }); } catch { /* 忽略 */ }
    } else {
      ta.setAttribute('inputmode', 'none');
      try { ta.blur(); } catch { /* 忽略 */ }
      // 键盘收起后容器高度恢复:重新对齐视口(弹起期间冻结尺寸,避免输入时页面反复重排)
      measure();
      syncViewport(true);
    }
  }, [kbOpen]);

  // ---- 画面通道(二进制帧 + 状态) ----
  useEffect(() => {
    if (!active || !sessionId) return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const open = () => {
      if (disposed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      // ?sid = 用户当前所在会话:服务端拿它校验"这个预览是不是归你"(非归属会话的输入会被拒),
      // 只影响输入权限,不影响画面订阅(非归属也能看,只是点不动)。
      const q = `id=${encodeURIComponent(sessionId)}${viewerSid ? `&sid=${encodeURIComponent(viewerSid)}` : ''}`;
      const ws = new WebSocket(`${proto}://${location.host}/ws/browser?${q}`);
      ws.binaryType = 'blob';
      wsRef.current = ws;
      ws.onopen = () => { attempt = 0; setConn(true); };
      ws.onmessage = (ev) => {
        const d = ev.data;
        if (typeof d === 'string') {
          try {
            const m = JSON.parse(d);
            if (m?.type === 'browser_state') {
              if (m.closed) return; // 会话尚未建立(或已被关闭):保持连接,等 browser_open 落地后再接收状态
              setConn(true);
              // 归属以服务端为准:前端标签 id 只是约定,服务端才是权限的最终裁决者
              if (m.ownerSid !== undefined) setOwnerLive({ ownerSid: m.ownerSid || null, ownerTitle: m.ownerTitle || null });
              setPage((p) => ({ ...p, url: m.url ?? p.url, title: m.title ?? '', loading: !!m.loading, canGoBack: !!m.canGoBack, canGoForward: !!m.canGoForward, error: m.error ?? null }));
              setPhase((ph) => (m.error ? 'error' : (ph === 'error' ? 'live' : ph)));
              if (m.url) {
                setDirect((d0) => d0 || m.url);
                setAddr((a0) => (document.activeElement === addrRef.current ? a0 : String(m.url)));
              }
            } else if (m?.type === 'browser_locked') {
              // 服务端明确拒绝:这个预览属于别的会话(前端标签归属过时也会走到这里,例如后端重启后会话换了)
              setLockedHint(String(m.error || '这个预览属于另一个会话'));
              if (m.ownerSid !== undefined) setOwnerLive({ ownerSid: m.ownerSid || null, ownerTitle: null });
            }
          } catch { /* 忽略非 JSON 文本帧 */ }
          return;
        }
        const blob = d instanceof Blob ? d : new Blob([d as ArrayBuffer], { type: 'image/jpeg' });
        const next = URL.createObjectURL(blob);
        const prev = frameUrlRef.current;
        frameUrlRef.current = next;
        setFrame(next);
        if (prev) setTimeout(() => URL.revokeObjectURL(prev), 4000);
      };
      ws.onclose = () => { setConn(false); if (disposed) return; attempt += 1; retry = setTimeout(open, Math.min(800 * attempt, 5000)); };
      ws.onerror = () => { /* onclose 统一重连 */ };
    };
    open();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      const ws = wsRef.current;
      wsRef.current = null;
      setConn(false);
      if (ws) { try { ws.close(); } catch { /* 忽略 */ } }
    };
  }, [active, sessionId, viewerSid]);

  // 用户切换会话后,同一条画面通道要把"我现在在哪个会话"更新给服务端,
  // 否则输入会被旧会话的归属判定拒掉(服务端只认它记下的 sid)。
  useEffect(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'viewer', sid: viewerSid || '' })); } catch { /* 忽略 */ }
    }
  }, [viewerSid, conn]);


  // ---- 地址变化 → 打开/导航(按 sessionId 复用同一个预览会话) ----
  useEffect(() => {
    const target = url ? normalizePreviewInput(url) : null;
    if (!target) { setAddr((a) => a || ''); return; }
    if (lastNavRef.current === target) return;
    // 隐藏的预览标签不预先加载页面(切到该标签时才真正打开),避免刷新后同时拉起多个站点
    if (!active && !lastNavRef.current) return;
    // 只对"本会话自己的预览"发起导航:标签归属改了但面板还没重挂载时,别拿旧 id 去打别人的浏览器
    const ownedByViewer = !ownerSid || !viewerSid || ownerSid === viewerSid;
    if (!ownedByViewer) { setPhase('idle'); return; }
    lastNavRef.current = target;
    navigatedRef.current = false;
    setAddr(target);
    setDirect(target);
    setPhase('connecting');
    const { width, height } = measure() || sizeRef.current;
    api.request('browser_open', { id: sessionId, url: target, sid: viewerSid || undefined, width: width || undefined, height: height || undefined }, 120000)
      .then((r) => {
        navigatedRef.current = true;
        setNote(r?.note || null);
        if (r?.direct) setDirect(r.direct);
        setPage((p) => ({ ...p, url: r?.url || target, title: r?.title || p.title, loading: !!r?.loading, error: r?.error ?? null }));
        // 服务端把导航失败的原因写进 state.error(已重试过、已翻译成可操作说明):直接进错误态,给「重试」
        setPhase(r?.error ? 'error' : 'live');
        // 页面视口必须与预览容器 1:1(容器就是画面本身),否则会出现留白/缩放
        lastVpRef.current = { width: r?.viewport?.width || 0, height: r?.viewport?.height || 0 };
        syncViewport();
      })
      .catch((e) => { setPhase('error'); setPage((p) => ({ ...p, error: (e as Error).message })); });
  }, [url, sessionId, active, ownerSid, viewerSid]);

  // 标题/地址回传(标签名与持久化)
  useEffect(() => {
    if (!page.url) return;
    stateCbRef.current?.({ url: page.url, title: page.title });
  }, [page.url, page.title]);

  // ---- 视口尺寸同步(容器尺寸 → 页面视口),拖动窗口时防抖 ----
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r || r.width < 80 || r.height < 80) return;
      if (kbRef.current) return; // 软键盘弹起中:冻结页面视口,避免打字时页面不断重排
      sizeRef.current = { width: Math.round(r.width), height: Math.round(r.height) };
      if (timer) clearTimeout(timer);
      timer = setTimeout(syncViewport, 150); // 紧跟容器尺寸:页面始终铺满、不留白
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
  }, []);

  // 切到该预览标签(从 display:none 变可见)时立刻对齐视口:
  // 隐藏期间 ResizeObserver 量不到尺寸,变可见瞬间必须主动量一次,
  // 否则远程页面会沿用旧视口(首次是默认 1280×800),画面就会留白/缩放。
  useEffect(() => {
    if (!active) return;
    measure();
    syncViewport();
    const t1 = setTimeout(() => { measure(); syncViewport(); }, 150);
    const t2 = setTimeout(() => { measure(); syncViewport(); }, 600);
    return () => { clearTimeout(t1); clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId]);

  // 滚轮:React 的 wheel 监听是被动的,必须用原生非 passive 监听才能 preventDefault 阻止页面滚动
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (lockedRef.current) return; // 锁定时既不让本机滚动,也不把滚动发给页面
      const { nx, ny } = norm(e.clientX, e.clientY);
      sendInput({ kind: 'wheel', nx, ny, dx: e.deltaX, dy: e.deltaY });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  /** 每帧加载后校准铺满方式:视口与容器等比 → fill 铺满;被服务端钳制(容器过小)→ contain 免得拉伸变形 */
  const onFrameLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!img.naturalWidth || !img.naturalHeight || !rect || rect.width < 1 || rect.height < 1) return;
    const frameRatio = img.naturalWidth / img.naturalHeight;
    const boxRatio = rect.width / rect.height;
    const mode: 'fill' | 'contain' = Math.abs(frameRatio - boxRatio) / boxRatio < 0.01 ? 'fill' : 'contain';
    setFitMode((m) => (m === mode ? m : mode));
  };

  const sendInput = useCallback((event: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', event }));
  }, []);

  const norm = (clientX: number, clientY: number) => {
    const el = imgRef.current;
    if (!el) return { nx: 0, ny: 0 };
    const r = el.getBoundingClientRect();
    const clamp = (v: number) => Math.min(Math.max(v, 0), 1);
    return {
      nx: clamp((clientX - r.left) / Math.max(r.width, 1)),
      ny: clamp((clientY - r.top) / Math.max(r.height, 1))
    };
  };

  const goto = (raw: string, force = false) => {
    if (locked) { toast('这个预览属于另一个会话:点左下角「绑定到当前会话」后即可操作'); return; }
    const target = normalizePreviewInput(raw);
    if (!target) return;
    if (!force && target === lastNavRef.current) return;
    lastNavRef.current = target;
    setAddr(target);
    setPhase('connecting');
    // 用 browser_open 而不是 browser_navigate:手动打开(空面板)时服务端会话可能还不存在,
    // browser_open 是「有则导航、无则创建」的幂等入口;browser_navigate 只作用于已存在的会话。
    // 带上 sid = 用户当前会话:服务端据此判断这个预览是否归它所有(非归属会被拒)。
    const { width, height } = measure() || sizeRef.current;
    api.request('browser_open', { id: sessionId, url: target, sid: viewerSid || undefined, width: width || undefined, height: height || undefined }, 120000)
      .then((r) => {
        setNote(r?.note || null);
        if (r?.direct) setDirect(r.direct);
        setPage((p) => ({ ...p, url: r?.url || target, title: r?.title || p.title, loading: !!r?.loading, error: r?.error ?? null }));
        setPhase(r?.error ? 'error' : 'live');
        lastVpRef.current = { width: r?.viewport?.width || 0, height: r?.viewport?.height || 0 };
        syncViewport();
      })
      .catch((e) => { setPhase('error'); setPage((p) => ({ ...p, error: (e as Error).message })); });
  };

  const doAction = (type: 'browser_back' | 'browser_forward' | 'browser_reload') => {
    if (locked) { toast('这个预览属于另一个会话,不能操作'); return; }
    api.request(type, { id: sessionId, sid: viewerSid || undefined }, 60000).then((r) => {
      if (r?.url) setPage((p) => ({ ...p, url: r.url, loading: !!r.loading, error: r.error ?? null }));
      else if (type === 'browser_reload') setPage((p) => ({ ...p, loading: true }));
    }).catch(() => { /* 状态由 WS 推回 */ });
  };

  // ---------- 指针输入 ----------
  // 桌面(鼠标/触控笔):原样转发 move/down/up。
  // 触摸:拖动 = 页面滚动(wheel),轻点 = 左键点击,长按 = 右键菜单(复制/粘贴入口)。
  const touchRef = useRef<{ x0: number; y0: number; lastX: number; lastY: number; lastDx: number; lastDy: number; lastAt: number; moved: boolean; long: boolean } | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPress = () => { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; } };

  const onPointerDown = (e: React.PointerEvent) => {
    if (locked) { e.preventDefault(); return; } // 预览不属于当前会话:点不动,只提示怎么改绑
    if (e.button === 2) return; // 右键交给 contextmenu
    // 关键:阻止浏览器默认的「按下就把焦点移到 body」。
    // 否则隐藏输入框立刻失焦 —— 桌面端表现为「打字没反应」,手机端表现为「点一下页面软键盘就被收起」。
    e.preventDefault();
    setMenu(null);
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    // 桌面:始终把键盘焦点收进隐藏输入框;触摸:只在键盘已开启时抢焦点(否则点页面就弹软键盘)
    if (!touch || kbRef.current) imeRef.current?.focus({ preventScroll: true });
    const { nx, ny } = norm(e.clientX, e.clientY);
    if (touch) {
      touchRef.current = {
        x0: e.clientX, y0: e.clientY, lastX: e.clientX, lastY: e.clientY,
        lastDx: 0, lastDy: 0, lastAt: Date.now(), moved: false, long: false
      };
      // 长按 500ms = 打开菜单(移动端没有右键,这是复制/粘贴的入口)
      const box = stageRef.current?.getBoundingClientRect();
      clearPress();
      pressTimer.current = setTimeout(() => {
        const t = touchRef.current;
        if (!t || t.moved) return;
        t.long = true;
        setMenu({ x: e.clientX - (box?.left || 0), y: e.clientY - (box?.top || 0) });
      }, 500);
      return; // 先不发事件:等判定是"轻点"还是"拖动"
    }
    const button = e.button === 1 ? 'middle' : 'left';
    sendInput({ kind: 'mouse', action: 'move', nx, ny });
    sendInput({ kind: 'mouse', action: 'down', nx, ny, button, clickCount: 1 });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (locked) return;
    const t = touchRef.current;
    if (t) {
      // 手指上滑 = 页面向下滚:wheel 的 deltaY 取「上一位置 − 当前位置」(与浏览器原生手势一致)
      const { dx, dy } = touchDragDelta({ x: t.lastX, y: t.lastY }, { x: e.clientX, y: e.clientY });
      if (!t.moved && Math.hypot(e.clientX - t.x0, e.clientY - t.y0) < 8) return; // 抖动阈值内仍算轻点
      t.moved = true;
      clearPress(); // 开始拖动就不再算长按
      t.lastX = e.clientX; t.lastY = e.clientY;
      t.lastDx = dx; t.lastDy = dy; t.lastAt = Date.now();
      const { nx, ny } = norm(e.clientX, e.clientY);
      sendInput({ kind: 'wheel', nx, ny, dx, dy });
      return;
    }
    if (e.buttons === 0 && !(e.currentTarget as HTMLElement).hasPointerCapture?.(e.pointerId)) return;
    const { nx, ny } = norm(e.clientX, e.clientY);
    sendInput({ kind: 'mouse', action: 'move', nx, ny });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (locked) return;
    clearPress();
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
    const { nx, ny } = norm(e.clientX, e.clientY);
    const t = touchRef.current;
    if (t) {
      touchRef.current = null;
      if (t.long) return; // 已经弹出菜单:这一下不算点击
      if (!t.moved) {
        // 轻点 = 左键点击(移动端没有 hover,直接补一次 move + down/up)
        sendInput({ kind: 'mouse', action: 'move', nx, ny });
        sendInput({ kind: 'mouse', action: 'down', nx, ny, button: 'left', clickCount: 1 });
        sendInput({ kind: 'mouse', action: 'up', nx, ny, button: 'left', clickCount: 1 });
      } else if (Date.now() - t.lastAt < 160 && (Math.abs(t.lastDx) > 4 || Math.abs(t.lastDy) > 4)) {
        // 甩动惯性:按最后一段位移再滚两下,手感更接近原生翻页
        for (let i = 1; i <= 2; i++) {
          const k = Math.pow(0.55, i);
          setTimeout(() => sendInput({ kind: 'wheel', nx, ny, dx: t.lastDx * k, dy: t.lastDy * k }), 50 * i);
        }
      }
      return;
    }
    const button = e.button === 1 ? 'middle' : e.button === 2 ? 'right' : 'left';
    sendInput({ kind: 'mouse', action: 'up', nx, ny, button, clickCount: 1 });
  };

  // ---------- 剪贴板 ----------
  // 预览画面是 JPEG,本地选不中任何文字:用户拖选出来的选区在「远程页面」里,
  // 所以复制要回远程页面取文本再写进本机剪贴板;粘贴则相反,读本机剪贴板塞进远程页面。
  const [tip, setTip] = useState<string | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useCallback((msg: string) => {
    setTip(msg);
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(() => setTip(null), 2000);
  }, []);

  /** 复制远程页面里选中的文字到本机剪贴板 */
  const copyRemote = useCallback(async (): Promise<string> => {
    if (lockedRef.current) { toast('这个预览属于另一个会话,不能读取它的选区'); return ''; }
    try {
      const r = await api.request('browser_selection', { id: sessionId, sid: viewerSid || undefined }, 15000);
      const text = String(r?.text || '');
      if (!text) { toast('页面上没有选中文字:先拖选一段再复制'); return ''; }
      await navigator.clipboard.writeText(text);
      toast(`已复制 ${text.length} 个字符`);
      return text;
    } catch (e) {
      toast(`复制失败:${(e as Error).message}`);
      return '';
    }
  }, [sessionId, viewerSid, toast]);

  /** 把本机剪贴板内容输入到远程页面(读剪贴板需要权限,失败时提示用 Ctrl+V) */
  const pasteLocal = useCallback(async () => {
    if (lockedRef.current) { toast('这个预览属于另一个会话,不能往里输入'); return; }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) { toast('本机剪贴板是空的'); return; }
      sendInput({ kind: 'text', text });
      toast(`已粘贴 ${text.length} 个字符`);
    } catch {
      toast('读不到系统剪贴板:在预览里按 Ctrl+V(或长按 → 粘贴)即可');
    }
  }, [toast, sendInput]);

  const cutRemote = useCallback(async () => {
    if (lockedRef.current) { toast('这个预览属于另一个会话,不能剪切'); return; }
    const text = await copyRemote();
    if (text) sendInput({ kind: 'key', key: 'Backspace' });
  }, [copyRemote, sendInput]);

  const selectAllRemote = useCallback(() => {
    if (lockedRef.current) { toast('这个预览属于另一个会话,不能选择内容'); return; }
    sendInput({ kind: 'key', key: 'a', ctrlKey: true });
    toast('已全选页面内容');
  }, [sendInput, toast]);

  // ---------- 键盘 ----------
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (lockedRef.current) return; // 锁定时键盘不转发(隐藏输入框也不该拿到焦点)
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey) {
      const lower = k.toLowerCase();
      if (lower === 'c') { e.preventDefault(); void copyRemote(); return; }
      if (lower === 'x') { e.preventDefault(); void cutRemote(); return; }
      if (lower === 'a') { e.preventDefault(); selectAllRemote(); return; }
      // Ctrl+V 不拦截:让浏览器把剪贴板粘进这个隐藏输入框(不受剪贴板读权限限制),
      // 再由下面的 input 事件统一转发给远程页面。
      if (lower === 'v') return;
    }
    const printable = k.length === 1 && !mod && !e.altKey;
    if (printable) return; // 交给 input 事件(含输入法),避免重复插入
    // 手机输入法的这些"键"不是真按键,发过去会让 Playwright 报无效键,交给 input/组合事件
    if (k === 'Unidentified' || k === 'Process' || k === 'Dead' || k === 'Compose') return;
    e.preventDefault();
    sendInput({ kind: 'key', key: k, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey });
  };
  const composingRef = useRef(false);
  const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const v = ta.value;
    if (!v) return;
    if (lockedRef.current) { ta.value = ''; return; }
    if (composingRef.current) return; // 输入法组合中:compositionend 统一提交
    sendInput({ kind: 'text', text: v });
    ta.value = '';
  };

  // 地址栏「前往」只在输入与当前地址不同时出现(减少工具条噪声)
  const addrDirty = !!addr.trim() && addr.trim() !== page.url;
  const secure = /^https:/i.test(page.url);
  const copyUrl = () => {
    const u = direct || page.url;
    if (!u) return;
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1200); };
    try { navigator.clipboard?.writeText(u).then(done, done); } catch { done(); }
  };
  // 空面板的「最近地址」候选(去重、最多 3 个)
  const suggestionList = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of suggestions) {
      const v = normalizePreviewInput(String(raw || ''));
      if (!v || seen.has(v)) continue;
      seen.add(v); out.push(v);
      if (out.length >= 3) break;
    }
    return out;
  }, [suggestions]);

  const showEmpty = !page.url && phase !== 'connecting';
  const statusText = page.error ? page.error
    : phase === 'connecting' || page.loading ? '加载中…'
    : conn ? '已连接' : '连接中…';
  const statusKind = page.error ? 'err' : conn ? 'ok' : 'wait';
  // 左下角显示的「已连接的会话」:优先用服务端确认的归属(前端标签归属可能过时),
  // 会话已被删除时给出明确说明,而不是显示一个谁也认不出的 id。
  const ownerLabel = ownerSessionLabel(ownerLive?.ownerSid ?? ownerSid, ownerLive?.ownerTitle || ownerTitle);
  // 长标题在徽标里放不下:主动截断并加省略号(完整名称仍在 tooltip 里),
  // 免得被 CSS 挤成"半截字"或被 overflow 硬切掉,看起来像坏了
  const ownerLabelShort = ownerLabel.length > 14 ? ownerLabel.slice(0, 12) + '…' : ownerLabel;
  const ownerHint = locked
    ? lockedHint || `这个预览属于会话「${ownerLabel}」:只有它可以操控,你当前在别的会话`
    : `这个预览绑定在会话「${ownerLabel}」:你可以直接操作它,该会话的 AI 也能看到并操控它`;

  return (
    <div className={`bp${locked ? ' locked' : ''}`}>
      {locked && (
        <div className="bp-lockbar">
          <IconLock16 size={13} />
          <span className="bp-lockbar-text">此预览属于会话「{ownerLabel}」,当前会话只能查看</span>
          {canSwitchOwner && onBindHere && (
            <button className="bp-lockbar-btn" onClick={onBindHere}>绑定到当前会话</button>
          )}
        </div>
      )}
      <div className="bp-toolbar">
        <div className="bp-nav" role="group" aria-label="导航">
          <button className="bp-ico" onClick={() => doAction('browser_back')} disabled={locked || !page.canGoBack}
            data-tip="后退" aria-label="后退"><IconArrowLeft16 size={16} /></button>
          <button className="bp-ico bp-fwd" onClick={() => doAction('browser_forward')} disabled={locked || !page.canGoForward}
            data-tip="前进" aria-label="前进"><IconArrowRight16 size={16} /></button>
          <button className={`bp-ico${page.loading ? ' spinning' : ''}`} onClick={() => doAction('browser_reload')}
            data-tip="刷新" aria-label="刷新" disabled={locked}><IconReload16 size={15} /></button>
        </div>
        <form className={`bp-addr${page.error ? ' err' : conn ? ' ok' : ''}`}
          onSubmit={(e) => { e.preventDefault(); goto(addr, true); }}>
          <span className="bp-addr-ico" data-tip={secure ? 'HTTPS' : 'HTTP'}>
            {secure ? <IconLock16 size={14} /> : <IconGlobe16 size={14} />}
          </span>
          <input
            ref={addrRef}
            value={addr}
            spellCheck={false}
            readOnly={locked}
            placeholder="输入地址,如 localhost:5173"
            onChange={(e) => setAddr(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
          />
          {addrDirty && !locked && (
            <button type="submit" className="bp-go" data-tip="前往" aria-label="前往"><IconArrowRight16 size={14} /></button>
          )}
        </form>
        <button className="bp-ico bp-copy" onClick={copyUrl} disabled={!page.url}
          data-tip={copied ? '已复制地址' : '复制地址'} aria-label="复制地址">
          {copied ? <IconCheck16 size={15} /> : <IconCopy16 size={15} />}
        </button>
        {isTouch && (
          <button className={`bp-ico bp-kb${kbOpen ? ' on' : ''}`} onClick={() => setKbOpen((v) => !v)}
            data-tip={kbOpen ? '收起键盘' : '打开键盘(把输入发送到页面)'} aria-label="键盘" disabled={locked}>
            <IconKeyboard16 size={16} />
          </button>
        )}
        <button className="bp-ico bp-out" disabled={!page.url}
          onClick={() => { const u = direct || page.url; if (u) void openExternal(u); }}
          data-tip="在系统浏览器中打开" aria-label="在系统浏览器中打开">
          <IconExternal16 size={16} />
        </button>
        {page.loading && <span className="bp-progress" aria-hidden="true" />}
      </div>

      {note && <div className="bp-note" title={note}>{note}</div>}

      <div
        className="bp-stage"
        ref={stageRef}
        onContextMenu={(e) => {
          // 原生右键菜单在预览里没意义(画面是图片),换成我们自己的操作菜单
          e.preventDefault();
          const box = stageRef.current?.getBoundingClientRect();
          setMenu({ x: e.clientX - (box?.left || 0), y: e.clientY - (box?.top || 0) });
        }}
      >
        {frame && (
          <img
            ref={imgRef}
            className="bp-frame"
            src={frame}
            alt="浏览器预览"
            draggable={false}
            style={{ objectFit: fitMode }}
            onLoad={onFrameLoad}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        )}
        {/* 隐藏输入框:承载键盘与输入法(中文)组合输入,再转发给页面 */}
        <textarea
          ref={imeRef}
          className="bp-ime"
          aria-hidden="true"
          tabIndex={-1}
          autoComplete="off"
          inputMode={kbOpen ? 'text' : 'none'}
          onKeyDown={onKeyDown}
          onInput={onInput}
          // 兜底:某些路径(浏览器菜单/扩展)直接触发 copy 事件时也走远程选区
          onCopy={(e) => { e.preventDefault(); void copyRemote(); }}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={(e) => {
            composingRef.current = false;
            const v = e.currentTarget.value || e.data || '';
            if (v) { if (!lockedRef.current) sendInput({ kind: 'text', text: v }); e.currentTarget.value = ''; }
          }}
        />
        {showEmpty && (
          <div className="bp-empty">
            <div className="bp-empty-ico"><IconGlobe16 size={46} /></div>
            <div className="bp-empty-title">浏览器预览</div>
            <div className="bp-empty-desc">
              启动项目后地址会自动出现在这里;也可以直接输入或粘贴项目地址。
              <br />AI 助手能操控这个页面:打开、点击、输入、截图。
            </div>
            <form className="bp-empty-form" onSubmit={(e) => { e.preventDefault(); goto(addr, true); }}>
              <span className="bp-empty-form-ico"><IconGlobe16 size={15} /></span>
              <input
                value={addr}
                spellCheck={false}
                placeholder="http://localhost:5173"
                onChange={(e) => setAddr(e.target.value)}
              />
              <button type="submit">打开</button>
            </form>
            {suggestionList.length > 0 && (
              <div className="bp-empty-sug">
                <span className="bp-empty-sug-label">最近地址</span>
                {suggestionList.map((u) => (
                  <button key={u} type="button" className="bp-sug" data-tip={u} onClick={() => goto(u, true)}>
                    {previewLabel(u)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {phase === 'error' && page.url && (
          <div className="bp-overlay-err">
            <span>{page.error || '打开失败'}</span>
            <button className="bp-retry" onClick={() => goto(page.url, true)}>重试</button>
          </div>
        )}
        {/* 操作反馈:复制/粘贴这类动作没有视觉结果,必须给一句回执 */}
        {tip && <div className="bp-tip">{tip}</div>}
        {/* 右键 / 长按菜单:预览是图片,原生菜单没用;复制粘贴只能从这里或快捷键走 */}
        {menu && (
          <>
            <div className="bp-menu-mask" onPointerDown={() => setMenu(null)} onContextMenu={(e) => e.preventDefault()} />
            <div
              className="bp-menu"
              style={{
                left: Math.max(6, Math.min(menu.x, (stageRef.current?.clientWidth || 0) - 176)),
                top: Math.max(6, Math.min(menu.y, (stageRef.current?.clientHeight || 0) - 240))
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <button onClick={() => { setMenu(null); void copyRemote(); }}>复制<span className="bp-menu-k">Ctrl+C</span></button>
              <button onClick={() => { setMenu(null); void pasteLocal(); }}>粘贴<span className="bp-menu-k">Ctrl+V</span></button>
              <button onClick={() => { setMenu(null); void cutRemote(); }}>剪切<span className="bp-menu-k">Ctrl+X</span></button>
              <button onClick={() => { setMenu(null); selectAllRemote(); }}>全选<span className="bp-menu-k">Ctrl+A</span></button>
              <div className="bp-menu-sep" />
              <button onClick={() => { setMenu(null); doAction('browser_reload'); }}>刷新</button>
              <button disabled={!page.url} onClick={() => { setMenu(null); copyUrl(); }}>复制页面地址</button>
              <button disabled={!page.url} onClick={() => {
                setMenu(null);
                const u = direct || page.url;
                if (u) void openExternal(u);
              }}>在系统浏览器打开</button>
            </div>
          </>
        )}
      </div>

      <div className="bp-status">
        <span className={`bp-dot ${statusKind}`} aria-hidden="true" />
        <span className={`bp-status-text${page.error ? ' err' : ''}`} title={page.error || statusText}>{statusText}</span>
        {/* 左下角:这个预览浏览器连的是哪个会话 —— 一个预览只服务一个对话,归属一眼可见。
            必须排在 .bp-spacer 之前:spacer 是 flex:1,排在它后面会被推到状态栏最右侧。 */}
        <span className={`bp-owner${locked ? ' locked' : ''}`} data-tip={ownerHint}>
          {locked ? <IconLock16 size={12} /> : <IconGlobe16 size={12} />}
          <span className="bp-owner-label">已连接会话:{ownerLabelShort}</span>
          {canSwitchOwner && onBindHere && (
            <button className="bp-owner-btn" onClick={onBindHere} data-tip="把这个预览改绑到当前会话(会重新加载页面)">
              绑到本会话
            </button>
          )}
        </span>
        <span className="bp-spacer" />
        {page.title && <span className="bp-title" title={page.title}>{page.title}</span>}
        <span className="bp-ai" title="本会话的 AI 可以操控这个页面(打开/点击/输入/截图)">AI 可操控</span>
      </div>
    </div>
  );
}
