// AI 浏览器工具集:让 Agent 真正「操控」前端那个浏览器预览标签(同一份会话、同一个页面)。
// 与 run_command 等工具的区别:这些工具操作的是本机 Playwright 驱动的真实 Chromium,
// 不依赖 SSH;地址解析会用 port-tunnel 在需要时自动建 SSH 隧道,让远程开发服务也能预览。
//
// 归属规则(一个预览浏览器 ↔ 一个对话,见 core/browser-manager.ts 文件头):
//   - 工具不传 browser_id 时,自动定位「本会话自己的预览」;本会话还没有预览就新建一个,
//     所以模型永远不需要记 id,也不会(也不可能)动到别的对话的预览;
//   - 传了别的会话的 browser_id 会被明确拒绝,并告诉模型自己有哪些预览可用。
//
// 设计取舍:AI 拿到的不是截图而是「结构化文本快照」(+ 可选的截图附件)。
// 纯文本模型无法内联看图,而带 ref 的快照能精确点击/输入,比像素坐标稳得多。
import { browserManager, defaultBrowserIdFor, normalizePreviewUrl, ownerFromBrowserId } from '../core/browser-manager.ts';
import { nativeAvailable, nativeInventory, nativeOpsFor, previewOps, sessionNativeTarget } from './browser-backends.ts';
import { egoOps } from './ego-backend.ts';
import type { BrowserOps } from './browser-backends.ts';
import { resolvePreviewUrl } from '../core/port-tunnel.ts';
import { saveAttachment, attachmentUrl } from '../store/attachments-store.ts';
import { rememberLearning, listLearnings, forgetLearning, learningHint } from '../core/browser-memory.ts';
import { auditBrowser } from '../core/browser-audit.ts';
import type { BatchStep } from '../core/browser-manager.ts';
import type { ToolDef } from './registry.ts';

/** 兜底会话 id:没有会话上下文(如旧路径直接调用工具)时,行为与旧版共享预览一致 */
const LEGACY_BROWSER_ID = 'main';

/** browser_id 参数的统一说明:省略 = 本会话自己的预览(多开时按打开顺序取第一个) */
const BROWSER_ID_DESC = '预览标签 id;省略 = 本会话自己的预览(同一会话里开了多个预览时按打开顺序取第一个)。'
  + '同一个会话可多开预览:传一个新的 id(如 "<会话id>:2")即可新开一个';

/** 调用方会话 id(run 的第二参数由 agent 注入,见 registry.ts 的 invokeCtx) */
function callerSid(invokeCtx: any): string | null {
  const sid = String(invokeCtx?.sid ?? '').trim();
  return sid && sid !== LEGACY_BROWSER_ID ? sid : null;
}

/** 该会话现有的预览(按创建顺序),用于"我有哪些预览"的提示与空闲 id 分配 */
function ownedPreviews(sid: string | null) {
  return sid ? browserManager.listFor(sid) : [];
}

/** 本会话的预览清单(工具结果里回带,模型每步都知道自己有哪些预览可用) */
function previewInventoryMeta(sid: string | null) {
  if (!sid) return {};
  return {
    ownerSid: sid,
    previews: ownedPreviews(sid).map((b) => ({ id: b.id, url: b.url, title: b.title }))
  };
}

/** 给模型看的一句话清单 */
function describePreviews(sid: string | null): string {
  const list = ownedPreviews(sid);
  if (!list.length) return '本会话当前还没有预览浏览器(可用 browser_open 新开一个)。';
  return '本会话的预览浏览器:\n' + list
    .map((b) => `- ${b.id} → ${b.url || '(未打开地址)'}${b.title ? ` 「${b.title}」` : ''}`)
    .join('\n');
}

/** 会话内多开时的下一个空闲预览 id(:1 已被占用则 :2、:3 …) */
function nextBrowserId(sid: string): string {
  const used = new Set(browserManager.listFor(sid).map((b) => b.id));
  for (let n = 1; n < 100; n++) {
    const id = `${sid}:${n}`;
    if (!used.has(id)) return id;
  }
  return `${sid}:${Date.now().toString(36)}`;
}

/**
 * 决定这次调用该作用在哪个预览浏览器上。
 * opts.preferOwn = true(打开/导航这类写入):没有现成预览就按会话分配一个新 id(创建在 browserManager.open 里完成);
 * false(快照/点击这类读取):没有预览就明确报错,而不是悄悄开一个空白预览。
 */
function resolveBrowserId(args: any, invokeCtx: any, opts: { preferOwn?: boolean } = {}): string {
  const sid = callerSid(invokeCtx);
  const raw = String(args?.browser_id || '').trim();
  if (raw) {
    const owner = ownerFromBrowserId(raw);
    if (sid && owner && owner !== sid) {
      throw new Error(`预览「${raw}」属于另一个会话(${owner}),本会话无权操作。\n${describePreviews(sid)}\n`
        + `请改用本会话自己的 browser_id,不要传别的会话的预览 id。`);
    }
    return raw;
  }
  if (sid) {
    const own = ownedPreviews(sid);
    if (own.length) return own[0].id;
    if (opts.preferOwn) return defaultBrowserIdFor(sid);
    throw new Error(`本会话还没有打开浏览器预览。先调用 browser_open 打开一个地址,再用其它 browser_* 工具操作它。`);
  }
  return LEGACY_BROWSER_ID;
}

