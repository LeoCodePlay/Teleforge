// 浏览器后端抽象层:把两种"浏览器"收敛成同一套操作接口。
//
//   preview —— 内置预览:core/browser-manager.ts 用 Playwright 拉起的 Chromium(兜底,用户零配置)
//   native  —— 真机浏览器:core/browser-bridge.ts 桥接到用户本机 Chrome/Edge 里的扩展(带登录态)
//
// agent/browser-tools.ts 的 11 个工具因此只写一份逻辑,路由规则见那边的 resolveOps():
// 「扩展在线 → 真机;否则 → 内置预览」,显式传 target 可覆盖。
//
// 快照格式刻意统一:真机侧只回传 SNAPSHOT_SCRIPT 的原始 JSON,由服务端复用 formatSnapshot 渲染,
// 两种后端给模型的文本逐字一致 —— 模型不需要学两套页面描述。
import { browserManager, formatSnapshot } from '../core/browser-manager.ts';
import { browserBridge } from '../core/browser-bridge.ts';
import type { BridgeStatus, ExtTab } from '../core/browser-bridge.ts';

export type BackendKind = 'native' | 'preview';

/** 与 BrowserState 取交集的最小状态(两种后端都能提供) */
export interface TargetState {
  url: string;
  title: string;
  error: string | null;
}

export interface BrowserOps {
  kind: BackendKind;
  /** 稳定标识:native = native:tab:<tabId>,preview = 预览标签 id(如 s_xxx:1) */
  id: string;
  /** 当前目标标签(仅 native 有意义;未指定时为 null,执行时回落到活动标签) */
  tabId: number | null;
  state(): TargetState | null;
  openUrl(url: string, opts?: { width?: number; height?: number }): Promise<TargetState>;
  navigate(url: string): Promise<TargetState>;
  snapshot(): Promise<string>;
  click(t: { ref?: string; selector?: string; text?: string }): Promise<string>;
  fill(t: { ref?: string; selector?: string; text: string; submit?: boolean; clear?: boolean }): Promise<string>;
  press(key: string): Promise<string>;
  scroll(o: { direction?: string; amount?: number }): Promise<string>;
  waitFor(o: { text?: string; selector?: string; url?: string; timeoutMs?: number }): Promise<string>;
  evaluate(expression: string): Promise<string>;
  screenshot(o?: { fullPage?: boolean }): Promise<Buffer>;
  close(): Promise<void>;
}

/** 真机浏览器的目标标识(带前缀,和预览 id 一眼可分) */
export function nativeIdOf(tabId: number): string {
  return `native:tab:${tabId}`;
}

// ---------------- 内置预览后端 ----------------

export function previewOps(id: string, sid: string | null): BrowserOps {
  return {
    kind: 'preview',
    id,
    tabId: null,
    state() {
      const st = browserManager.state(id);
      return st ? { url: st.url, title: st.title, error: st.error } : null;
    },
    async openUrl(url, opts) {
      const st = await browserManager.open({ id, url, width: opts?.width, height: opts?.height, ownerSid: sid });
      return { url: st.url, title: st.title, error: st.error };
    },
    async navigate(url) {
      const st = await browserManager.navigate(id, url, sid);
      return { url: st.url, title: st.title, error: st.error };
    },
    snapshot: () => browserManager.snapshot(id, sid),
    click: (t) => browserManager.click(id, t, sid),
    fill: (t) => browserManager.fill(id, t, sid),
    press: (k) => browserManager.press(id, k, sid),
    scroll: (o) => browserManager.scroll(id, o, sid),
    waitFor: (o) => browserManager.waitFor(id, o, sid),
    evaluate: (e) => browserManager.evaluate(id, e, sid),
    screenshot: (o) => browserManager.screenshot(id, o || {}, sid),
    close: () => browserManager.close(id, sid)
  };
}

// ---------------- 真机浏览器后端 ----------------

