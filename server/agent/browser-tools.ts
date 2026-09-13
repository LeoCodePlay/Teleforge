// AI 浏览器工具集:让 Agent 真正「操控」前端那个浏览器预览标签(同一份会话、同一个页面)。
// 与 run_command 等工具的区别:这些工具操作的是本机 Playwright 驱动的真实 Chromium,
// 不依赖 SSH;地址解析会用 port-tunnel 在需要时自动建 SSH 隧道,让远程开发服务也能预览。
//
// 设计取舍:AI 拿到的不是截图而是「结构化文本快照」(+ 可选的截图附件)。
// 纯文本模型无法内联看图,而带 ref 的快照能精确点击/输入,比像素坐标稳得多。
import { browserManager, normalizePreviewUrl } from '../core/browser-manager.ts';
import { resolvePreviewUrl } from '../core/port-tunnel.ts';
import { saveAttachment, attachmentUrl } from '../store/attachments-store.ts';
import type { ToolDef } from './registry.ts';

const DEFAULT_BROWSER_ID = 'main';

function idOf(args: any): string {
  const v = String(args?.browser_id || '').trim();
  return v || DEFAULT_BROWSER_ID;
}

/** 工具返回的统一结构:正文 + 浏览器卡 UI 数据 */
function browserMeta(extra: Record<string, unknown> = {}) {
  return { card: 'browser', ...extra };
}