/** 真机浏览器相关的工具参数说明(所有 browser_* 工具共用) */
const TARGET_DESC = '作用在哪个浏览器上:auto(默认)= 有扩展连接就用本机真机浏览器,否则用内置预览;'
  + 'native = 强制真机浏览器(未连接会直接报错);preview = 强制内置预览浏览器;'
  + 'ego = 用 ego(lite) 浏览器(需本机安装了 ego lite,任务跑在它自己的 Space 里)';
/** 同时开着多台真机浏览器(Chrome + Edge)时,用这个参数指定操作哪一台 */
const BROWSER_DESC = '真机浏览器实例:填内核名 chrome / edge,或填连接 id(结果里 browsers[].id;'
  + '两台都是同款浏览器时用它区分)。省略 = 本对话已绑定的那台,其次默认目标那台。'
  + '当前有哪些可选、默认是哪台,见 browser_* 工具返回里的 browsers / browserLabel';
const TAB_ID_DESC = '真机浏览器的标签 id(来自 browser_open 的返回或 ext_status 的标签清单;'
  + 'id 只在同一台浏览器内唯一,跨浏览器用 browser 参数区分)。'
  + '省略 = 本对话正在操作的那个标签(browser_open 打开后自动绑定,用户切标签也不会改变它);'
  + '本对话还没绑定过标签时才回落到浏览器当前活动标签。仅 target=native 时有意义';

/**
 * 选择这次调用作用在哪个浏览器上(两种后端见 agent/browser-backends.ts)。
 * - 显式 target 优先;browser_id 以 native: 开头也视为真机;
 * - 默认 auto:扩展在线 → 真机,否则 → 内置预览 —— 用户没装扩展时行为与改动前完全一致。
 */
function resolveOps(args: any, ctx: any, opts: { preferOwn?: boolean } = {}): BrowserOps {
  const want = String(args?.target || '').trim().toLowerCase();
  const rawBrowserId = String(args?.browser_id || '').trim();
  const browserHint = String(args?.browser || '').trim();
  // ego(lite) 必须显式指定:机器上装了 ego 不代表用户想让 AI 用它
  if (want === 'ego' || rawBrowserId.startsWith('ego:')) {
    return egoOps({ sid: callerSid(ctx), url: args?.url });
  }
  const forceNative = want === 'native' || rawBrowserId.startsWith('native:') || !!browserHint;
  const forcePreview = want === 'preview';
  if (!forcePreview && (forceNative || nativeAvailable())) {
    const sid = callerSid(ctx);
    const rawTab = args?.tab_id ?? args?.tabId;
    /** 要操作哪台真机浏览器:显式 browser 参数 > 会话绑定 > 桥接层默认目标 */
    let instance: string | null = browserHint || null;
    let tabId: number | null = null;
    if (rawTab !== undefined && rawTab !== null && rawTab !== '') {
      tabId = Number(rawTab);
      if (!Number.isFinite(tabId)) throw new Error(`tab_id 必须是数字(收到 ${rawTab})`);
    } else if (rawBrowserId.startsWith('native:')) {
      // native:<实例>:tab:<tabId>(多浏览器) | native:tab:<tabId>(旧格式) | native:active
      const m = /^native:([^:]+):tab:(\d+)$/.exec(rawBrowserId);
      if (m) {
        tabId = Number(m[2]);
        if (!instance && m[1] !== 'active') instance = m[1];
      } else if (rawBrowserId.startsWith('native:tab:')) {
        tabId = Number(rawBrowserId.slice('native:tab:'.length));
      }
      if (tabId !== null && !Number.isFinite(tabId)) tabId = null;
    } else {
      // 没显式指定:用本对话绑定的标签。**不能**回落到"当前活动标签" ——
      // 那是用户正在看的标签,用户随手一切就会把 AI 的目标带跑偏。
      // 绑定只在"没指定浏览器,或指定的就是绑定的那台"时才沿用:tabId 在不同浏览器之间会重复。
      const bound = sessionNativeTarget(sid);
      const sameInstance = !!bound && !!bound.instance && !!instance
        && (bound.instance === instance || bound.instance.startsWith(instance));
      if (bound && (!instance || sameInstance)) {
        tabId = bound.tabId;
        if (!instance) instance = bound.instance;
      }
    }
    return nativeOpsFor(tabId, sid, instance);
  }
  return previewOps(resolveBrowserId(args, ctx, opts), callerSid(ctx));
}

/** 工具结果里回带的"我现在能操作哪些浏览器目标":真机列标签,预览列预览 */
function inventoryMeta(sid: string | null, kind: string): Record<string, unknown> {
  if (kind === 'ego') return { backend: 'ego' };
  return kind === 'native' ? nativeInventory() : previewInventoryMeta(sid);
}

/** 工具返回的统一结构:正文 + 浏览器卡 UI 数据 */
function browserMeta(extra: Record<string, unknown> = {}) {
  return { card: 'browser', ...extra };
}

/**
 * 动作回执:默认只回"现在在哪",不再每步附带一份全量快照。
 * 快照是 token 大头(单份 2~5k),而"点完要不要再看页面"模型自己知道 —— 要看就显式 snapshot。
 */
function receipt(st: { url?: string; title?: string } | null | undefined, snap?: string): string {
  const line = `\n当前页面:${st?.url || '(未知地址)'}${st?.title ? ` 「${st.title}」` : ''}`;
  if (snap) return `${line}\n\n${snap}`;
  return `${line}\n(需要看页面时调用 browser_snapshot;连续多步请用 browser_batch 一次跑完)`;
}