export function nativeAvailable(): boolean {
  return browserBridge.isOnline();
}

export function nativeStatus(): BridgeStatus {
  return browserBridge.status();
}

/** 未显式指定 tab_id 时的默认目标:当前活动标签(退而求其次取第一个) */
export function activeNativeTab(): ExtTab | null {
  const st = browserBridge.status();
  return st.tabs.find((t) => t.active) || st.tabs[0] || null;
}

/**
 * 会话 ↔ 真机标签的绑定:一个对话固定操控它自己那个标签。
 *
 * 为什么需要:resolveOps() 每次工具调用都会新建一个 ops(闭包里的 cur 只在这一次调用内有效),
 * 所以"没传 tab_id"时旧实现只能回落到**当前活动标签** —— 也就是用户此刻正在看的那个。
 * 用户随手切一下标签,AI 下一步就可能对着别的标签快照/点击:默认 ai-tabs 模式下会被
 * canOperate 拒掉变成一步失败,mode=all 或用户授权过那个标签时更会真的操作错标签。
 * 绑定之后,用户怎么切标签都不改变 AI 的目标。
 */
const sessionTabs = new Map<string, number>();

/** 记住「这个对话在操作哪个标签」(browser_open 开新标签后调用) */
export function rememberNativeTab(sid: string | null, tabId: number): void {
  if (sid && Number.isFinite(tabId)) sessionTabs.set(sid, tabId);
}

/** 标签被关掉时解除绑定,避免会话一直指着一个不存在的标签 */
export function forgetNativeTab(tabId: number): void {
  for (const [sid, id] of sessionTabs) {
    if (id === tabId) sessionTabs.delete(sid);
  }
}

/**
 * 取本会话绑定的标签。标签已被用户关掉(或扩展重连后清单里没了)就忘掉它并返回 null ——
 * 不返回过期 id,让调用方走回退逻辑,而不是拿着一个死 tabId 去撞"无法调试标签"。
 */
export function sessionNativeTab(sid: string | null): number | null {
  if (!sid) return null;
  const id = sessionTabs.get(sid);
  if (id == null) return null;
  if (!browserBridge.status().tabs.some((t) => t.tabId === id)) {
    sessionTabs.delete(sid);
    return null;
  }
  return id;
}

/** 给模型看的真机标签清单(数量上限,避免几十个标签把工具结果撑爆) */
export function nativeInventory(): Record<string, unknown> {
  const st = browserBridge.status();
  if (!st.online) {
    return { backend: 'native', extensionOnline: false, extensionError: st.error || null };
  }
  return {
    backend: 'native',
    extensionOnline: true,
    extensionVersion: st.version,
    mode: st.mode,
    tabs: st.tabs.slice(0, 12).map((t) => ({
      tabId: t.tabId, url: t.url, title: t.title, active: t.active, allowed: t.allowed
    })),
    tabsTruncated: st.tabs.length > 12
  };
}

/**
 * 真机后端。tabId 用闭包保存(tabs.open 之后目标会变成新标签),
 * 因此 id/tabId 用 getter 暴露,避免调用方读到过期值。
 * sid 用来把「这次操作的是哪个标签」记到会话上(见 rememberNativeTab)。
 */
