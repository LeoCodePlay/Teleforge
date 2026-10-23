// 浏览器后端抽象层:把两种"浏览器"收敛成同一套操作接口。
//
//   preview —— 内置预览:core/browser-manager.ts 用 Playwright 拉起的 Chromium(兜底,用户零配置)
//   native  —— 真机浏览器:core/browser-bridge.ts 桥接到用户本机 Chrome/Edge 里的扩展(带登录态)
//
// agent/browser-tools.ts 的 11 个工具因此只写一份逻辑,路由规则见那边的 resolveOps():
// 「扩展在线 → 真机;否则 → 内置预览」,显式传 target 可覆盖。
//
// 真机侧可能同时有多台浏览器(Chrome + Edge 各装一份扩展,见 core/browser-bridge.ts 的连接表)。
// 因此这里所有 native 入口都带一个可选的 instance(浏览器实例 id):
//   - 传了 → 就操作那一台;
//   - 没传 → 用桥接层的默认目标,并把"这台"固定到本次调用(避免同一轮里换目标)。
// tabId 在多浏览器之间会重复(两边都从 1 编号),所以对外 id 里编入实例: native:<实例>:tab:<tabId>。
//
// 快照格式刻意统一:真机侧只回传 SNAPSHOT_SCRIPT 的原始 JSON,由服务端复用 formatSnapshot 渲染,
// 两种后端给模型的文本逐字一致 —— 模型不需要学两套页面描述。
import { browserManager, formatSnapshot } from '../core/browser-manager.ts';
import type { BatchResult, BatchStep, SnapshotOptions } from '../core/browser-manager.ts';
import { browserBridge } from '../core/browser-bridge.ts';
import type { BridgeStatus, ExtTab } from '../core/browser-bridge.ts';

export type BackendKind = 'native' | 'preview' | 'ego';

/** 与 BrowserState 取交集的最小状态(两种后端都能提供) */
export interface TargetState {
  url: string;
  title: string;
  error: string | null;
}

export interface BrowserOps {
  kind: BackendKind;
  /** 稳定标识:native = native:[<实例>:]tab:<tabId>,preview = 预览标签 id(如 s_xxx:1) */
  id: string;
  /** 当前目标标签(仅 native 有意义;未指定时为 null,执行时回落到活动标签) */
  tabId: number | null;
  state(): TargetState | null;
  openUrl(url: string, opts?: { width?: number; height?: number; focus?: boolean }): Promise<TargetState>;
  navigate(url: string): Promise<TargetState>;
  snapshot(opts?: SnapshotOptions): Promise<string>;
  click(t: { ref?: string; selector?: string; text?: string }): Promise<string>;
  fill(t: { ref?: string; selector?: string; text: string; submit?: boolean; clear?: boolean }): Promise<string>;
  press(key: string): Promise<string>;
  scroll(o: { direction?: string; amount?: number }): Promise<string>;
  waitFor(o: { text?: string; selector?: string; url?: string; timeoutMs?: number }): Promise<string>;
  evaluate(expression: string): Promise<string>;
  screenshot(o?: { fullPage?: boolean; overlay?: boolean }): Promise<Buffer>;
  close(): Promise<void>;
  /** 通用动作(hover/dblclick/rightClick/select/upload/dialog/console/networkIdle/text/assert);两种后端同一套 action 名 */
  act(action: string, params?: Record<string, unknown>): Promise<string>;
  /** 一次跑多步:真机走扩展的一条 batch 指令(一次 WS 往返),预览在本机循环 */
  batch(steps: BatchStep[], opts?: { stopOnError?: boolean; snapshot?: 'always' | 'on_error' | 'never' }): Promise<BatchResult>;
}

/** 真机浏览器的目标标识(带前缀,和预览 id 一眼可分) */
export function nativeIdOf(tabId: number): string {
  return `native:tab:${tabId}`;
}