async function openTarget(args: any, { emit, sid: callSid }: any) {
  const raw = String(args?.url || '').trim();
  if (!raw) throw new Error('url 不能为空,请给出形如 http://localhost:5173 的项目地址');
  // 真机浏览器:直接开新标签,不走 resolvePreviewUrl —— 端口探测与 SSH 隧道是内置预览的能力,
  // 用户自己的浏览器访问的就是他这台机器的 localhost。
  const ops = resolveOps(args, { sid: callSid }, { preferOwn: true });
  if (ops.kind === 'ego') {
    // ego(lite) 是用户本机的浏览器:和真机一样不走端口探测/SSH 隧道
    const st = await ops.openUrl(raw);
    return { target: { url: raw, direct: raw, tunneled: false, note: null }, id: ops.id, state: st, ops };
  }
  if (ops.kind === 'native') {
    const st = await ops.openUrl(raw, { focus: args?.focus === true });
    return { target: { url: raw, direct: raw, tunneled: false, note: null }, id: ops.id, state: st, ops };
  }
  const tunnel = args?.tunnel === true ? true : args?.tunnel === false ? false : undefined;
  let target;
  try {
    target = await resolvePreviewUrl(raw, { tunnel });
  } catch (e: any) {
    // 地址解析阶段就已确定失败(远程与本机都没有服务监听该端口,见 core/port-tunnel.ts):
    // 直接把可操作的诊断交给模型,别让它再去 browser_open 撞一次(以前这里会变成
    // 一个浏览器侧的"空响应"错误,模型和用户都看不出真正原因)。
    throw new Error(`${e?.message || e}\n`
      + '请先用 run_command 的 background=true 在远程工作区把项目启动为「运行终端」(不要用 nohup … &;输出会实时显示给用户),'
      + '用 `ss -lntp | grep <端口>` 确认端口在监听后重试 browser_open。');
  }
  const id = ops.id;
  const owner = ownerFromBrowserId(id) || callSid;
  const state = await browserManager.open({
    id, url: target.url, width: args?.width, height: args?.height, ownerSid: owner
  });
  // 通知前端打开/激活预览标签(用户点一下地址即可看到画面)
  emit?.('agent', {
    event: 'browser_open', sid: callSid, id,
    url: target.url, direct: target.direct, tunneled: target.tunneled, note: target.note || null,
    ownerSid: state.ownerSid
  });
  return { target, id, state, ops };
}

