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
import { resolvePreviewUrl } from '../core/port-tunnel.ts';
import { saveAttachment, attachmentUrl } from '../store/attachments-store.ts';
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

/** 工具返回的统一结构:正文 + 浏览器卡 UI 数据 */
function browserMeta(extra: Record<string, unknown> = {}) {
  return { card: 'browser', ...extra };
}

async function openTarget(args: any, { emit, sid: callSid }: any) {
  const raw = String(args?.url || '').trim();
  if (!raw) throw new Error('url 不能为空,请给出形如 http://localhost:5173 的项目地址');
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
  const id = resolveBrowserId(args, { sid: callSid }, { preferOwn: true });
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
  return { target, id, state };
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
      const { target, id, state } = await openTarget(args, ctx);
      const snap = await browserManager.snapshot(id, sid).catch((e) => `(快照失败:${e.message})`);
      const head = [`已在浏览器预览中打开:${state.url}`];
      if (target.tunneled) head.push(target.note || '已建立 SSH 隧道');
      else if (target.direct !== state.url) head.push(`原始地址 ${target.direct}`);
      if (state.error) {
        head.push(`⚠ 页面没能加载:${state.error}`);
        head.push('若这个地址来自前台 run_command,dev server 很可能已被工具超时终止(默认 300s)。'
          + '请改用 run_command(background=true)重启为「运行终端」,确认端口在监听后再 browser_open。');
      } else {
        head.push('用户已能在「浏览器预览」标签里看到该页面。');
      }
      return {
        content: head.join('\n') + '\n\n' + snap,
        meta: browserMeta({
          browserId: id, url: state.url, direct: target.direct,
          tunneled: target.tunneled, note: target.note || null, title: state.title,
          ...previewInventoryMeta(sid)
        })
      };
    }
  },

  {
    name: 'browser_snapshot',
    description: 'Return a structured text snapshot of the current browser preview page: interactive elements with '
      + 'stable refs (e[n]), headings and a body-text excerpt. Call it before clicking/typing to see what is on '
      + 'the page; refs are refreshed on every snapshot and may become stale after the page re-renders.',
    parameters: {
      type: 'object',
      properties: { browser_id: { type: 'string', description: BROWSER_ID_DESC } }
    },
    access: 'read',
    timeoutMs: 30_000,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const id = resolveBrowserId(args, ctx);
      const snap = await browserManager.snapshot(id, sid);
      const st = browserManager.state(id);
      return {
        content: snap,
        meta: browserMeta({ browserId: id, url: st?.url || '', title: st?.title || '', ...previewInventoryMeta(sid) })
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
        tunnel: { type: 'boolean', description: '是否强制走 SSH 隧道;省略=自动' }
      },
      required: ['url']
    },
    access: 'write',
    timeoutMs: 90_000,
    mutating: true,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const { target, id, state } = await openTarget(args, ctx);
      const snap = await browserManager.snapshot(id, sid).catch(() => '');
      const warn = state.error ? `\n⚠ 页面没能加载:${state.error}` : '';
      return {
        content: `已导航到:${state.url}${warn}\n\n${snap}`,
        meta: browserMeta({
          browserId: id, url: state.url, direct: target.direct,
          tunneled: target.tunneled, note: target.note || null, title: state.title,
          ...previewInventoryMeta(sid)
        })
      };
    }
  },

  {
    name: 'browser_click',
    description: 'Click an element in the browser preview page. Prefer ref from browser_snapshot (e.g. ref="e3"); '
      + 'selector (CSS) or text (visible label) are also accepted. Returns an updated snapshot.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'browser_snapshot 返回的元素引用,如 e3' },
        selector: { type: 'string', description: 'CSS 选择器(与 ref/text 三选一)' },
        text: { type: 'string', description: '可见文本,匹配第一个包含它的元素' },
        browser_id: { type: 'string', description: BROWSER_ID_DESC }
      }
    },
    access: 'write',
    timeoutMs: 60_000,
    mutating: true,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const id = resolveBrowserId(args, ctx);
      const msg = await browserManager.click(id, { ref: args?.ref, selector: args?.selector, text: args?.text }, sid);
      const snap = await browserManager.snapshot(id, sid).catch(() => '');
      const st = browserManager.state(id);
      return {
        content: `${msg}\n\n${snap}`,
        meta: browserMeta({ browserId: id, url: st?.url || '', title: st?.title || '', ...previewInventoryMeta(sid) })
      };
    }
  },

  {
    name: 'browser_type',
    description: 'Type text into an input / textarea / contenteditable in the browser preview page '
      + '(locate by ref from browser_snapshot, or a CSS selector). Set submit=true to press Enter afterwards. '
      + 'Returns an updated snapshot.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'browser_snapshot 返回的元素引用,如 e5' },
        selector: { type: 'string', description: 'CSS 选择器(与 ref 二选一)' },
        text: { type: 'string', description: '要输入的文本' },
        clear: { type: 'boolean', description: '是否先清空原有内容,默认 true' },
        submit: { type: 'boolean', description: '输入后是否回车提交,默认 false' },
        browser_id: { type: 'string', description: BROWSER_ID_DESC }
      },
      required: ['text']
    },
    access: 'write',
    timeoutMs: 60_000,
    mutating: true,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const id = resolveBrowserId(args, ctx);
      const msg = await browserManager.fill(id, {
        ref: args?.ref, selector: args?.selector,
        text: String(args?.text ?? ''), clear: args?.clear, submit: args?.submit === true
      }, sid);
      const snap = await browserManager.snapshot(id, sid).catch(() => '');
      const st = browserManager.state(id);
      return {
        content: `${msg}\n\n${snap}`,
        meta: browserMeta({ browserId: id, url: st?.url || '', title: st?.title || '', ...previewInventoryMeta(sid) })
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
        browser_id: { type: 'string', description: BROWSER_ID_DESC }
      },
      required: ['key']
    },
    access: 'write',
    timeoutMs: 30_000,
    mutating: true,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const id = resolveBrowserId(args, ctx);
      return {
        content: await browserManager.press(id, String(args?.key || 'Enter'), sid),
        meta: browserMeta({ browserId: id, ...previewInventoryMeta(sid) })
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
        browser_id: { type: 'string', description: BROWSER_ID_DESC }
      }
    },
    access: 'write',
    timeoutMs: 30_000,
    mutating: true,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const id = resolveBrowserId(args, ctx);
      return {
        content: await browserManager.scroll(id, { direction: args?.direction, amount: args?.amount }, sid),
        meta: browserMeta({ browserId: id, ...previewInventoryMeta(sid) })
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
        browser_id: { type: 'string', description: BROWSER_ID_DESC }
      }
    },
    access: 'read',
    timeoutMs: 70_000,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const id = resolveBrowserId(args, ctx);
      return {
        content: await browserManager.waitFor(id, {
          text: args?.text, selector: args?.selector, url: args?.url, timeoutMs: args?.timeout_ms
        }, sid),
        meta: browserMeta({ browserId: id, ...previewInventoryMeta(sid) })
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
        browser_id: { type: 'string', description: BROWSER_ID_DESC }
      }
    },
    access: 'read',
    timeoutMs: 60_000,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const id = resolveBrowserId(args, ctx);
      const buf = await browserManager.screenshot(id, { fullPage: args?.full_page === true }, sid);
      const st = browserManager.state(id);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const att = await saveAttachment(buf, `浏览器截图-${ts}.png`, 'image/png');
      return {
        content: `已截图(附件 id:${att.id},${Math.round(buf.length / 1024)}KB)。截图已内联展示给用户,不要把图片嵌入你的回复正文。`,
        meta: browserMeta({
          browserId: id, url: st?.url || '', title: st?.title || '',
          screenshot: { id: att.id, url: attachmentUrl(att.id), name: att.name },
          ...previewInventoryMeta(sid)
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
        browser_id: { type: 'string', description: BROWSER_ID_DESC }
      },
      required: ['expression']
    },
    access: 'write',
    timeoutMs: 30_000,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const id = resolveBrowserId(args, ctx);
      return {
        content: await browserManager.evaluate(id, String(args?.expression || ''), sid),
        meta: browserMeta({ browserId: id, ...previewInventoryMeta(sid) })
      };
    }
  },

  {
    name: 'browser_close',
    description: 'Close a browser preview tab (frees the underlying page). Do this when the user no longer needs '
      + 'the preview, or before opening a completely unrelated project.',
    parameters: {
      type: 'object',
      properties: { browser_id: { type: 'string', description: BROWSER_ID_DESC } }
    },
    access: 'write',
    timeoutMs: 30_000,
    async run(args, ctx) {
      const sid = callerSid(ctx);
      const id = resolveBrowserId(args, ctx);
      await browserManager.close(id, sid);
      return {
        content: `已关闭浏览器预览:${id}`,
        meta: browserMeta({ browserId: id, closed: true, ...previewInventoryMeta(sid) })
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