async function openTarget(args: any, { emit, sid }: any) {
  const raw = String(args?.url || '').trim();
  if (!raw) throw new Error('url 不能为空,请给出形如 http://localhost:5173 的项目地址');
  const tunnel = args?.tunnel === true ? true : args?.tunnel === false ? false : undefined;
  const target = await resolvePreviewUrl(raw, { tunnel });
  const id = idOf(args);
  const state = await browserManager.open({ id, url: target.url, width: args?.width, height: args?.height });
  // 通知前端打开/激活预览标签(用户点一下地址即可看到画面)
  emit?.('agent', {
    event: 'browser_open', sid, id,
    url: target.url, direct: target.direct, tunneled: target.tunneled, note: target.note || null
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
      + '(default 300s), which makes the printed address dead (ERR_CONNECTION_REFUSED). Start it in the '
      + 'background instead (e.g. `nohup npm run dev > /tmp/dev.log 2>&1 &`) and confirm the port is actually '
      + 'listening before opening the preview; if it refuses to connect, restart the server in the background '
      + 'and retry.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要预览的地址,如 http://localhost:5173 或 localhost:3000' },
        browser_id: { type: 'string', description: `预览标签 id,默认 ${DEFAULT_BROWSER_ID}(同名标签会被复用)` },
        tunnel: { type: 'boolean', description: '是否强制走 SSH 隧道映射远程端口;省略=回环地址且已连 SSH 时自动隧道' },
        width: { type: 'integer', description: '视口宽度,默认 1280' },
        height: { type: 'integer', description: '视口高度,默认 800' }
      },
      required: ['url']
    },
    access: 'write',
    timeoutMs: 90_000,
    mutating: true,
    async run(args, { emit, sid }) {
      const { target, id, state } = await openTarget(args, { emit, sid });
      const snap = await browserManager.snapshot(id).catch((e) => `(快照失败:${e.message})`);
      const head = [`已在浏览器预览中打开:${state.url}`];
      if (target.tunneled) head.push(target.note || '已建立 SSH 隧道');
      else if (target.direct !== state.url) head.push(`原始地址 ${target.direct}`);
      if (state.error) {
        head.push(`⚠ 页面没能加载:${state.error}`);
        head.push('若这个地址来自前台 run_command,dev server 很可能已被工具超时终止(默认 300s)。'
          + '请改用后台方式重启(例如 `nohup npm run dev > /tmp/dev.log 2>&1 &`),确认端口在监听后再 browser_open。');
      } else {
        head.push('用户已能在「浏览器预览」标签里看到该页面。');
      }
      return {
        content: head.join('\n') + '\n\n' + snap,
        meta: browserMeta({
          browserId: id, url: state.url, direct: target.direct,
          tunneled: target.tunneled, note: target.note || null, title: state.title
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
      properties: { browser_id: { type: 'string', description: `预览标签 id,默认 ${DEFAULT_BROWSER_ID}` } }
    },
    access: 'read',
    timeoutMs: 30_000,
    async run(args) {
      const id = idOf(args);
      const snap = await browserManager.snapshot(id);
      const st = browserManager.state(id);
      return { content: snap, meta: browserMeta({ browserId: id, url: st?.url || '', title: st?.title || '' }) };
    }
  },

  {
    name: 'browser_navigate',
    description: 'Navigate the browser preview to another URL (e.g. a different route/port). Returns a fresh page snapshot.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标地址' },
        browser_id: { type: 'string', description: `预览标签 id,默认 ${DEFAULT_BROWSER_ID}` },
        tunnel: { type: 'boolean', description: '是否强制走 SSH 隧道;省略=自动' }
      },
      required: ['url']
    },
    access: 'write',
    timeoutMs: 90_000,
    mutating: true,
    async run(args, { emit, sid }) {
      const { target, id, state } = await openTarget(args, { emit, sid });
      const snap = await browserManager.snapshot(id).catch(() => '');
      const warn = state.error ? `\n⚠ 页面没能加载:${state.error}` : '';
      return {
        content: `已导航到:${state.url}${warn}\n\n${snap}`,
        meta: browserMeta({
          browserId: id, url: state.url, direct: target.direct,
          tunneled: target.tunneled, note: target.note || null, title: state.title
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
        browser_id: { type: 'string', description: `预览标签 id,默认 ${DEFAULT_BROWSER_ID}` }
      }
    },
    access: 'write',
    timeoutMs: 60_000,
    mutating: true,
    async run(args) {
      const id = idOf(args);
      const msg = await browserManager.click(id, { ref: args?.ref, selector: args?.selector, text: args?.text });
      const snap = await browserManager.snapshot(id).catch(() => '');
      const st = browserManager.state(id);
      return {
        content: `${msg}\n\n${snap}`,
        meta: browserMeta({ browserId: id, url: st?.url || '', title: st?.title || '' })
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
        browser_id: { type: 'string', description: `预览标签 id,默认 ${DEFAULT_BROWSER_ID}` }
      },
      required: ['text']
    },
    access: 'write',
    timeoutMs: 60_000,
    mutating: true,
    async run(args) {
      const id = idOf(args);
      const msg = await browserManager.fill(id, {
        ref: args?.ref, selector: args?.selector,
        text: String(args?.text ?? ''), clear: args?.clear, submit: args?.submit === true
      });
      const snap = await browserManager.snapshot(id).catch(() => '');
      const st = browserManager.state(id);
      return {
        content: `${msg}\n\n${snap}`,
        meta: browserMeta({ browserId: id, url: st?.url || '', title: st?.title || '' })
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
        browser_id: { type: 'string', description: `预览标签 id,默认 ${DEFAULT_BROWSER_ID}` }
      },
      required: ['key']
    },
    access: 'write',
    timeoutMs: 30_000,
    mutating: true,
    async run(args) {
      const id = idOf(args);
      return await browserManager.press(id, String(args?.key || 'Enter'));
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
        browser_id: { type: 'string', description: `预览标签 id,默认 ${DEFAULT_BROWSER_ID}` }
      }
    },
    access: 'write',
    timeoutMs: 30_000,
    mutating: true,
    async run(args) {
      const id = idOf(args);
      return await browserManager.scroll(id, { direction: args?.direction, amount: args?.amount });
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
        browser_id: { type: 'string', description: `预览标签 id,默认 ${DEFAULT_BROWSER_ID}` }
      }
    },
    access: 'read',
    timeoutMs: 70_000,
    async run(args) {
      const id = idOf(args);
      return await browserManager.waitFor(id, {
        text: args?.text, selector: args?.selector, url: args?.url, timeoutMs: args?.timeout_ms
      });
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
        browser_id: { type: 'string', description: `预览标签 id,默认 ${DEFAULT_BROWSER_ID}` }
      }
    },
    access: 'read',
    timeoutMs: 60_000,
    async run(args) {
      const id = idOf(args);
      const buf = await browserManager.screenshot(id, { fullPage: args?.full_page === true });
      const st = browserManager.state(id);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const att = await saveAttachment(buf, `浏览器截图-${ts}.png`, 'image/png');
      return {
        content: `已截图(附件 id:${att.id},${Math.round(buf.length / 1024)}KB)。截图已内联展示给用户,不要把图片嵌入你的回复正文。`,
        meta: browserMeta({
          browserId: id, url: st?.url || '', title: st?.title || '',
          screenshot: { id: att.id, url: attachmentUrl(att.id), name: att.name }
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
        browser_id: { type: 'string', description: `预览标签 id,默认 ${DEFAULT_BROWSER_ID}` }
      },
      required: ['expression']
    },
    access: 'write',
    timeoutMs: 30_000,
    async run(args) {
      const id = idOf(args);
      return { content: await browserManager.evaluate(id, String(args?.expression || '')) };
    }
  },

  {
    name: 'browser_close',
    description: 'Close a browser preview tab (frees the underlying page). Do this when the user no longer needs '
      + 'the preview, or before opening a completely unrelated project.',
    parameters: {
      type: 'object',
      properties: { browser_id: { type: 'string', description: `预览标签 id,默认 ${DEFAULT_BROWSER_ID}` } }
    },
    access: 'write',
    timeoutMs: 30_000,
    async run(args) {
      const id = idOf(args);
      await browserManager.close(id);
      return `已关闭浏览器预览:${id}`;
    }
  }
];

/** 便于外部判断某工具名是否属于浏览器工具集 */
export function isBrowserTool(name: string): boolean {
  return name.startsWith('browser_');
}

/** 归一化地址的再导出(供 RPC/前端提示复用同一套判定) */
export { normalizePreviewUrl };