export function nativeOpsFor(tabId: number | null, sid: string | null = null): BrowserOps {
  let cur: number | null = tabId;

  /** 解析出本次操作的目标标签,并做授权校验(未授权一律拒绝,不给"顺手就操作了"的机会) */
  const needTab = (): number => {
    const id = cur ?? activeNativeTab()?.tabId ?? null;
    if (id == null) {
      throw new Error('真机浏览器里没有可操作的标签:先用 browser_open 打开一个地址,或让用户在浏览器里打开一个页面后重试');
    }
    const chk = browserBridge.canOperate(id);
    if (!chk.ok) throw new Error(chk.reason);
    return id;
  };

  const ops = {
    kind: 'native' as const,
    get id() { return cur != null ? nativeIdOf(cur) : 'native:active'; },
    get tabId() { return cur; },
    state(): TargetState | null {
      const st = browserBridge.status();
      const t = cur != null ? st.tabs.find((x) => x.tabId === cur) : (st.tabs.find((x) => x.active) || null);
      return t ? { url: t.url, title: t.title, error: null } : null;
    },
    async openUrl(url: string): Promise<TargetState> {
      const r = await browserBridge.call<any>('tabs.open', { url, active: true }, { timeoutMs: 60_000 });
      const newId = Number(r?.tabId);
      if (Number.isFinite(newId)) {
        cur = newId;
        // AI 自己开的标签自动可操作(符合「仅 AI 自建 + 用户授权」的默认授权模型)
        browserBridge.markAiTab(newId);
        // 这个对话从此固定操控这个标签:用户之后怎么切标签都不会改变 AI 的目标
        rememberNativeTab(sid, newId);
      }
      return { url: String(r?.url || url), title: String(r?.title || ''), error: null };
    },
    async navigate(url: string): Promise<TargetState> {
      const id = needTab();
      const r = await browserBridge.call<any>('navigate', { tabId: id, url }, { timeoutMs: 60_000 });
      return { url: String(r?.url || url), title: String(r?.title || ''), error: r?.error ? String(r.error) : null };
    },
    async snapshot(): Promise<string> {
      const id = needTab();
      const raw = await browserBridge.call<any>('snapshot', { tabId: id });
      return formatSnapshot(raw);
    },
    async click(t: { ref?: string; selector?: string; text?: string }): Promise<string> {
      const id = needTab();
      return String(await browserBridge.call('click', { tabId: id, ref: t.ref, selector: t.selector, text: t.text }, { timeoutMs: 30_000 }));
    },
    async fill(t: { ref?: string; selector?: string; text: string; submit?: boolean; clear?: boolean }): Promise<string> {
      const id = needTab();
      return String(await browserBridge.call('type', {
        tabId: id, ref: t.ref, selector: t.selector, text: t.text, submit: t.submit === true, clear: t.clear !== false
      }, { timeoutMs: 30_000 }));
    },
    async press(key: string): Promise<string> {
      const id = needTab();
      return String(await browserBridge.call('press', { tabId: id, key }, { timeoutMs: 30_000 }));
    },
    async scroll(o: { direction?: string; amount?: number }): Promise<string> {
      const id = needTab();
      return String(await browserBridge.call('scroll', { tabId: id, direction: o.direction, amount: o.amount }, { timeoutMs: 30_000 }));
    },
    async waitFor(o: { text?: string; selector?: string; url?: string; timeoutMs?: number }): Promise<string> {
      const id = needTab();
      return String(await browserBridge.call('wait', {
        tabId: id, text: o.text, selector: o.selector, url: o.url, timeoutMs: o.timeoutMs
      }, { timeoutMs: Math.max(5_000, Number(o.timeoutMs) || 8_000) + 5_000 }));
    },
    async evaluate(expression: string): Promise<string> {
      const id = needTab();
      const r = await browserBridge.call<any>('evaluate', { tabId: id, expression }, { timeoutMs: 30_000 });
      // 与内置预览保持一致:返回 JSON 字符串
      return typeof r === 'string' ? r : JSON.stringify(r ?? null);
    },
    async screenshot(o?: { fullPage?: boolean }): Promise<Buffer> {
      const id = needTab();
      const b64 = String(await browserBridge.call('screenshot', { tabId: id, fullPage: o?.fullPage === true }, { timeoutMs: 45_000 }));
      return Buffer.from(b64, 'base64');
    },
    async close(): Promise<void> {
      const id = needTab();
      await browserBridge.call('tabs.close', { tabId: id }, { timeoutMs: 20_000 });
      browserBridge.revoke(id);
      forgetNativeTab(id);
    }
  };
  return ops as BrowserOps;
}
