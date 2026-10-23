// @ts-nocheck —— 本文件的主体是一段**要在页面里执行的自包含脚本**,刻意不写类型注解
// (它会被 toString() 序列化后交给 Playwright / CDP,任何 TS 语法都可能在序列化后变味)。
// 类型检查交给下面这几个导出接口的结构化声明;脚本内部的宽松用法是有意为之。
//
// 页面快照 v2:真机浏览器(扩展)与内置预览(Playwright)共用同一份脚本与同一套文本格式。
//
// 与 v1 的差别(每一条都对应一个真实踩过的坑):
//   1) ref 稳定 —— v1 是 e1..eN 按出现顺序编号,页面上多一个元素,后面所有 ref 全部错位;
//      v2 用 role|name|css 路径算短哈希,同一元素跨快照编号不变(文案/DOM 大改才变)。
//   2) 穿透 shadow DOM —— v1 只扫 document,自定义元素里的按钮完全读不到。
//   3) 结构化 —— 按标题层级缩进,一眼能看出"这个「保存」属于哪个区块";v1 是一坨平铺列表。
//   4) 可按需取正文 —— v1 每次都塞 2000 字正文,单次快照 2~5k token;v2 默认不塞,要了才给。
//   5) 视野可选 —— viewport(默认)/ full_page / subtree(只看某个子树)。
//
// 脚本必须**自包含**:它会被 toString() 序列化后在页面里执行(Playwright evaluate /
// CDP Runtime.evaluate),不能引用模块作用域的任何东西。函数体内也不要写 TS 语法 ——
// Node 的类型剥离会把注解换成空白,但保持纯 JS 最稳。

/** 与扩展/客户端约定的引用属性名(click/type 通过它定位) */
export const SNAPSHOT_ATTR = 'data-tp-ref';

/** r:ref, role, name, tag, depth, loc, flags, href, value, level, frame */
export interface SnapshotNode {
  ref?: string;
  role: string;
  name: string;
  tag: string;
  depth: number;
  loc?: string;
  flags?: string[];
  href?: string;
  value?: string;
  level?: number;
  frame?: boolean;
}

export interface SnapshotData {
  v?: number;
  url?: string;
  title?: string;
  viewport?: { w: number; h: number; scrollY: number; scrollHeight: number };
  nodes?: SnapshotNode[];
  /** 兼容 v1(老扩展/老客户端):平铺的元素描述行 */
  items?: string[];
  heads?: string[];
  text?: string;
  count?: number;
  truncated?: number;
  frames?: Array<{ index: number; url: string; name?: string; note?: string; nodes?: SnapshotNode[] }>;
  error?: string;
}

/**
 * 快照脚本。opts:
 *   scope: 'viewport' | 'full_page' | 'subtree'(默认 viewport)
 *   root:  subtree 的根(ref / CSS 选择器)
 *   text:  要附带多少字正文(0 = 不带,默认 0)
 *   max:   节点上限(默认 160)
 */