/** 带浏览器实例的目标标识:多浏览器时靠它区分两台机器上同号的标签 */
export function nativeIdFor(instance: string | null | undefined, tabId: number): string {
  const inst = String(instance || '').trim();
  return inst ? `native:${inst}:tab:${tabId}` : nativeIdOf(tabId);
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
    snapshot: (opts) => browserManager.snapshot(id, sid, opts),
    click: (t) => browserManager.click(id, t, sid),
    fill: (t) => browserManager.fill(id, t, sid),
    press: (k) => browserManager.press(id, k, sid),
    scroll: (o) => browserManager.scroll(id, o, sid),
    waitFor: (o) => browserManager.waitFor(id, o, sid),
    evaluate: (e) => browserManager.evaluate(id, e, sid),
    screenshot: (o) => browserManager.screenshot(id, o || {}, sid),
    close: () => browserManager.close(id, sid),
    async act(action, params = {}) {
      switch (String(action || '').toLowerCase()) {
        case 'hover': return browserManager.hover(id, params as any, sid);
        case 'dblclick': return browserManager.dblclick(id, params as any, sid);
        case 'rightclick': return browserManager.rightClick(id, params as any, sid);
        case 'select': return browserManager.selectOption(id, params as any, sid);
        case 'upload': return browserManager.uploadFiles(id, params as any, sid);
        case 'dialog': return browserManager.dialog(id, params as any, sid);
        case 'console': case 'logs': return browserManager.logs(id, sid);
        case 'networkidle': return browserManager.networkIdle(id, params as any, sid);
        case 'text': return browserManager.pageText(id, params as any, sid);
        case 'assert': return browserManager.assertText(id, params as any, sid);
        case 'click': return browserManager.click(id, params as any, sid);
        case 'type': case 'fill': return browserManager.fill(id, params as any, sid);
        case 'press': return browserManager.press(id, String((params as any)?.key || 'Enter'), sid);
        case 'scroll': return browserManager.scroll(id, params as any, sid);
        default: throw new Error(`未知动作:${action}`);
      }
    },
    async batch(steps, opts = {}) {
      const r = await browserManager.batch(id, steps, sid, { stopOnError: opts.stopOnError !== false });
      const policy = opts.snapshot || 'on_error';
      if (policy === 'always' || (policy === 'on_error' && !r.ok)) {
        r.snapshot = await browserManager.snapshot(id, sid, {}).catch((e) => `(快照失败:${e?.message || e})`);
      }
      return r;
    }
  };
}

// ---------------- 真机浏览器后端 ----------------

export function nativeAvailable(hint?: string | null): boolean {
  return browserBridge.isOnline(hint);
}

export function nativeStatus(hint?: string | null): BridgeStatus {
  return browserBridge.status(hint);
}

/** 某台浏览器上未显式指定 tab_id 时的默认目标:当前活动标签(退而求其次取第一个) */
export function activeNativeTab(hint?: string | null): ExtTab | null {
  const st = browserBridge.status(hint);
  return st.tabs.find((t) => t.active) || st.tabs[0] || null;
}

/**
 * 会话 ↔ (浏览器实例, 标签) 的绑定:一个对话固定操控它自己那个标签。
 *
 * 为什么需要:resolveOps() 每次工具调用都会新建一个 ops(闭包里的 cur 只在这一次调用内有效),
 * 所以"没传 tab_id"时旧实现只能回落到**当前活动标签** —— 也就是用户此刻正在看的那个。
 * 用户随手切一下标签,AI 下一步就可能对着别的标签快照/点击:默认 ai-tabs 模式下会被
 * canOperate 拒掉变成一步失败,mode=all 或用户授权过那个标签时更会真的操作错标签。
 * 绑定之后,用户怎么切标签(甚至两台浏览器同时开着)都不改变 AI 的目标。
 */
const sessionTargets = new Map<string, { instance: string | null; tabId: number }>();

/** 记住「这个对话在操作哪台浏览器的哪个标签」(browser_open 开新标签后调用) */
export function rememberNativeTab(sid: string | null, tabId: number, instance: string | null = null): void {
  if (sid && Number.isFinite(tabId)) sessionTargets.set(sid, { instance, tabId });
}

/**
 * 标签被关掉时解除绑定,避免会话一直指着一个不存在的标签。
 * 不传 instance = 所有浏览器上的这个 tabId 都解绑;传了就只解绑那一台。
 */
export function forgetNativeTab(tabId: number, instance?: string | null): void {
  const wantInstance = String(instance || '');
  for (const [sid, t] of sessionTargets) {
    if (t.tabId !== tabId) continue;
    if (instance !== undefined && String(t.instance || '') !== wantInstance) continue;
    sessionTargets.delete(sid);
  }
}

/**
 * 取本会话绑定的 (浏览器实例, 标签)。标签已被用户关掉(或扩展重连后清单里没了)就忘掉它并返回 null ——
 * 不返回过期 id,让调用方走回退逻辑,而不是拿着一个死 tabId 去撞"无法调试标签"。
 */
