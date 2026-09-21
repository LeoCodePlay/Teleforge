// 页面操作:全部通过 CDP 实现,与内置预览(core/browser-manager.ts 的 Playwright 路径)语义对齐。
// 服务端把同一份 SNAPSHOT_SCRIPT 下发下来,所以这里的 ref 语义与内置预览完全一致(data-tp-ref="eN")。
import { sendCommand } from './cdp.js';

const ATTR = 'data-tp-ref';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在页面里执行表达式并取回值(returnByValue) */
export async function evaluate(tabId, expression, { awaitPromise = false } = {}) {
  const r = await sendCommand(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true
  });
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || '页面脚本执行出错');
  }
  return r && r.result ? r.result.value : undefined;
}

/** 元素定位辅助(注入页面的公共片段);ref 来自 SNAPSHOT_SCRIPT 打的 data-tp-ref */
const LOCATOR = `
const clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
const visible = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width <= 1 || r.height <= 1) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
};
const findEl = (ref, selector, text) => {
  if (ref) {
    const el = document.querySelector('[' + ATTR + '="' + ref + '"]');
    if (el) return { el: el, how: 'ref=' + ref };
  }
  if (selector) {
    try {
      const el = document.querySelector(selector);
      if (el) return { el: el, how: 'selector=' + selector };
    } catch (e) { return { err: '选择器不合法:' + selector }; }
  }
  if (text) {
    const t = clean(text);
    const cands = document.querySelectorAll('a,button,input,textarea,select,label,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="switch"],h1,h2,h3');
    for (const e of cands) {
      if (!visible(e)) continue;
      const s = clean(e.innerText || e.textContent || e.value || e.getAttribute('aria-label') || e.getAttribute('placeholder'));
      if (s && s.indexOf(t) >= 0) return { el: e, how: 'text=' + t };
    }
  }
  return { err: '没找到匹配的元素(ref / selector / text 都没命中;先调用 browser_snapshot 拿 ref)' };
};
`;

/** 拼装一段自包含的页面脚本 */
function buildExpr(body) {
  return `(() => {\nconst ATTR = ${JSON.stringify(ATTR)};\n${LOCATOR}\n${body}\n})()`;
}

function describeEl(elExpr) {
  return `(clean(${elExpr}.getAttribute('aria-label')) || clean(${elExpr}.innerText || ${elExpr}.value) || ${elExpr}.tagName || '').slice(0, 60)`;
}

// ---------------- 导航 ----------------

export async function navigate(tabId, url) {
  await sendCommand(tabId, 'Page.enable');
  await sendCommand(tabId, 'Page.navigate', { url });
  return waitForLoad(tabId, url);
}

async function waitForLoad(tabId, fallbackUrl) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(200);
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error('标签已关闭');
    }
    if (tab.status === 'complete') return { url: tab.url || fallbackUrl, title: tab.title || '', error: null };
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return { url: (tab && tab.url) || fallbackUrl, title: (tab && tab.title) || '', error: '页面在 30s 内没有加载完成' };
}

// ---------------- 快照 ----------------

export async function snapshot(tabId, snapshotScript) {
  if (!snapshotScript) throw new Error('快照脚本还没下发(扩展刚连接上),请稍后重试');
  const value = await evaluate(tabId, snapshotScript);
  if (!value || typeof value !== 'object') throw new Error('快照脚本没有返回结构化结果(可能是页面刚导航,重试即可)');
  return value;
}

// ---------------- 交互 ----------------