export const SNAPSHOT_SCRIPT = function (opts) {
  const o = opts || {};
  const ATTR = 'data-tp-ref';
  const scope = o.scope === 'full_page' || o.scope === 'subtree' ? o.scope : 'viewport';
  const maxNodes = Math.max(20, Math.min(Number(o.max) || 160, 400));
  const textBudget = Math.max(0, Math.min(Number(o.text) || 0, 4000));
  const win = globalThis;
  const doc = win.document;
  if (!doc) return { v: 2, url: '', title: '', nodes: [], error: '页面里没有 document(可能还在导航中)' };

  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const cut = (s, n) => {
    const t = clean(s);
    return t.length > n ? t.slice(0, n) + '…' : t;
  };

  // ---- 引用:短的稳定哈希 ----
  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  };

  /** 尽量短的稳定 CSS 路径:id 优先,其次 nth-of-type 链(遇到 shadow 边界就停) */
  const cssPath = (el) => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
    const parts = [];
    let node = el;
    let guard = 0;
    while (node && node.nodeType === 1 && guard++ < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) part = '#' + node.id;
      else {
        const parent = node.parentElement;
        if (parent) {
          const sibs = [...parent.children].filter((c) => c.tagName === node.tagName);
          if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(part);
      if (part[0] === '#') break;
      const parent = node.parentElement;
      if (!parent) break;
      node = parent;
    }
    return parts.join(' > ');
  };

  const resolvedRefs = win.__tpRefs instanceof Map ? win.__tpRefs : new Map();
  win.__tpRefs = resolvedRefs;
  resolvedRefs.clear();

  // 清掉上一次快照打的引用(只清这份文档;shadow 里的属性会随元素一起保留,按需覆盖)
  try { doc.querySelectorAll('[' + ATTR + ']').forEach((e) => e.removeAttribute(ATTR)); } catch (e) { /* 忽略 */ }

  const IMPLICIT_ROLE = {
    a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', summary: 'button',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    option: 'option', label: 'label', iframe: 'iframe', frame: 'iframe', img: 'image'
  };
  const SKIP_ROLES = {
    presentation: 1, none: 1, generic: 1, 'inline-text': 1
  };
  const SEL = 'a[href],button,input,textarea,select,summary,option,[role],[contenteditable=""],'
    + '[contenteditable="true"],[tabindex]:not([tabindex="-1"]),[onclick],iframe,frame,'
    + 'h1,h2,h3,h4,h5,h6';

  const roleOf = (el) => {
    const explicit = clean(el.getAttribute('role')).split(/\s+/)[0];
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = clean(el.getAttribute('type')).toLowerCase();
      if (t === 'checkbox' || t === 'radio' || t === 'range' || t === 'file' || t === 'search') {
        return t === 'range' ? 'slider' : t;
      }
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      return 'textbox';
    }
    return IMPLICIT_ROLE[tag] || tag;
  };

  const accName = (el, tag) => {
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return cut(aria, 90);
    const labelledBy = clean(el.getAttribute('aria-labelledby'));
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/).map((id) => {
        const t = doc.getElementById(id);
        return t ? clean(t.innerText || t.textContent) : '';
      }).filter(Boolean);
      if (parts.length) return cut(parts.join(' '), 90);
    }
    const alt = clean(el.getAttribute('alt'));
    if (alt) return cut(alt, 90);
    const title = clean(el.getAttribute('title'));
    if (title) return cut(title, 90);
    const ph = clean(el.getAttribute('placeholder'));
    if (ph) return cut(ph, 90);
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const id = clean(el.getAttribute('id'));
      if (id) {
        const lab = doc.querySelector('label[for="' + id.replace(/"/g, '\\"') + '"]');
        if (lab) return cut(lab.innerText || lab.textContent, 90);
      }
      const wrap = el.closest && el.closest('label');
      if (wrap) return cut(wrap.innerText || wrap.textContent, 90);
    }
    const text = clean(el.innerText || el.textContent);
    if (text) return cut(text, 90);
    const val = clean(el.value);
    if (val) return cut(val, 90);
    return '';
  };

  const describe = (el, tag, role) => {
    const flags = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') flags.push('disabled');
    if (el.getAttribute('aria-expanded') === 'true') flags.push('expanded');
    if (el.checked === true || el.getAttribute('aria-checked') === 'true') flags.push('checked');
    if (el.readOnly) flags.push('readonly');
    if (el.required || el.getAttribute('aria-required') === 'true') flags.push('required');
    if (el.tagName === 'SELECT' && el.multiple) flags.push('multiple');
    const type = clean(el.getAttribute('type')).toLowerCase();
    let value;
    if (tag === 'input' || tag === 'textarea') {
      const v = clean(el.value);
      if (v) value = type === 'password' ? '***' : cut(v, 80);
    } else if (tag === 'select') {
      const sel = el.selectedOptions && el.selectedOptions[0];
      if (sel) value = cut(sel.textContent, 60);
    }
    const href = clean(el.getAttribute('href'));
    return {
      flags,
      value,
      href: href && href[0] !== '#' ? cut(href, 120) : undefined,
      level: role === 'heading' ? Number(tag.slice(1)) || undefined : undefined
    };
  };

  const docEl = doc.documentElement;
  const view = {
    w: win.innerWidth || (docEl ? docEl.clientWidth : 0),
    h: win.innerHeight || (docEl ? docEl.clientHeight : 0),
    scrollY: Math.round(win.scrollY || 0),
    scrollHeight: docEl ? docEl.scrollHeight : 0
  };

  let rootEl = null;
  if (scope === 'subtree') {
    const raw = clean(o.root);
    if (raw) {
      rootEl = resolvedRefs.get(raw) || null;
      if (!rootEl) {
        try { rootEl = doc.querySelector(raw); } catch (e) { rootEl = null; }
      }
      if (!rootEl) {
        try { rootEl = doc.querySelector('[' + ATTR + '="' + raw.replace(/"/g, '') + '"]'); } catch (e) { rootEl = null; }
      }
    }
    if (!rootEl) return { v: 2, url: win.location.href, title: doc.title, nodes: [], error: 'subtree 的 root 没找到:' + o.root };
  }

  const nodes = [];
  let truncated = 0;
  const seenRefs = new Set();
  // 标题层级:按最近一个标题决定缩进,让"保存按钮属于哪个区块"一眼可见
  let headingDepth = 0;

  const inView = (r) => scope === 'full_page'
    || (r.bottom > 0 && r.right > 0 && r.top < view.h + 1 && r.left < view.w + 1);

  const isVisible = (el, r) => {
    if (r.width <= 1 || r.height <= 1) return false;
    if (el.hasAttribute && el.hasAttribute('hidden')) return false;
    const st = win.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') return false;
    if (st.opacity === '0' || Number(st.opacity) === 0) return false;
    return true;
  };

  const withinRoot = (el) => !rootEl || rootEl === el || (rootEl.contains && rootEl.contains(el));

  /** 遍历一个 root(document 或某个 shadow root),按文档顺序处理 */
  const walkRoot = (rootNode, depthBase) => {
    let all;
    try { all = rootNode.querySelectorAll('*'); } catch (e) { return; }
    for (let i = 0; i < all.length; i++) {
      if (nodes.length >= maxNodes) { truncated += 1; return; }
      const el = all[i];
      if (rootEl && !withinRoot(el)) continue;
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      let matched = false;
      try { matched = el.matches(SEL); } catch (e) { matched = false; }
      if (matched) {
        const role = roleOf(el);
        if (!SKIP_ROLES[role]) {
          const r = el.getBoundingClientRect();
          if (isVisible(el, r) && inView(r)) {
            const info = describe(el, tag, role);
            const name = accName(el, tag);
            let depth = depthBase + Math.min(headingDepth, 3) + 1;
            if (role === 'heading') {
              headingDepth = info.level || 2;
              depth = depthBase + Math.max(headingDepth - 1, 0);
            }
            const loc = cssPath(el);
            let ref = '';
            if (role !== 'heading' && role !== 'label' && role !== 'image') {
              ref = 'e' + hash(role + '|' + name + '|' + loc).slice(-5);
              if (seenRefs.has(ref)) {
                let n = 2;
                while (seenRefs.has(ref + '-' + n)) n += 1;
                ref = ref + '-' + n;
              }
              seenRefs.add(ref);
              try { el.setAttribute(ATTR, ref); } catch (e) { /* 忽略 */ }
              resolvedRefs.set(ref, el);
            }
            nodes.push({
              ref: ref || undefined,
              role,
              name,
              tag,
              depth: Math.max(0, depth),
              loc,
              flags: info.flags.length ? info.flags : undefined,
              href: info.href,
              value: info.value,
              level: info.level,
              frame: role === 'iframe' ? true : undefined
            });
          }
        }
      }
      // open shadow root:按宿主在文档中的位置继续往下走
      const shadow = el.shadowRoot;
      if (shadow && scope !== 'subtree') walkRoot(shadow, depthBase + 1);
    }
  };

  try { walkRoot(doc, 0); } catch (e) { /* 页面在遍历中导航了 */ }

  const out = {
    v: 2,
    url: win.location.href,
    title: doc.title,
    viewport: view,
    nodes,
    truncated: truncated > 0 ? truncated : undefined,
    text: textBudget > 0 ? cut(doc.body ? doc.body.innerText : '', textBudget) : undefined,
    error: nodes.length ? undefined : '页面里没有找到可交互元素(可能需要滚动、或内容在跨域框架里)'
  };
  return out;
};

// ---------------- 文本渲染 ----------------

const ROLE_LABEL: Record<string, string> = {
  button: 'button', link: 'link', textbox: 'textbox', checkbox: 'checkbox', radio: 'radio',
  combobox: 'select', slider: 'slider', tab: 'tab', menuitem: 'menuitem', option: 'option',
  heading: 'heading', iframe: 'frame', file: 'file', search: 'search'
};

function renderNode(n: SnapshotNode, prefix: string): string {
  const pad = '  '.repeat(Math.max(0, Math.min(Number(n.depth) || 0, 8)));
  const ref = n.ref ? refWithFrame(n.ref, prefix) : '   -  ';
  const role = ROLE_LABEL[n.role] || n.role;
  const bits = [`${pad}${ref}  ${role}`];
  if (n.name) bits.push(JSON.stringify(n.name));
  if (n.level) bits.push(`h${n.level}`);
  if (typeof n.value === 'string' && n.value) bits.push(`值=${JSON.stringify(n.value)}`);
  if (n.href) bits.push(`→ ${n.href}`);
  if (n.flags && n.flags.length) bits.push(`(${n.flags.join(',')})`);
  if (n.loc) bits.push(`loc=${n.loc}`);
  return bits.join(' ');
}

/** 子框架里的 ref 加 fN: 前缀,便于跨框架唯一定位 */
export function refWithFrame(ref: string, framePrefix?: string): string {
  return framePrefix ? `${framePrefix}:${ref}` : ref;
}

/**
 * 把快照数据渲染成模型读的文本。
 * 兼容 v1(只有 items/heads/text 的老扩展):老一份数据照样能渲染,不会因为版本错配变空。
 */
export function formatSnapshot(d: SnapshotData | null | undefined, opts: { showLoc?: boolean } = {}): string {
  const data = d || {};
  const lines: string[] = [];
  lines.push(`页面标题:${data.title || '(无标题)'}`);
  lines.push(`地址:${data.url || ''}`);
  const vp = data.viewport;
  if (vp) {
    lines.push(`视口:${vp.h || 0}px 高 · 已滚动 ${vp.scrollY || 0}/${vp.scrollHeight || 0}px`);
  }

  const nodes = Array.isArray(data.nodes) ? data.nodes : null;
  const items = Array.isArray(data.items) ? data.items : [];

  if (nodes && nodes.length) {
    const refs = nodes.filter((n) => n.ref).length;
    lines.push('');
    lines.push(`页面结构(${nodes.length} 个节点,${refs} 个可操作;ref 形如 ${nodes.find((n) => n.ref)?.ref || 'e1a2b'},跨快照稳定):`);
    lines.push(nodes.map((n) => renderNode(n, '')).join('\n'));
    if (Number(data.truncated) > 0) lines.push(`…(还有 ${data.truncated} 个节点未展示:滚动页面或用 scope=subtree 缩小范围)`);
  } else if (items.length) {
    // v1 兼容路径
    lines.push('');
    lines.push(`可交互元素(${items.length} 个,点击用 ref,如 e3):`);
    lines.push(items.join('\n'));
    const heads = Array.isArray(data.heads) ? data.heads : [];
    if (heads.length) {
      lines.push('');
      lines.push('标题结构:');
      lines.push(heads.join('\n'));
    }
  } else if (data.error) {
    lines.push('');
    lines.push(`(${data.error})`);
  }

  const frames = Array.isArray(data.frames) ? data.frames : [];
  for (const f of frames) {
    lines.push('');
    lines.push(`子框架 ${f.index}${f.name ? ` 「${f.name}」` : ''}:${f.url || '(空白)'}${f.note ? ` — ${f.note}` : ''}`);
    if (Array.isArray(f.nodes) && f.nodes.length) {
      lines.push(f.nodes.map((n) => renderNode(n, `f${f.index}`)).join('\n'));
    }
  }

  const text = String(data.text || '').trim();
  if (text) {
    lines.push('');
    lines.push('正文摘录:');
    lines.push(text.length > 2000 ? text.slice(0, 2000) + '\n…(已截断)' : text);
  }
  if (opts.showLoc === false) {
    return lines.join('\n').replace(/ loc=\S+/g, '');
  }
  return lines.join('\n');
}