export const browserToolDefs: ToolDef[] = [
  {
    name: 'browser_open',
    description: 'Open (or reuse) the browser preview tab and navigate to a URL, then return a text snapshot of '
      + 'the loaded page. Use it right after starting a dev server (npm run dev / vite / next dev …) and a '
      + 'localhost address is printed, so the user can look at the running project in the preview tab. '
      + 'When connected to an SSH server the loopback address is automatically tunneled to the remote host '
      + '(pass tunnel=false to force a direct connection). After opening, use browser_snapshot / browser_click / '
      + 'browser_type to drive the page and verify the UI actually works. '
      + 'In the user\'s real browser (extension connected) this opens a new tab and binds this conversation to it: '
      + 'later browser_* calls without tab_id keep targeting that same tab even if the user switches to another tab. '
      + 'IMPORTANT: a dev server started with a foreground run_command is KILLED when that tool times out '
      + '(default 300s), which makes the printed address dead (ERR_CONNECTION_REFUSED). Start it as a managed '
      + 'running terminal instead: call run_command with background=true (do NOT use nohup ... &). The process keeps '
      + 'running, its output streams live into the user\'s "running terminals" panel, and stop_project_terminal can stop it. Confirm the port is '
      + 'and retry.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要预览的地址,如 http://localhost:5173 或 localhost:3000' },
        browser_id: { type: 'string', description: '预览标签 id;省略 = 本会话自己的预览(同一会话里已开多个预览时按打开顺序取第一个)。'
          + '同一会话可多开预览:传一个新的 id(如 "<会话id>:2")即可新开一个' },
        tunnel: { type: 'boolean', description: '是否强制走 SSH 隧道映射远程端口;省略=回环地址且已连 SSH 时自动隧道' },
        target: { type: 'string', enum: ['auto', 'native', 'preview', 'ego'], description: TARGET_DESC },
        browser: { type: 'string', description: BROWSER_DESC },
        tab_id: { type: 'integer', description: TAB_ID_DESC },
        focus: { type: 'boolean', description: '真机浏览器:是否把新标签切到前台并抢焦点。默认 false(不打断用户);'
          + '需要用户看着 AI 操作时传 true' },
        width: { type: 'integer', description: '视口宽度,默认 1280' },
        height: { type: 'integer', description: '视口高度,默认 800' }
      },
      required: ['url']
    },
    access: 'write',
    timeoutMs: 90_000,
    mutating: true,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const { target, id, state, ops } = await openTarget(args, ctx);
      const snap = await ops.snapshot().catch((e) => `(快照失败:${e.message})`);
      const head = [ops.kind === 'native'
        ? `已在真机浏览器打开:${state.url}`
        : `已在浏览器预览中打开:${state.url}`];
      if (target.tunneled) head.push(target.note || '已建立 SSH 隧道');
      else if (target.direct !== state.url) head.push(`原始地址 ${target.direct}`);
      if (state.error) {
        head.push(`⚠ 页面没能加载:${state.error}`);
        head.push('若这个地址来自前台 run_command,dev server 很可能已被工具超时终止(默认 300s)。'
          + '请改用 run_command(background=true)重启为「运行终端」,确认端口在监听后再 browser_open。');
      } else {
        head.push(ops.kind === 'native' ? '已在本机浏览器里打开该标签,用户能直接看到。' : '用户已能在「浏览器预览」标签里看到该页面。');
      }
      return {
        content: head.join('\n') + '\n\n' + snap + learningHint(state.url),
        meta: browserMeta({
          backend: ops.kind, browserId: id, url: state.url, direct: target.direct,
          tunneled: target.tunneled, note: target.note || null, title: state.title,
          ...inventoryMeta(sid, ops.kind)
        })
      };
    }
  },

  {
    name: 'browser_snapshot',
    description: 'Return a structured text snapshot of the page: interactive elements with STABLE refs (like e3f9a — '
      + 'the same element keeps its ref across snapshots), headings as structure, open shadow DOM content, and '
      + 'sub-frames (refs there look like f1:e3f9a and are clickable the same way). '
      + 'Call it before clicking/typing to choose a target. Default scope is the viewport; pass scope=full_page for '
      + 'the whole page, or scope=subtree + root=<ref> to zoom into one region. Body text is NOT included by default '
      + '(pass text=2000 only when you actually need the prose) — this keeps snapshots small.',
    parameters: {
      type: 'object',
      properties: { browser_id: { type: 'string', description: BROWSER_ID_DESC },
        target: { type: 'string', enum: ['auto', 'native', 'preview', 'ego'], description: TARGET_DESC },
        browser: { type: 'string', description: BROWSER_DESC },
        tab_id: { type: 'integer', description: TAB_ID_DESC },
        scope: { type: 'string', enum: ['viewport', 'full_page', 'subtree'], description: '看多大范围:viewport(默认,当前视口)/ full_page(整页)/ subtree(只看 root 那棵子树)' },
        root: { type: 'string', description: 'scope=subtree 时的根:快照里的 ref(如 e3f9a)或 CSS 选择器' },
        text: { type: 'integer', description: '附带多少字正文(默认 0=不带)。需要读文章/表格内容时再传,例如 2000' },
        max: { type: 'integer', description: '节点上限,默认 160(最大 400)' },
        frames: { type: 'boolean', description: '是否连子框架一起抓(默认 true,最多 6 个)' }, }
    },
    access: 'read',
    timeoutMs: 30_000,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const ops = resolveOps(args, ctx);
      const id = ops.id;
      const snap = await ops.snapshot({
        scope: args?.scope, root: args?.root, text: args?.text, max: args?.max, frames: args?.frames !== false
      });
      const st = ops.state();
      return {
        content: snap,
        meta: browserMeta({ backend: ops.kind, browserId: id, url: st?.url || '', title: st?.title || '', ...inventoryMeta(sid, ops.kind) })
      };
    }
  },

  {
    name: 'browser_navigate',
    description: 'Navigate the browser preview to another URL (e.g. a different route/port). Returns a fresh page snapshot.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标地址' },
        browser_id: { type: 'string', description: BROWSER_ID_DESC },
        target: { type: 'string', enum: ['auto', 'native', 'preview', 'ego'], description: TARGET_DESC },
        browser: { type: 'string', description: BROWSER_DESC },
        tab_id: { type: 'integer', description: TAB_ID_DESC },
        tunnel: { type: 'boolean', description: '是否强制走 SSH 隧道;省略=自动' }
      },
      required: ['url']
    },
    access: 'write',
    timeoutMs: 90_000,
    mutating: true,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      // 真机浏览器:导航「当前正在操作的那个标签」,而不是像 browser_open 那样新开一个 ——
      // 否则模型连续 navigate 会把用户浏览器开满标签。
      const opsNav = resolveOps(args, ctx, { preferOwn: true });
      if (opsNav.kind === 'native') {
        const st = await opsNav.navigate(String(args?.url || '').trim());
        const snapNav = await opsNav.snapshot().catch(() => '');
        const warnNav = st.error ? `\n⚠ 页面没能加载:${st.error}` : '';
        return {
          content: `已导航到:${st.url}${warnNav}\n\n${snapNav}`,
          meta: browserMeta({
            backend: 'native', browserId: opsNav.id, url: st.url, title: st.title,
            ...inventoryMeta(sid, opsNav.kind)
          })
        };
      }
      const { target, id, state, ops } = await openTarget(args, ctx);
      const snap = await ops.snapshot().catch(() => '');
      const warn = state.error ? `\n⚠ 页面没能加载:${state.error}` : '';
      return {
        content: `已导航到:${state.url}${warn}\n\n${snap}`,
        meta: browserMeta({
          backend: ops.kind, browserId: id, url: state.url, direct: target.direct,
          tunneled: target.tunneled, note: target.note || null, title: state.title,
          ...inventoryMeta(sid, ops.kind)
        })
      };
    }
  },

  {
    name: 'browser_click',
    description: 'Click an element. Prefer ref from browser_snapshot (e.g. ref="e3f9a"; sub-frame refs look like '
      + '"f1:e3f9a"). selector (CSS) or text (visible label) are also accepted. '
      + 'Returns a short receipt (result + current url/title) instead of a full snapshot: call browser_snapshot when '
      + 'you need to see the page again, pass snapshot=true to include it here, or put the whole flow in browser_batch.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'browser_snapshot 返回的元素引用,如 e3f9a(子框架里的是 f1:e3f9a)' },
        selector: { type: 'string', description: 'CSS 选择器(与 ref/text 三选一)' },
        text: { type: 'string', description: '可见文本,匹配第一个包含它的元素' },
        snapshot: { type: 'boolean', description: '结果里是否附带完整快照(默认 false)' },
        browser_id: { type: 'string', description: BROWSER_ID_DESC },
        target: { type: 'string', enum: ['auto', 'native', 'preview', 'ego'], description: TARGET_DESC },
        browser: { type: 'string', description: BROWSER_DESC },
        tab_id: { type: 'integer', description: TAB_ID_DESC },
      }
    },
    access: 'write',
    timeoutMs: 60_000,
    mutating: true,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const ops = resolveOps(args, ctx);
      const id = ops.id;
      const msg = await ops.click({ ref: args?.ref, selector: args?.selector, text: args?.text });
      const snap = args?.snapshot === true ? await ops.snapshot().catch((e) => `(快照失败:${e.message})`) : '';
      const st = ops.state();
      return {
        content: `${msg}${receipt(st, snap)}`,
        meta: browserMeta({ backend: ops.kind, browserId: id, url: st?.url || '', title: st?.title || '', ...inventoryMeta(sid, ops.kind) })
      };
    }
  },

  {
    name: 'browser_type',
    description: 'Type text into an input / textarea / contenteditable (locate by ref from browser_snapshot, or a CSS '
      + 'selector). Set submit=true to press Enter afterwards. Returns a short receipt instead of a full snapshot; '
      + 'pass snapshot=true if you need the page state back.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'browser_snapshot 返回的元素引用,如 e5a1c(子框架里的是 f1:e5a1c)' },
        selector: { type: 'string', description: 'CSS 选择器(与 ref 二选一)' },
        text: { type: 'string', description: '要输入的文本' },
        clear: { type: 'boolean', description: '是否先清空原有内容,默认 true' },
        submit: { type: 'boolean', description: '输入后是否回车提交,默认 false' },
        snapshot: { type: 'boolean', description: '结果里是否附带完整快照(默认 false)' },
        browser_id: { type: 'string', description: BROWSER_ID_DESC },
        target: { type: 'string', enum: ['auto', 'native', 'preview', 'ego'], description: TARGET_DESC },
        browser: { type: 'string', description: BROWSER_DESC },
        tab_id: { type: 'integer', description: TAB_ID_DESC },
      },
      required: ['text']
    },
    access: 'write',
    timeoutMs: 60_000,
    mutating: true,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const ops = resolveOps(args, ctx);
      const id = ops.id;
      const msg = await ops.fill({
        ref: args?.ref, selector: args?.selector,
        text: String(args?.text ?? ''), clear: args?.clear, submit: args?.submit === true
      });
      const snap = args?.snapshot === true ? await ops.snapshot().catch((e) => `(快照失败:${e.message})`) : '';
      const st = ops.state();
      return {
        content: `${msg}${receipt(st, snap)}`,
        meta: browserMeta({ backend: ops.kind, browserId: id, url: st?.url || '', title: st?.title || '', ...inventoryMeta(sid, ops.kind) })
      };
    }
  },

  {
    name: 'browser_press',
    description: 'Press a single keyboard key in the browser preview (Enter, Tab, Escape, ArrowDown, Control+A …). '
      + 'Useful to submit forms or trigger shortcuts when there is no clickable element.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '按键名,如 Enter / Tab / Escape / ArrowDown / Control+A' },
        browser_id: { type: 'string', description: BROWSER_ID_DESC },
        target: { type: 'string', enum: ['auto', 'native', 'preview', 'ego'], description: TARGET_DESC },
        browser: { type: 'string', description: BROWSER_DESC },
        tab_id: { type: 'integer', description: TAB_ID_DESC },
      },
      required: ['key']
    },
    access: 'write',
    timeoutMs: 30_000,
    mutating: true,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const ops = resolveOps(args, ctx);
      const id = ops.id;
      return {
        content: await ops.press(String(args?.key || 'Enter')),
        meta: browserMeta({ backend: ops.kind, browserId: id, ...inventoryMeta(sid, ops.kind) })
      };
    }
  },

  {
    name: 'browser_scroll',
    description: 'Scroll the browser preview page up or down.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['down', 'up'], description: '滚动方向,默认 down' },
        amount: { type: 'integer', description: '滚动像素,默认 600' },
        browser_id: { type: 'string', description: BROWSER_ID_DESC },
        target: { type: 'string', enum: ['auto', 'native', 'preview', 'ego'], description: TARGET_DESC },
        browser: { type: 'string', description: BROWSER_DESC },
        tab_id: { type: 'integer', description: TAB_ID_DESC },
      }
    },
    access: 'write',
    timeoutMs: 30_000,
    mutating: true,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const ops = resolveOps(args, ctx);
      const id = ops.id;
      return {
        content: await ops.scroll({ direction: args?.direction, amount: args?.amount }),
        meta: browserMeta({ backend: ops.kind, browserId: id, ...inventoryMeta(sid, ops.kind) })
      };
    }
  },

  {
    name: 'browser_wait',
    description: 'Wait until a condition holds in the browser preview: visible text, a CSS selector, or a URL pattern. '
      + 'Use it after navigation/click to let async rendering settle before taking a snapshot.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '等待这段文本出现' },
        selector: { type: 'string', description: '等待该 CSS 选择器可见' },
        url: { type: 'string', description: '等待 URL 匹配(支持通配,如 **/dashboard)' },
        timeout_ms: { type: 'integer', description: '超时毫秒,默认 8000,最大 60000' },
        browser_id: { type: 'string', description: BROWSER_ID_DESC },
        target: { type: 'string', enum: ['auto', 'native', 'preview', 'ego'], description: TARGET_DESC },
        browser: { type: 'string', description: BROWSER_DESC },
        tab_id: { type: 'integer', description: TAB_ID_DESC },
      }
    },
    access: 'read',
    timeoutMs: 70_000,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const ops = resolveOps(args, ctx);
      const id = ops.id;
      return {
        content: await ops.waitFor({
          text: args?.text, selector: args?.selector, url: args?.url, timeoutMs: args?.timeout_ms
        }),
        meta: browserMeta({ backend: ops.kind, browserId: id, ...inventoryMeta(sid, ops.kind) })
      };
    }
  },

  {
    name: 'browser_screenshot',
    description: 'Take a PNG screenshot of the current browser preview page and show it to the user in the chat '
      + '(the user sees it inline; you get the saved file path). Use it when visual appearance matters.',
    parameters: {
      type: 'object',
      properties: {
        full_page: { type: 'boolean', description: '是否整页截图(含滚动区域),默认 false 只截视口' },
        overlay: { type: 'boolean', description: '是否在截图里叠上最近一次操作的 AI 光标(让人一眼看出 AI 点了哪),默认 false' },
        browser_id: { type: 'string', description: BROWSER_ID_DESC },
        target: { type: 'string', enum: ['auto', 'native', 'preview', 'ego'], description: TARGET_DESC },
        browser: { type: 'string', description: BROWSER_DESC },
        tab_id: { type: 'integer', description: TAB_ID_DESC },
      }
    },
    access: 'read',
    timeoutMs: 60_000,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const ops = resolveOps(args, ctx);
      const id = ops.id;
      const buf = await ops.screenshot({ fullPage: args?.full_page === true, overlay: args?.overlay === true });
      const st = ops.state();
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const att = await saveAttachment(buf, `浏览器截图-${ts}.png`, 'image/png');
      return {
        content: `已截图(附件 id:${att.id},${Math.round(buf.length / 1024)}KB)。截图已内联展示给用户,不要把图片嵌入你的回复正文。`,
        // attachments:与 image/generated 同形,前端在对话里直接渲染这张截图
        // (不再只藏在折叠的工具卡里);meta.screenshot 保留给工具卡内部使用
        attachments: [att],
        meta: browserMeta({
          browserId: id, url: st?.url || '', title: st?.title || '',
          screenshot: { id: att.id, url: attachmentUrl(att.id), name: att.name },
          ...inventoryMeta(sid, ops.kind)
        })
      };
    }
  },

  {
    name: 'browser_eval',
    description: 'Evaluate a JavaScript expression inside the browser preview page and return its JSON result. '
      + 'Use it to read data (document.title, localStorage, a selector\'s text) or to assert state. '
      + 'Avoid using it to mutate the page when a click/type tool would do.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '要执行的 JS 表达式,如 document.querySelectorAll("li").length' },
        browser_id: { type: 'string', description: BROWSER_ID_DESC },
        target: { type: 'string', enum: ['auto', 'native', 'preview', 'ego'], description: TARGET_DESC },
        browser: { type: 'string', description: BROWSER_DESC },
        tab_id: { type: 'integer', description: TAB_ID_DESC },
      },
      required: ['expression']
    },
    access: 'write',
    timeoutMs: 30_000,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const ops = resolveOps(args, ctx);
      const id = ops.id;
      return {
        content: await ops.evaluate(String(args?.expression || '')),
        meta: browserMeta({ backend: ops.kind, browserId: id, ...inventoryMeta(sid, ops.kind) })
      };
    }
  },

  {
    name: 'browser_batch',
    description: 'Run a whole multi-step flow in ONE call: navigate, click, type, wait, assert, and optionally snapshot '
      + 'at the end. PREFER THIS over many browser_click/browser_type calls — one round trip instead of one per step, '
      + 'and you can express "click, wait for X, then read Y" as a single plan. Stops at the first failure by default '
      + 'and returns one line per step. Refs come from browser_snapshot (sub-frame refs look like "f1:e3f9a"). '
      + 'ops: navigate|click|type|press|scroll|hover|dblclick|rightClick|select|upload|wait|networkIdle|assert|text|eval|load',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: '按顺序执行的步骤,最多 60 步',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', description: 'navigate|click|type|press|scroll|hover|dblclick|rightClick|select|upload|wait|networkIdle|assert|text|eval|load' },
              ref: { type: 'string', description: '快照里的 ref(可带 fN: 前缀)' },
              selector: { type: 'string', description: 'CSS 选择器' },
              text: { type: 'string', description: 'type 的输入内容 / assert 要断言的文字' },
              url: { type: 'string', description: 'navigate 的地址 / wait 的 URL 通配' },
              key: { type: 'string', description: 'press 的按键,如 Enter / Control+A' },
              value: { type: 'string', description: 'select 的值 / eval 的表达式' },
              label: { type: 'string', description: 'select 按可见文本选择' },
              files: { type: 'array', items: { type: 'string' }, description: 'upload 的文件绝对路径' },
              direction: { type: 'string', enum: ['up', 'down'], description: 'scroll 方向' },
              amount: { type: 'integer', description: 'scroll 像素' },
              timeoutMs: { type: 'integer', description: 'wait 的超时毫秒' },
              submit: { type: 'boolean', description: 'type 后回车' },
              clear: { type: 'boolean', description: 'type 前清空,默认 true' }
            },
            required: ['op']
          }
        },
        stopOnError: { type: 'boolean', description: '失败即停,默认 true;false = 继续跑完并逐条报错' },
        snapshot: { type: 'string', enum: ['always', 'on_error', 'never'], description: '结束后附不附快照,默认 on_error' },
        browser_id: { type: 'string', description: BROWSER_ID_DESC },
        target: { type: 'string', enum: ['auto', 'native', 'preview', 'ego'], description: TARGET_DESC },
        browser: { type: 'string', description: BROWSER_DESC },
        tab_id: { type: 'integer', description: TAB_ID_DESC },
      },
      required: ['steps']
    },
    access: 'write',
    timeoutMs: 180_000,
    mutating: true,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const ops = resolveOps(args, ctx);
      const id = ops.id;
      const steps = normalizeSteps(args?.steps);
      const policy = args?.snapshot === 'always' || args?.snapshot === 'never' ? args.snapshot : 'on_error';
      const r = await ops.batch(steps, { stopOnError: args?.stopOnError !== false, snapshot: policy });
      const lines = r.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.index}. ${s.op} — ${s.detail}`);
      const head = r.ok
        ? `批处理完成:${r.steps.length} 步全部成功`
        : `批处理在第 ${r.failedAt} 步失败(共 ${r.steps.length} 步,${r.steps.filter((s) => s.ok).length} 步成功)`;
      const tail = `\n当前页面:${r.url || ''}${r.title ? ` 「${r.title}」` : ''}`;
      return {
        content: `${head}\n${lines.join('\n')}${tail}${r.snapshot ? `\n\n${r.snapshot}` : ''}`,
        meta: browserMeta({
          backend: ops.kind, browserId: id, url: r.url, title: r.title,
          batch: { ok: r.ok, failedAt: r.failedAt, steps: r.steps.length },
          ...inventoryMeta(sid, ops.kind)
        })
      };
    }
  },

  {
    name: 'browser_act',
    description: 'One non-click page action: hover | dblclick | rightClick | select | upload | dialog | console | '
      + 'networkIdle | text | assert. Use browser_click/browser_type for the common cases, browser_batch for flows. '
      + 'dialog: set the JS dialog policy (accept=true/false) and see the last dialog; console: read recent page console '
      + 'and errors; networkIdle: wait until the page stops fetching; text: read page body on demand; '
      + 'assert: check some text appears (or set accept=false style exists check via value).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['hover', 'dblclick', 'rightClick', 'select', 'upload', 'dialog', 'console', 'networkIdle', 'text', 'assert'], description: '要执行的动作' },
        ref: { type: 'string', description: '快照里的 ref(可带 fN: 前缀)' },
        selector: { type: 'string', description: 'CSS 选择器' },
        text: { type: 'string', description: 'assert 要检查的文字' },
        value: { type: 'string', description: 'select 的值' },
        label: { type: 'string', description: 'select 按可见文本选择' },
        files: { type: 'array', items: { type: 'string' }, description: 'upload 的文件绝对路径(可多个)' },
        accept: { type: 'boolean', description: 'dialog:是否自动接受(默认自动关闭)' },
        max: { type: 'integer', description: 'text:最多读多少字,默认 2000' },
        timeoutMs: { type: 'integer', description: 'networkIdle 的超时毫秒' },
        browser_id: { type: 'string', description: BROWSER_ID_DESC },
        target: { type: 'string', enum: ['auto', 'native', 'preview', 'ego'], description: TARGET_DESC },
        browser: { type: 'string', description: BROWSER_DESC },
        tab_id: { type: 'integer', description: TAB_ID_DESC },
      },
      required: ['action']
    },
    access: 'write',
    timeoutMs: 60_000,
    mutating: true,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const ops = resolveOps(args, ctx);
      const id = ops.id;
      const action = String(args?.action || '').trim();
      if (!action) throw new Error('action 不能为空');
      const params: Record<string, unknown> = {
        ref: args?.ref, selector: args?.selector, text: args?.text, value: args?.value,
        label: args?.label, files: args?.files, accept: args?.accept, max: args?.max, timeoutMs: args?.timeoutMs
      };
      const msg = await ops.act(action, params);
      const st = ops.state();
      return {
        content: msg,
        meta: browserMeta({ backend: ops.kind, browserId: id, url: st?.url || '', title: st?.title || '', ...inventoryMeta(sid, ops.kind) })
      };
    }
  },

  {
    name: 'browser_memory',
    description: 'Remember what you learned about a site so the next browser_open does not start from zero: '
      + '"the export button is inside the ⋯ menu", "the row link uses loc=#orders > a:nth-of-type(2)", '
      + '"login asks for a 2FA code — stop and ask the user". Notes are stored per host and shown automatically on '
      + 'browser_open. Save only facts you verified in this session; selectors may go stale, so read them as hints.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'forget'], description: 'save = 记一条;list = 看这个站的;forget = 删(不传 note 就清空)' },
        note: { type: 'string', description: 'save 时的经验内容(一句话,300 字以内);forget 时可作为匹配片段' },
        url: { type: 'string', description: '站点地址(可省略:默认用当前页面;没有浏览器时必须给)' },
        selector: { type: 'string', description: '可选的稳定选择器(快照里的 loc= 或 CSS)' },
      },
      required: ['action']
    },
    access: 'write',
    timeoutMs: 15_000,
    mutating: true,
    async run(args, ctx) {
      const action = String(args?.action || '').trim();
      let url = String(args?.url || '').trim();
      if (!url) {
        try { url = resolveOps(args, ctx).state()?.url || ''; } catch { /* 没有在线浏览器:下面按缺 url 报错 */ }
      }
      if (!url) throw new Error('需要 url(当前没有可用的浏览器页面可以推断域名)');
      if (action === 'list') {
        const list = listLearnings(url);
        return {
          content: list.length
            ? `这个站记了 ${list.length} 条经验:\n` + list.map((x, i) => `${i + 1}. ${x.note}${x.selector ? `(选择器 ${x.selector})` : ''}`).join('\n')
            : '这个站还没有记过经验。',
          meta: browserMeta({ url })
        };
      }
      if (action === 'forget') {
        const n = forgetLearning(url, String(args?.note || ''));
        return { content: n ? `已删除 ${n} 条经验` : '没有匹配的经验', meta: browserMeta({ url }) };
      }
      const item = rememberLearning(url, String(args?.note || ''), args?.selector ? String(args.selector) : undefined);
      return { content: `已记下 ${item.host} 的经验:${item.note}`, meta: browserMeta({ url }) };
    }
  },

  {
    name: 'browser_close',
    description: 'Close a browser preview tab (frees the underlying page). Do this when the user no longer needs '
      + 'the preview, or before opening a completely unrelated project.',
    parameters: {
      type: 'object',
      properties: { browser_id: { type: 'string', description: BROWSER_ID_DESC },
        target: { type: 'string', enum: ['auto', 'native', 'preview', 'ego'], description: TARGET_DESC },
        browser: { type: 'string', description: BROWSER_DESC },
        tab_id: { type: 'integer', description: TAB_ID_DESC }, }
    },
    access: 'write',
    timeoutMs: 30_000,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const ops = resolveOps(args, ctx);
      const id = ops.id;
      await ops.close();
      return {
        content: `已关闭浏览器预览:${id}`,
        meta: browserMeta({ browserId: id, closed: true, ...inventoryMeta(sid, ops.kind) })
      };
    }
  }
];

/** 便于外部判断某工具名是否属于浏览器工具集 */
export function isBrowserTool(name: string): boolean {
  return name.startsWith('browser_');
}

/** 归一化地址的再导出(供 RPC/前端提示复用同一套判定) */
export { normalizePreviewUrl };

// ---------------- 批量步骤:运行时校验(模型给的东西不能直接信) ----------------

function normalizeSteps(raw: unknown): BatchStep[] {
  if (!Array.isArray(raw)) throw new Error('steps 必须是数组,每一项形如 {"op":"click","ref":"e3f9a"}');
  if (!raw.length) throw new Error('steps 不能为空');
  if (raw.length > 60) throw new Error(`一次最多 60 步(收到 ${raw.length}),拆成多次 browser_batch`);
  return raw.map((s, i) => {
    if (!s || typeof s !== 'object') throw new Error(`第 ${i + 1} 步不是对象`);
    const op = String((s as any).op || '').trim();
    if (!op) throw new Error(`第 ${i + 1} 步缺少 op`);
    return { ...(s as any), op } as BatchStep;
  });
}

// ---------------- 审计包装:所有 mutating 的浏览器工具自动落一条 ----------------

function auditTarget(args: any): string {
  if (args?.ref) return `ref=${args.ref}`;
  if (args?.selector) return `selector=${args.selector}`;
  if (args?.action) return `action=${args.action}`;
  if (Array.isArray(args?.steps)) return `steps=${args.steps.length}`;
  if (args?.url) return `url=${args.url}`;
  return '';
}

for (const def of browserToolDefs) {
  // 站点经验只写本机小文件,不是"对浏览器做了什么",不进浏览器审计
  if (!def.mutating || def.name === 'browser_memory') continue;
  const orig = (def as any).run as (a: any, c: any) => Promise<any>;
  (def as any).run = async (args: any, ctx: any) => {
    const started = Date.now();
    try {
      const r = await orig(args, ctx);
      auditBrowser({
        backend: (r?.meta?.backend as 'native' | 'preview') || 'preview',
        tool: def.name,
        tabId: typeof r?.meta?.tabId === 'number' ? r.meta.tabId : undefined,
        url: String(r?.meta?.url || ''),
        target: auditTarget(args),
        ok: true,
        ms: Date.now() - started,
        textLen: typeof args?.text === 'string' ? args.text.length : undefined,
        steps: Array.isArray(args?.steps) ? args.steps.length : undefined
      });
      return r;
    } catch (e: any) {
      auditBrowser({
        backend: 'preview',
        tool: def.name,
        url: '',
        target: auditTarget(args),
        ok: false,
        ms: Date.now() - started,
        error: String(e?.message || e).slice(0, 300)
      });
      throw e;
    }
  };
}