export async function click(tabId, { ref, selector, text }) {
  const expr = buildExpr(`
    const found = findEl(${JSON.stringify(ref || '')}, ${JSON.stringify(selector || '')}, ${JSON.stringify(text || '')});
    if (found.err) return { ok: false, error: found.err };
    const el = found.el;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: found.how + ' → ' + ${describeEl('el')} };
  `);
  const r = await evaluate(tabId, expr);
  if (!r || !r.ok) throw new Error((r && r.error) || '定位元素失败');
  const base = { x: r.x, y: r.y, button: 'left', clickCount: 1 };
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none' });
  await sendCommand(tabId, 'Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, base));
  await sendCommand(tabId, 'Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, base));
  return `已点击:${r.label}`;
}

export async function type(tabId, { ref, selector, text, clear = true, submit = false }) {
  const expr = buildExpr(`
    const found = findEl(${JSON.stringify(ref || '')}, ${JSON.stringify(selector || '')}, '');
    if (found.err) return { ok: false, error: found.err };
    const el = found.el;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (${clear ? 'true' : 'false'}) {
      if (typeof el.select === 'function') el.select();
      else if (el.isContentEditable) {
        const r = document.createRange(); r.selectNodeContents(el);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      } else if (el.value !== undefined) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (typeof el.setSelectionRange === 'function' && el.value !== undefined) {
      el.setSelectionRange(el.value.length, el.value.length);
    }
    return { ok: true, label: found.how + ' → ' + (el.tagName || '') };
  `);
  const r = await evaluate(tabId, expr);
  if (!r || !r.ok) throw new Error((r && r.error) || '定位输入框失败');
  // insertText 是浏览器层面的文本插入:会正常触发 input 事件,React/Vue 都能感知
  await sendCommand(tabId, 'Input.insertText', { text: String(text == null ? '' : text) });
  if (submit) await press(tabId, 'Enter');
  return `已输入到 ${r.label}${submit ? ',并回车提交' : ''}`;
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Esc: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  Down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  Left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  Right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' }
};

export async function press(tabId, key) {
  const parts = String(key || '').split('+').map((s) => s.trim()).filter(Boolean);
  const main = parts.pop() || 'Enter';
  let modifiers = 0;
  for (const m of parts) {
    const l = m.toLowerCase();
    if (l === 'ctrl' || l === 'control') modifiers |= 2;
    else if (l === 'alt') modifiers |= 1;
    else if (l === 'shift') modifiers |= 8;
    else if (l === 'meta' || l === 'cmd' || l === 'command') modifiers |= 4;
  }
  let def = KEYS[main];
  if (!def && /^[a-zA-Z0-9]$/.test(main)) {
    const upper = main.toUpperCase();
    def = {
      key: main,
      code: /[a-z]/i.test(main) ? 'Key' + upper : 'Digit' + main,
      vk: upper.charCodeAt(0),
      text: modifiers === 0 ? main : undefined
    };
  }
  if (!def) {
    throw new Error(`不支持的按键:${key}(可用 Enter/Tab/Escape/ArrowUp|Down|Left|Right/Backspace/Delete/Home/End/PageUp/PageDown/Space/单个字符,组合键写成 Control+A)`);
  }
  const down = {
    type: 'keyDown',
    modifiers,
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.vk,
    nativeVirtualKeyCode: def.vk
  };
  if (modifiers === 0 && def.text !== undefined) down.text = def.text;
  await sendCommand(tabId, 'Input.dispatchKeyEvent', down);
  await sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', modifiers, key: def.key, code: def.code,
    windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk
  });
  return `已按键:${key}`;
}

export async function scroll(tabId, { direction = 'down', amount = 600 } = {}) {
  const vp = await evaluate(tabId, '(() => ({ w: innerWidth, h: innerHeight }))()');
  const x = Math.round(((vp && vp.w) || 1280) / 2);
  const y = Math.round(((vp && vp.h) || 800) / 2);
  const deltaY = String(direction).toLowerCase() === 'up' ? -Math.abs(amount) : Math.abs(amount);
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  return `已向${deltaY > 0 ? '下' : '上'}滚动 ${Math.abs(amount)}px`;
}

/** URL 通配匹配(与内置预览一致:支持 ** 通配) */
function urlMatches(pattern, url) {
  if (!pattern) return false;
  const re = new RegExp('^' + String(pattern).split('**').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(url) || url.includes(String(pattern).replace(/\*\*/g, ''));
}

export async function wait(tabId, { text, selector, url, timeoutMs = 8000 } = {}) {
  const budget = Math.min(Math.max(Number(timeoutMs) || 8000, 500), 60_000);
  const deadline = Date.now() + budget;
  const wantText = String(text || '');
  const wantSel = String(selector || '');
  const wantUrl = String(url || '');
  const expr = buildExpr(`
    const out = { url: location.href, title: document.title, textOk: null, selOk: null };
    if (${JSON.stringify(wantText)}) {
      const f = findEl('', '', ${JSON.stringify(wantText)});
      out.textOk = !f.err;
    }
    if (${JSON.stringify(wantSel)}) {
      try { const el = document.querySelector(${JSON.stringify(wantSel)}); out.selOk = !!(el && visible(el)); }
      catch (e) { out.selOk = false; }
    }
    return out;
  `);
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(tabId, expr).catch(() => null);
    if (last) {
      const textOk = !wantText || last.textOk === true;
      const selOk = !wantSel || last.selOk === true;
      const urlOk = !wantUrl || urlMatches(wantUrl, last.url || '');
      if (textOk && selOk && urlOk) {
        return `条件已满足:${[wantText && `文本「${wantText}」`, wantSel && `选择器 ${wantSel}`, wantUrl && `URL ${wantUrl}`].filter(Boolean).join(' / ')}\n当前地址:${last.url}`;
      }
    }
    await sleep(250);
  }
  const cur = last ? last.url : '(未知)';
  const parts = [wantText && `文本「${wantText}」`, wantSel && `选择器 ${wantSel}`, wantUrl && `URL ${wantUrl}`].filter(Boolean);
  throw new Error(`等待超时(${budget}ms):${parts.join(' / ')} 未出现。当前地址:${cur}`);
}

// ---------------- 截图 ----------------

export async function screenshot(tabId, { fullPage = false } = {}) {
  if (!fullPage) {
    const r = await sendCommand(tabId, 'Page.captureScreenshot', { format: 'png' });
    return r.data;
  }
  const m = await sendCommand(tabId, 'Page.getLayoutMetrics');
  const size = m.cssContentSize || m.contentSize || { width: 1280, height: 800 };
  const r = await sendCommand(tabId, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
  });
  return r.data;
}