export function sessionNativeTarget(sid: string | null): { instance: string | null; tabId: number } | null {
  if (!sid) return null;
  const t = sessionTargets.get(sid);
  if (!t) return null;
  const st = browserBridge.status(t.instance);
  if (st.online && st.tabs.some((x) => x.tabId === t.tabId)) return t;
  sessionTargets.delete(sid);
  return null;
}

/** 给模型看的真机状况:有哪些浏览器在线、默认是哪台、这台上有哪些标签 */
export function nativeInventory(hint?: string | null): Record<string, unknown> {
  const st = browserBridge.status(hint);
  if (!st.online) {
    return { backend: 'native', extensionOnline: false, extensionError: st.error || null };
  }
  return {
    backend: 'native',
    extensionOnline: true,
    extensionVersion: st.version,
    /** 这次调用落在哪台浏览器上(要换一台就在工具参数里传 browser) */
    browser: st.browser,
    browserId: st.id,
    browserLabel: st.label,
    /** 同时在线的全部浏览器(多台时靠 id / 内核名指定) */
    browsers: st.connections.map((c) => ({
      id: c.id, browser: c.browser, label: c.label, version: c.version,
      tabs: c.tabCount, mode: c.mode, default: c.id === st.id
    })),
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
 * sid 用来把「这次操作的是哪台浏览器的哪个标签」记到会话上(见 rememberNativeTab)。
 */
export function nativeOpsFor(tabId: number | null, sid: string | null = null, instance: string | null = null): BrowserOps {
  // 一进就把实例定下来:同一轮里 tab.open / snapshot / click 必须落在同一台浏览器上
  const wanted = String(instance || '').trim();
  const inst: string | null = browserBridge.resolveInstanceId(instance);
  /** 显式点名了一台不存在的浏览器:必须明确报错,不能悄悄退回默认目标(会操作错浏览器) */
  const missReason = wanted && !inst ? `找不到在线的浏览器「${wanted}」。${browserBridge.availableHint()}` : '';
  let cur: number | null = tabId;

  /** 解析出本次操作的目标标签,并做授权校验(未授权一律拒绝,不给"顺手就操作了"的机会) */
  const needTab = (): number => {
    if (missReason) throw new Error(missReason);
    const id = cur ?? activeNativeTab(inst)?.tabId ?? null;
    if (id == null) {
      throw new Error('真机浏览器里没有可操作的标签:先用 browser_open 打开一个地址,或让用户在浏览器里打开一个页面后重试');
    }
    const chk = browserBridge.canOperate(id, inst);
    if (!chk.ok) throw new Error(chk.reason);
    return id;
  };
  const send = <T = any>(method: string, params: Record<string, unknown>, timeoutMs: number) => {
    if (missReason) return Promise.reject(new Error(missReason));
    return browserBridge.call<T>(method, params, { timeoutMs, instance: inst });
  };
  /** 协议版本闸门:新服务端 + 旧扩展时给出"去更新扩展"的明确说明,而不是"未知方法:batch" */
  const ensureProtocol = (min: number, what: string) => {
    const st = browserBridge.status(inst);
    const p = Number(st.protocolVersion) || 1;
    if (p < min) {
      throw new Error(`${what}需要浏览器扩展 1.1.0+(协议 v${min}),当前连接的是 v${st.version || '未知'}(协议 v${p})。`
        + '请到 chrome://extensions(Edge 是 edge://extensions)点 Teleforge Auto 卡片上的「重新加载」,或重新下载最新版扩展。');
    }
  };

  const ops = {
    kind: 'native' as const,
    get id() { return cur != null ? nativeIdFor(inst, cur) : 'native:active'; },
    get tabId() { return cur; },
    state(): TargetState | null {
      const st = browserBridge.status(inst);
      const t = cur != null ? st.tabs.find((x) => x.tabId === cur) : (st.tabs.find((x) => x.active) || null);
      return t ? { url: t.url, title: t.title, error: null } : null;
    },
    async openUrl(url: string, opts?: { focus?: boolean }): Promise<TargetState> {
      if (missReason) throw new Error(missReason);
      // 开标签 + 标记"AI 自建" + 落盘授权,在桥接层一次做完(见 BrowserBridge.openTab)。
      // 不在上层用 tabId 反查连接:那样在清单未刷新 / 多浏览器并存时会标错连接,
      // 结果就是"AI 刚开的标签没有授权"。
      const r = await browserBridge.openTab(url, { instance: inst, active: opts?.focus === true });
      const newId = Number(r?.tabId);
      if (Number.isFinite(newId)) {
        cur = newId;
        // 这个对话从此固定操控这个标签:用户之后怎么切标签都不会改变 AI 的目标
        rememberNativeTab(sid, newId, inst);
      }
      return { url: r.url, title: r.title, error: null };
    },
    async navigate(url: string): Promise<TargetState> {
      const id = needTab();
      const r = await send<any>('navigate', { tabId: id, url }, 60_000);
      return { url: String(r?.url || url), title: String(r?.title || ''), error: r?.error ? String(r.error) : null };
    },
    async snapshot(opts?: SnapshotOptions): Promise<string> {
      const id = needTab();
      const raw = await send<any>('snapshot', {
        tabId: id,
        scope: opts?.scope,
        root: opts?.root,
        text: opts?.text,
        max: opts?.max,
        frames: opts?.frames
      }, 30_000);
      // 新扩展回结构化数据(v2);万一遇到只回文本的旧扩展,原样透传,不至于变成 "[object Object]"
      return typeof raw === 'string' ? raw : formatSnapshot(raw);
    },
    async click(t: { ref?: string; selector?: string; text?: string }): Promise<string> {
      const id = needTab();
      return String(await send('click', { tabId: id, ref: t.ref, selector: t.selector, text: t.text }, 30_000));
    },
    async fill(t: { ref?: string; selector?: string; text: string; submit?: boolean; clear?: boolean }): Promise<string> {
      const id = needTab();
      return String(await send('type', {
        tabId: id, ref: t.ref, selector: t.selector, text: t.text, submit: t.submit === true, clear: t.clear !== false
      }, 30_000));
    },
    async press(key: string): Promise<string> {
      const id = needTab();
      return String(await send('press', { tabId: id, key }, 30_000));
    },
    async scroll(o: { direction?: string; amount?: number }): Promise<string> {
      const id = needTab();
      return String(await send('scroll', { tabId: id, direction: o.direction, amount: o.amount }, 30_000));
    },
    async waitFor(o: { text?: string; selector?: string; url?: string; timeoutMs?: number }): Promise<string> {
      const id = needTab();
      return String(await send('wait', {
        tabId: id, text: o.text, selector: o.selector, url: o.url, timeoutMs: o.timeoutMs
      }, Math.max(5_000, Number(o.timeoutMs) || 8_000) + 5_000));
    },
    async evaluate(expression: string): Promise<string> {
      const id = needTab();
      const r = await send<any>('evaluate', { tabId: id, expression }, 30_000);
      // 与内置预览保持一致:返回 JSON 字符串
      return typeof r === 'string' ? r : JSON.stringify(r ?? null);
    },
    async screenshot(o?: { fullPage?: boolean; overlay?: boolean }): Promise<Buffer> {
      const id = needTab();
      const b64 = String(await send('screenshot', { tabId: id, fullPage: o?.fullPage === true, overlay: o?.overlay === true }, 45_000));
      return Buffer.from(b64, 'base64');
    },
    /** 通用动作:扩展侧的 act 分发(hover/dblclick/rightClick/select/upload/dialog/console/networkIdle/text/assert) */
    async act(action: string, params: Record<string, unknown> = {}): Promise<string> {
      const id = needTab();
      ensureProtocol(2, '通用动作(browser_act)');
      const r = await send<any>('act', { tabId: id, action: String(action || ''), ...params }, 45_000);
      return typeof r === 'string' ? r : JSON.stringify(r ?? '');
    },
    /** 批处理:整段流程只走一次 WS 往返(这是相对"一步一次工具调用"最大的提速点) */
    async batch(steps: BatchStep[], opts: { stopOnError?: boolean; snapshot?: 'always' | 'on_error' | 'never' } = {}): Promise<BatchResult> {
      const id = needTab();
      ensureProtocol(2, '批处理(browser_batch)');
      const r = await send<any>('batch', {
        tabId: id, steps, stopOnError: opts.stopOnError !== false, snapshot: opts.snapshot || 'on_error'
      }, 180_000);
      // 扩展只回原始快照数据(与内置预览跑同一份脚本),文本统一在服务端渲染
      if (r && r.snapshotData) {
        r.snapshot = formatSnapshot(r.snapshotData);
        delete r.snapshotData;
      }
      return r as BatchResult;
    },
    async close(): Promise<void> {
      const id = needTab();
      await send('tabs.close', { tabId: id }, 20_000);
      browserBridge.noteClosedTab(id, inst);
      browserBridge.revoke(id, inst);
      forgetNativeTab(id, inst);
    }
  };
  return ops as BrowserOps;
}
