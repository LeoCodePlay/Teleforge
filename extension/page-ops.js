// 页面操作层:快照 / 元素定位 / 可操作性检查 / 交互 / 批处理,全部走 CDP。
//
// 设计要点(与旧版的差别):
//   1) 快照脚本由服务端下发(不在这里存一份),保证真机与内置预览逐字一致;
//   2) v2 快照带 fN: 前缀的子框架 ref,点击/输入按前缀路由回对应 frame;
//   3) 每个动作先过 actionability:存在 / 可见 / 未禁用 / 不被遮挡 / 位置稳定,失败会明确说原因;
//   4) batch 让"一整段流程"只走一次 WS 往返(模型侧也只一次往返);
//   5) 后台标签用 Emulation.setFocusEmulationEnabled 保证输入能进页面。
import { attach, onEvent, sendCommand } from './cdp.js';

const ATTR = 'data-tp-ref';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_TIMEOUT = 6000;

// ---------------- 每标签状态(console / 网络 / 弹窗) ----------------

const states = new Map();

function tabState(tabId) {
  let s = states.get(tabId);
  if (!s) {
    s = {
      inited: false,
      logs: [],
      lastDialog: null,
      dialogPolicy: 'dismiss',
      inflight: new Set(),
      runtimeOn: false,
      networkOn: false,
      lastPoint: null
    };
    states.set(tabId, s);
  }
  return s;
}

function pushLog(s, line) {
  const t = String(line || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!t) return;
  s.logs.push(`${new Date().toISOString().slice(11, 19)} ${t}`);
  if (s.logs.length > 60) s.logs.splice(0, s.logs.length - 60);
}

/** 每个标签第一次被操作时做一次:attach + 订阅页面事件(弹窗必须提前订阅,否则会卡住页面) */
export async function init(tabId) {
  await attach(tabId);
  const s = tabState(tabId);
  if (s.inited) return;
  s.inited = true;
  onEvent(tabId, (method, params) => {
    if (method === 'Page.javascriptDialogOpening') {
      s.lastDialog = `${params.type || 'dialog'}: ${params.message || ''}`;
      // 不处理弹窗会让后续所有 CDP 调用卡住,所以一律按策略立刻处置
      sendCommand(tabId, 'Page.handleJavaScriptDialog', { accept: s.dialogPolicy === 'accept' }).catch(() => {});
      return;
    }
    if (method === 'Page.frameNavigated' && !(params.frame && params.frame.parentId)) {
      s.inflight.clear();
      return;
    }
    if (method === 'Network.requestWillBeSent') { s.inflight.add(params.requestId); return; }
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') { s.inflight.delete(params.requestId); return; }
    if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' ');
      pushLog(s, `${params.type || 'log'}: ${text}`);
      return;
    }
    if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails || {};
      pushLog(s, `pageerror: ${(d.exception && d.exception.description) || d.text || ''}`);
    }
  });
}

/** 打开 console 采集(会开 Runtime 域:页面理论上能探测到调试器,所以只在真的要读日志时开) */
async function ensureRuntime(tabId) {
  const s = tabState(tabId);
  if (s.runtimeOn) return;
  await sendCommand(tabId, 'Runtime.enable');
  s.runtimeOn = true;
}

/** 打开网络计数(Network 域同理,按需开) */
async function ensureNetwork(tabId) {
  const s = tabState(tabId);
  if (s.networkOn) return;
  await sendCommand(tabId, 'Network.enable');
  s.networkOn = true;
}

// ---------------- 基础执行 ----------------

export async function evaluate(tabId, expression, { awaitPromise = false, contextId = null, returnByValue = true } = {}) {
  const params = { expression, returnByValue, awaitPromise, userGesture: true };
  if (contextId) params.contextId = contextId;
  const r = await sendCommand(tabId, 'Runtime.evaluate', params);
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || '页面脚本执行出错');
  }
  return r && r.result ? r.result.value : undefined;
}

// ---------------- 框架 ----------------

/** 子框架列表(深度优先,顺序稳定):快照里的 fN 前缀就是这里的第 N 个 */
export async function frames(tabId) {
  const tree = await sendCommand(tabId, 'Page.getFrameTree');
  const out = [];
  const walk = (node) => {
    for (const child of (node && node.childFrames) || []) {
      const f = child.frame || {};
      out.push({ frameId: f.id, parentId: f.parentId || null, url: f.url || '', name: f.name || '' });
      walk(child);
    }
  };
  walk(tree && tree.frameTree);
  return out;
}

/** 为某个 frame 建一个隔离世界并拿 executionContextId(同名 world 会复用) */
async function contextFor(tabId, frameId) {
  try {
    const r = await sendCommand(tabId, 'Page.createIsolatedWorld', { frameId, worldName: 'teleforge-agent' });
    return r && r.executionContextId != null ? r.executionContextId : null;
  } catch {
    // 跨进程(OOPIF)框架可能拿不到:调用方降级为"只报告 url,不操作"
    return null;
  }
}

/**
 * 子框架内容区相对主视口的偏移(点击用的坐标是主框架坐标系)。
 * 逐级向上取 iframe 元素的 rect + border + padding,因为 iframe 的内容视口从内容盒开始。
 */
async function frameOffset(tabId, frameId, list) {
  let offset = { x: 0, y: 0 };
  let cur = list.find((f) => f.frameId === frameId) || null;
  let guard = 0;
  await sendCommand(tabId, 'DOM.enable').catch(() => { /* 老版本可能不支持,后面会各自报错 */ });
  while (cur && cur.parentId && guard++ < 6) {
    const parent = list.find((f) => f.frameId === cur.parentId) || null;
    const parentCtx = parent ? await contextFor(tabId, parent.frameId) : null;
    try {
      const owner = await sendCommand(tabId, 'DOM.getFrameOwner', { frameId: cur.frameId });
      const node = await sendCommand(tabId, 'DOM.resolveNode', {
        backendNodeId: owner.backendNodeId,
        ...(parentCtx ? { executionContextId: parentCtx } : {})
      });
      const r = await sendCommand(tabId, 'Runtime.callFunctionOn', {
        objectId: node.object.objectId,
        returnByValue: true,
        functionDeclaration: 'function(){'
          + 'const r=this.getBoundingClientRect();const cs=getComputedStyle(this);'
          + 'const n=(v)=>parseFloat(v)||0;'
          + 'return {x:r.left+n(cs.borderLeftWidth)+n(cs.paddingLeft),y:r.top+n(cs.borderTopWidth)+n(cs.paddingTop)};}'
      });
      const v = (r && r.result && r.result.value) || { x: 0, y: 0 };
      offset.x += Number(v.x) || 0;
      offset.y += Number(v.y) || 0;
    } catch { /* 拿不到偏移就按 0 处理(会让点击落偏,但至少给出明确失败) */ }
    cur = parent;
  }
  return offset;
}

// ---------------- 元素定位 ----------------

/**
 * 生成"定位元素"的 JS 片段:执行后作用域里有 el / how / findErr。
 * 三段式:ref(shadow DOM 内也能命中,靠快照时建的 __tpRefs)→ CSS → 可见文本。
 */
function finderCode(target) {
  const R = JSON.stringify(String(target.ref || ''));
  const S = JSON.stringify(String(target.selector || ''));
  const T = JSON.stringify(String(target.text || ''));
  return `
    const __R=${R}, __S=${S}, __T=${T};
    const clean=(v)=>String(v==null?'':v).replace(/\\s+/g,' ').trim();
    const __refs=globalThis.__tpRefs;
    let el=null, how='', findErr='';
    if(__R){ el=(__refs&&__refs.get(__R))||document.querySelector('[${ATTR}="'+__R.replace(/"/g,'')+'"]'); how='ref='+__R; }
    if(!el&&__S){ try{ el=document.querySelector(__S); how='selector='+__S; }catch(e){ findErr='选择器不合法:'+__S; } }
    if(!el&&!findErr&&__T){
      const cands=document.querySelectorAll('a,button,input,textarea,select,label,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="switch"],[contenteditable="true"]');
      for(const e of cands){ const r0=e.getBoundingClientRect(); if(r0.width<=1||r0.height<=1) continue;
        const s=clean(e.innerText||e.textContent||e.value||e.getAttribute('aria-label')||e.getAttribute('placeholder'));
        if(s&&s.indexOf(__T)>=0){ el=e; break; } }
      how='text='+__T;
    }
  `;
}

/** 判断 node 是否在 el 内部(要穿过 shadow 边界:contains 不过边界) */
const INSIDE_FN = `
const __inside=(node,target)=>{let n=node;while(n){if(n===target)return true;if(n.nodeType===11&&n.host){n=n.host;continue;}n=n.parentNode;}return false;};
const __hitOk=(hit,el)=>{
  if(!hit) return false;
  if(__inside(hit,el)) return true;
  // elementFromPoint 在影子树里常常返回宿主元素(而不是影子里的按钮):宿主的渲染内容就是影子树,
  // 所以命中宿主(或宿主的祖先)也算命中了目标。
  let root=el.getRootNode?el.getRootNode():null;
  while(root&&root.host){ if(hit===root.host||__inside(hit,root.host)) return true; root=root.host.getRootNode(); }
  return false;
};
`;

/**
 * actionability 检查:元素在不在、可不可见、禁没禁用、被没被挡、坐标稳不稳。
 * 返回 { ok:true, x, y, label } 或 { ok:false, retry, err } / { ok:false, fatal, err }。
 */
function resolveExpr(target) {
  return `(() => {
    ${finderCode(target)}
    ${INSIDE_FN}
    if(findErr) return {ok:false,fatal:true,err:findErr};
    if(!el) return {ok:false,retry:true,err:'没找到匹配的元素('+(__R?'ref='+__R:__S?'选择器 '+__S:'文本「'+__T+'」')+')'};
    if(!el.isConnected) return {ok:false,retry:true,err:'元素已从页面上移除(页面重新渲染了,重新快照拿新 ref)'};
    if(el.disabled===true||el.getAttribute('aria-disabled')==='true') return {ok:false,retry:true,err:'元素是禁用状态'};
    const st=getComputedStyle(el);
    if(st.visibility==='hidden'||st.display==='none'||parseFloat(st.opacity)===0) return {ok:false,retry:true,err:'元素不可见(display/visibility/opacity)'};
    try{ el.scrollIntoView({block:'center',inline:'center'}); }catch(e){ try{ el.scrollIntoView(); }catch(e2){} }
    const r=el.getBoundingClientRect();
    if(r.width<=1||r.height<=1) return {ok:false,retry:true,err:'元素尺寸为 0(还没渲染出来)'};
    if(r.bottom<0||r.right<0||r.top>innerHeight||r.left>innerWidth) return {ok:false,retry:true,err:'元素在视口外(滚动没生效)'};
    const cx=Math.round(r.left+r.width/2), cy=Math.round(r.top+r.height/2);
    const hit=document.elementFromPoint(cx,cy);
    if(!hit) return {ok:false,retry:true,err:'该坐标上没有元素(可能刚移出视口)'};
    if(!__hitOk(hit,el)){
      const tag=(hit.tagName||'').toLowerCase();
      const nm=clean(hit.getAttribute('aria-label')||hit.id||hit.className||tag).slice(0,40);
      return {ok:false,retry:true,err:'元素被遮挡:'+tag+(nm?' '+nm:'')};
    }
    const tag=(el.tagName||'').toLowerCase();
    return {ok:true,x:cx,y:cy,w:Math.round(r.width),h:Math.round(r.height),tag,
      sensitive:(el.getAttribute('type')||'').toLowerCase()==='password',
      label:how+' → '+(clean(el.getAttribute('aria-label'))||clean(el.getAttribute('placeholder'))||clean(el.innerText||'')||tag).slice(0,50)};
  })()`;
}

/** 轮询到元素可操作为止;拿到坐标后再等 60ms 复核一次,避免点在动画中途 */
async function resolveTarget(tabId, target, { contextId = null, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const expr = resolveExpr(target);
  const deadline = Date.now() + Math.max(300, Number(timeoutMs) || DEFAULT_TIMEOUT);
  let last = null;
  let lastOk = null;
  let prevKey = '';
  while (Date.now() < deadline) {
    const r = await evaluate(tabId, expr, { contextId });
    if (r && r.fatal) throw new Error(r.err);
    if (r && r.ok) {
      const key = `${r.x},${r.y},${r.w},${r.h}`;
      if (key === prevKey) return r;
      prevKey = key;
      lastOk = r;
      await sleep(60);
      continue;
    }
    prevKey = '';
    last = r;
    await sleep(120);
  }
  if (lastOk) return lastOk;
  throw new Error((last && last.err) || '定位元素超时');
}

/** 定位 + 换算成主视口坐标(fN: 前缀会路由到子框架) */
async function locate(tabId, target, opts = {}) {
  const raw = String(target.ref || '');
  const m = /^f(\d+):(.+)$/.exec(raw);
  let contextId = null;
  let offset = { x: 0, y: 0 };
  let inner = { ...target };
  if (m) {
    const list = await frames(tabId);
    const f = list[Number(m[1]) - 1];
    if (!f) throw new Error(`子框架 f${m[1]} 已经不在了(页面变了?),请重新 browser_snapshot`);
    contextId = await contextFor(tabId, f.frameId);
    if (contextId == null) {
      throw new Error(`子框架 f${m[1]}(${f.url || '同源空白'})是跨进程框架,扩展读不到它的 DOM;`
        + '这个框架里的操作请改用内置预览(target=preview),或让用户在新标签直接打开该地址');
    }
    inner = { ...target, ref: m[2] };
    offset = await frameOffset(tabId, f.frameId, list);
  }
  const hit = await resolveTarget(tabId, inner, { contextId, timeoutMs: opts.timeoutMs || target.timeoutMs });
  return { ...hit, x: hit.x + offset.x, y: hit.y + offset.y, contextId };
}

// ---------------- 视觉反馈:AI 光标 + 目标高亮 ----------------

async function paintOverlay(tabId, point, label) {
  const s = tabState(tabId);
  s.lastPoint = { x: point.x, y: point.y };
  const text = String(label || '').slice(0, 60);
  const expr = `(() => {
    const id='__tp_cursor__';
    const old=document.getElementById(id); if(old) old.remove();
    const d=document.createElement('div'); d.id=id;
    d.style.cssText='position:fixed;left:${Math.round(point.x)}px;top:${Math.round(point.y)}px;width:0;height:0;z-index:2147483647;pointer-events:none';
    const ring=document.createElement('div');
    ring.style.cssText='position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2px solid #ff3b6b;box-shadow:0 0 0 4px rgba(255,59,107,.25)';
    const dot=document.createElement('div');
    dot.style.cssText='position:absolute;left:-3px;top:-3px;width:6px;height:6px;border-radius:50%;background:#ff3b6b';
    const tip=document.createElement('div');
    tip.textContent=${JSON.stringify(text)};
    tip.style.cssText='position:absolute;left:18px;top:-10px;white-space:nowrap;font:12px/1.4 system-ui,sans-serif;color:#fff;background:#ff3b6b;padding:2px 6px;border-radius:4px;opacity:.95;max-width:320px;overflow:hidden;text-overflow:ellipsis';
    d.append(ring,dot,tip);
    (document.documentElement||document.body).appendChild(d);
    setTimeout(()=>{ try{ d.remove(); }catch(e){} }, 1200);
    return true;
  })()`;
  await evaluate(tabId, expr).catch(() => {});
}

// ---------------- 交互 ----------------

async function mouse(tabId, type, point, extra = {}) {
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type, x: point.x, y: point.y, ...extra });
}

export async function click(tabId, p = {}) {
  const t = await locate(tabId, p);
  await paintOverlay(tabId, t, p.label || t.label);
  await mouse(tabId, 'mouseMoved', t, { button: 'none' });
  await mouse(tabId, 'mousePressed', t, { button: 'left', clickCount: 1 });
  await mouse(tabId, 'mouseReleased', t, { button: 'left', clickCount: 1 });
  return `已点击:${t.label}${t.sensitive ? '(密码框)' : ''}`;
}

export async function hover(tabId, p = {}) {
  const t = await locate(tabId, p);
  await paintOverlay(tabId, t, p.label || t.label);
  await mouse(tabId, 'mouseMoved', t, { button: 'none' });
  return `已悬停:${t.label}`;
}

export async function dblclick(tabId, p = {}) {
  const t = await locate(tabId, p);
  await paintOverlay(tabId, t, p.label || t.label);
  await mouse(tabId, 'mouseMoved', t, { button: 'none' });
  await mouse(tabId, 'mousePressed', t, { button: 'left', clickCount: 1 });
  await mouse(tabId, 'mouseReleased', t, { button: 'left', clickCount: 1 });
  await mouse(tabId, 'mousePressed', t, { button: 'left', clickCount: 2 });
  await mouse(tabId, 'mouseReleased', t, { button: 'left', clickCount: 2 });
  return `已双击:${t.label}`;
}

export async function rightClick(tabId, p = {}) {
  const t = await locate(tabId, p);
  await paintOverlay(tabId, t, p.label || t.label);
  await mouse(tabId, 'mouseMoved', t, { button: 'none' });
  await mouse(tabId, 'mousePressed', t, { button: 'right', clickCount: 1 });
  await mouse(tabId, 'mouseReleased', t, { button: 'right', clickCount: 1 });
  return `已右键:${t.label}`;
}

/** 读回输入框当前内容(用于校验:中文第一次插入被 IME/渲染吞掉时能发现) */
async function readInput(tabId, target, contextId) {
  const expr = `(() => {
    ${finderCode(target)}
    if(!el) return {ok:false};
    const active = document.activeElement === el
      || (el.getRootNode && document.activeElement === el.getRootNode().host);
    const value = el.isContentEditable
      ? String(el.innerText || '')
      : (el.value !== undefined ? String(el.value) : String(el.textContent || ''));
    return {ok:true, active: !!active, value};
  })()`;
  return await evaluate(tabId, expr, { contextId });
}

/** 内容是否已经正确落进去(容忍 maxlength 截断) */
function textMatches(value, text, clear) {
  const v = String(value == null ? '' : value);
  const t = String(text == null ? '' : text);
  if (!t) return true;
  if (v.includes(t)) return true;
  if (v.length > 0 && t.startsWith(v)) return true;
  if (clear === false && v.endsWith(t)) return true;
  return false;
}

/**
 * 兜底写入:execCommand('insertText') 走浏览器编辑管线(React/富文本都能感知),
 * 再不行就直接用原生 value setter + input/change 事件。只在 insertText 校验失败时用。
 */
async function insertByFallback(tabId, target, text, contextId) {
  const expr = `(() => {
    ${finderCode(target)}
    if(!el) return {ok:false,err:'元素已经不在了'};
    try { el.focus(); } catch(e) {}
    const t = ${JSON.stringify(String(text == null ? '' : text))};
    if (el.isContentEditable) {
      try { document.execCommand('insertText', false, t); } catch(e) {}
      return {ok:true, how:'execCommand'};
    }
    if (el.value !== undefined) {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      if (desc && desc.set) desc.set.call(el, t); else el.value = t;
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
      return {ok:true, how:'value-setter'};
    }
    return {ok:false, err:'目标既不是输入框也不可编辑'};
  })()`;
  return await evaluate(tabId, expr, { contextId });
}

export async function type(tabId, p = {}) {
  const t = await locate(tabId, p);
  const expr = `(() => {
    ${finderCode(p)}
    if(findErr) return {ok:false,err:findErr};
    if(!el) return {ok:false,err:'没找到输入框'};
    try{ el.scrollIntoView({block:'center'}); }catch(e){}
    el.focus();
    if(${p.clear !== false}){
      if(typeof el.select==='function'&&el.value!==undefined){ el.select(); }
      else if(el.isContentEditable){ const r=document.createRange(); r.selectNodeContents(el); const s=getSelection(); s.removeAllRanges(); s.addRange(r); }
      else if(el.value!==undefined){ el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); }
    }
    return {ok:true,tag:(el.tagName||'').toLowerCase(),sensitive:(el.getAttribute('type')||'').toLowerCase()==='password'};
  })()`;
  const focused = await evaluate(tabId, expr, { contextId: t.contextId });
  if (!focused || !focused.ok) throw new Error((focused && focused.err) || '聚焦输入框失败');
  // 等焦点真正落到目标上:焦点没落定时,第一批字符会进到别的元素或被 IME 组合掉
  for (let i = 0; i < 6; i++) {
    const st = await readInput(tabId, p, t.contextId).catch(() => null);
    if (st && st.ok && st.active) break;
    await sleep(60);
  }
  await paintOverlay(tabId, t, p.label || t.label);
  // insertText 是浏览器层面的文本插入:会正常触发 input 事件,React/Vue 都能感知
  await sendCommand(tabId, 'Input.insertText', { text: String(p.text == null ? '' : p.text) });
  let how = 'insertText';
  let st = await readInput(tabId, p, t.contextId).catch(() => null);
  if (!st || !st.ok || !textMatches(st.value, p.text, p.clear)) {
    // 中文/组合输入在部分站点上第一次会被吞或变成乱码:兜底重写一次再校验,
    // 而不是把错误内容留在页面上让模型再花一轮去发现并修改。
    const fb = await insertByFallback(tabId, p, p.text, t.contextId).catch(() => null);
    if (fb && fb.ok) how = fb.how;
    st = await readInput(tabId, p, t.contextId).catch(() => null);
    if (!st || !st.ok || !textMatches(st.value, p.text, p.clear)) {
      const got = st && st.ok ? String(st.value).slice(0, 60) : '(读不到回值)';
      throw new Error(`输入校验失败:期望「${String(p.text).slice(0, 60)}」,实际「${got}」。`
        + '可能目标不是可编辑元素,或页面在输入后立即重置了内容。');
    }
  }
  if (p.submit) await press(tabId, 'Enter');
  return `已输入到 ${t.label}${p.submit ? ',并回车提交' : ''}${focused.sensitive ? '(密码框,内容不记录)' : ''}`
    + (how !== 'insertText' ? `(经 ${how} 兜底)` : '');
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9, text: '\t' },
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
    type: 'keyDown', modifiers, key: def.key, code: def.code,
    windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk
  };
  if (modifiers === 0 && def.text !== undefined) down.text = def.text;
  await sendCommand(tabId, 'Input.dispatchKeyEvent', down);
  await sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', modifiers, key: def.key, code: def.code,
    windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk
  });
  return `已按键:${key}`;
}

export async function scroll(tabId, p = {}) {
  const amount = Math.abs(Number(p.amount) || 600);
  const dy = String(p.direction || '').toLowerCase() === 'up' ? -amount : amount;
  let x = null;
  let y = null;
  if (p.ref || p.selector) {
    const t = await locate(tabId, p);
    x = t.x; y = t.y;
  } else {
    const vp = await evaluate(tabId, '(() => ({ w: innerWidth, h: innerHeight }))()').catch(() => null);
    x = Math.round(((vp && vp.w) || 1280) / 2);
    y = Math.round(((vp && vp.h) || 800) / 2);
  }
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
  return `已向${dy > 0 ? '下' : '上'}滚动 ${amount}px`;
}

export async function select(tabId, p = {}) {
  const t = await locate(tabId, p);
  const expr = `(() => {
    ${finderCode(p)}
    if(!el) return {ok:false,err:'没找到下拉框'};
    if(el.tagName!=='SELECT') return {ok:false,err:'目标不是 <select>(当前 '+el.tagName+')'};
    const wantValue=${JSON.stringify(String(p.value || ''))}, wantLabel=${JSON.stringify(String(p.label || ''))};
    const opts=[...el.options];
    const opt=opts.find(o=>wantValue&&o.value===wantValue)||opts.find(o=>wantLabel&&clean(o.textContent)===wantLabel)||opts.find(o=>wantLabel&&clean(o.textContent).includes(wantLabel));
    if(!opt) return {ok:false,err:'没有匹配的选项:'+(wantValue||wantLabel)};
    el.value=opt.value;
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return {ok:true,text:clean(opt.textContent),value:opt.value};
  })()`;
  const r = await evaluate(tabId, expr, { contextId: t.contextId });
  if (!r || !r.ok) throw new Error((r && r.err) || '选择失败');
  return `已选择「${r.text}」:${t.label}`;
}

export async function upload(tabId, p = {}) {
  const files = (Array.isArray(p.files) ? p.files : []).map(String).filter(Boolean);
  if (!files.length) throw new Error('files 不能为空(要给绝对路径)');
  const t = await locate(tabId, p);
  const expr = `(() => { ${finderCode(p)} return el; })()`;
  const r = await sendCommand(tabId, 'Runtime.evaluate', {
    expression: expr, contextId: t.contextId, returnByValue: false
  });
  if (r && r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '定位文件输入框失败');
  const objectId = r && r.result && r.result.objectId;
  if (!objectId) throw new Error('没找到文件输入框(上传控件可能还没出现)');
  await sendCommand(tabId, 'DOM.enable').catch(() => {});
  const node = await sendCommand(tabId, 'DOM.requestNode', { objectId });
  if (!node || !node.nodeId) throw new Error('无法把元素转成 DOM 节点');
  await sendCommand(tabId, 'DOM.setFileInputFiles', { files, nodeId: node.nodeId });
  return `已上传 ${files.length} 个文件到 ${t.label}`;
}

export async function pageText(tabId, { max = 2000 } = {}) {
  const text = await evaluate(tabId, '(() => String((document.body && document.body.innerText) || ""))()').catch(() => '');
  const limit = Math.max(100, Math.min(Number(max) || 2000, 20000));
  const t = String(text || '').replace(/\s+\n/g, '\n').trim();
  return t ? (t.length > limit ? t.slice(0, limit) + '\n…(已截断)' : t) : '(页面没有正文)';
}

export async function assertText(tabId, { text, exists = true } = {}) {
  const want = String(text || '');
  if (!want) throw new Error('assertText 需要 text');
  const body = await evaluate(tabId, '(() => String((document.body && document.body.innerText) || ""))()').catch(() => '');
  const has = String(body || '').includes(want);
  if (has !== (exists !== false)) {
    throw new Error(`断言失败:期望页面${exists !== false ? '包含' : '不包含'}「${want}」,实际${has ? '包含' : '不包含'}`);
  }
  return `断言通过:页面${exists !== false ? '包含' : '不包含'}「${want}」`;
}

/** URL 通配匹配(与内置预览一致:支持 ** 通配) */
function urlMatches(pattern, url) {
  if (!pattern) return false;
  const re = new RegExp('^' + String(pattern).split('**').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(url) || url.includes(String(pattern).replace(/\*\*/g, ''));
}

export async function wait(tabId, { text, selector, url, timeoutMs = 8000 } = {}) {
  const budget = Math.min(Math.max(Number(timeoutMs) || 8000, 300), 60_000);
  const deadline = Date.now() + budget;
  const wantText = String(text || '');
  const wantSel = String(selector || '');
  const wantUrl = String(url || '');
  const expr = `(() => {
    const out={url:location.href,title:document.title,textOk:null,selOk:null};
    if(${JSON.stringify(wantText)}) out.textOk=String((document.body&&document.body.innerText)||'').indexOf(${JSON.stringify(wantText)})>=0;
    if(${JSON.stringify(wantSel)}){ try{ const el=document.querySelector(${JSON.stringify(wantSel)}); out.selOk=!!el&&el.getBoundingClientRect().width>1; }catch(e){ out.selOk=false; } }
    return out;
  })()`;
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
    await sleep(200);
  }
  const parts = [wantText && `文本「${wantText}」`, wantSel && `选择器 ${wantSel}`, wantUrl && `URL ${wantUrl}`].filter(Boolean);
  throw new Error(`等待超时(${budget}ms):${parts.join(' / ')} 未出现。当前地址:${(last && last.url) || '(未知)'}`);
}

// ---------------- 导航 ----------------

export async function navigate(tabId, url) {
  await sendCommand(tabId, 'Page.navigate', { url });
  return waitForLoad(tabId, url);
}

export async function waitForLoad(tabId, fallbackUrl = '') {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(150);
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { throw new Error('标签已关闭'); }
    if (tab.status === 'complete') return { url: tab.url || fallbackUrl, title: tab.title || '', error: null };
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return { url: (tab && tab.url) || fallbackUrl, title: (tab && tab.title) || '', error: '页面在 30s 内没有加载完成' };
}

// ---------------- 快照 ----------------

function buildSnapshotExpr(scriptSrc, opts) {
  return `(${scriptSrc})(${JSON.stringify(opts || {})})`;
}

/**
 * 抓快照:主文档 + 子框架(最多 6 个)。
 * 跨进程(OOPIF)框架拿不到 isolated world,只在结果里标出 url —— 不假装成功。
 */
export async function snapshot(tabId, scriptSrc, opts = {}) {
  if (!scriptSrc) throw new Error('快照脚本还没下发(扩展刚连接上),请稍后重试');
  const data = (await evaluate(tabId, buildSnapshotExpr(scriptSrc, {
    scope: opts.scope, root: opts.root, text: opts.text, max: opts.max
  }))) || { v: 2, nodes: [] };
  if (opts.frames === false) return data;
  const list = await frames(tabId);
  if (!list.length) return data;
  const out = [];
  for (let i = 0; i < list.length && i < 6; i++) {
    const f = list[i];
    const ctx = await contextFor(tabId, f.frameId);
    if (ctx == null) {
      out.push({ index: i + 1, url: f.url, name: f.name || undefined, note: '跨进程框架(扩展读不到其 DOM);要看内容请用 target=preview' });
      continue;
    }
    try {
      const d = await evaluate(tabId, buildSnapshotExpr(scriptSrc, { scope: 'viewport', max: 60 }), { contextId: ctx });
      out.push({ index: i + 1, url: f.url, name: f.name || undefined, nodes: (d && d.nodes) || [], note: d && d.error ? d.error : undefined });
    } catch (e) {
      out.push({ index: i + 1, url: f.url, name: f.name || undefined, note: `读取失败:${(e && e.message) || e}` });
    }
  }
  data.frames = out;
  return data;
}

// ---------------- 截图 ----------------

export async function screenshot(tabId, { fullPage = false, overlay = false } = {}) {
  const s = tabState(tabId);
  if (overlay && s.lastPoint) await paintOverlay(tabId, s.lastPoint, 'AI 操作位置');
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

export async function dialog(tabId, { accept } = {}) {
  const s = tabState(tabId);
  if (typeof accept === 'boolean') s.dialogPolicy = accept ? 'accept' : 'dismiss';
  return `弹窗策略:${s.dialogPolicy === 'accept' ? '自动接受' : '自动关闭'}${s.lastDialog ? `;最近一次弹窗:${s.lastDialog}` : ';最近没有弹窗'}`;
}

export async function consoleLogs(tabId) {
  await ensureRuntime(tabId);
  const s = tabState(tabId);
  return s.logs.length ? s.logs.join('\n') : '(页面没有 console 输出)';
}

export async function networkIdle(tabId, { timeoutMs = 10_000 } = {}) {
  await ensureNetwork(tabId);
  const s = tabState(tabId);
  const deadline = Date.now() + Math.max(1000, Math.min(Number(timeoutMs) || 10_000, 60_000));
  let quietSince = 0;
  while (Date.now() < deadline) {
    if (s.inflight.size === 0) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= 500) return '网络已空闲';
    } else {
      quietSince = 0;
    }
    await sleep(100);
  }
  return `等待网络空闲超时(还有 ${s.inflight.size} 个请求未结束,页面可能有长连接/轮询),继续操作`;
}

// ---------------- 通用动作分发 ----------------

export async function act(tabId, action, p = {}) {
  switch (String(action || '').toLowerCase()) {
    case 'hover': return hover(tabId, p);
    case 'dblclick': return dblclick(tabId, p);
    case 'rightclick': return rightClick(tabId, p);
    case 'select': return select(tabId, p);
    case 'upload': return upload(tabId, p);
    case 'dialog': return dialog(tabId, p);
    case 'console': case 'logs': return consoleLogs(tabId);
    case 'networkidle': return networkIdle(tabId, p);
    case 'text': return pageText(tabId, p);
    case 'assert': return assertText(tabId, p);
    case 'click': return click(tabId, p);
    case 'type': case 'fill': return type(tabId, p);
    case 'press': return press(tabId, p.key || 'Enter');
    case 'scroll': return scroll(tabId, p);
    default: throw new Error(`未知动作:${action}(可用 hover/dblclick/rightClick/select/upload/dialog/console/networkIdle/text/assert)`);
  }
}

// ---------------- 批处理 ----------------

async function runStep(tabId, step, scriptSrc) {
  const op = String(step.op || '').toLowerCase();
  switch (op) {
    case 'click': return click(tabId, step);
    case 'type': case 'fill': return type(tabId, { ...step, text: String(step.text == null ? '' : step.text) });
    case 'hover': return hover(tabId, step);
    case 'dblclick': return dblclick(tabId, step);
    case 'rightclick': return rightClick(tabId, step);
    case 'select': return select(tabId, step);
    case 'upload': return upload(tabId, step);
    case 'press': return press(tabId, String(step.key || 'Enter'));
    case 'scroll': return scroll(tabId, step);
    case 'navigate': case 'goto': {
      if (!step.url) throw new Error('navigate 需要 url');
      const r = await navigate(tabId, String(step.url));
      if (r.error) throw new Error(r.error);
      return `已打开:${r.url}`;
    }
    case 'wait': return wait(tabId, step);
    case 'load': case 'waitforload': return (await waitForLoad(tabId)).error || '页面已加载';
    case 'networkidle': return networkIdle(tabId, step);
    case 'assert': return assertText(tabId, step);
    case 'text': return pageText(tabId, step);
    case 'eval': {
      const expr = String(step.expression || step.value || '');
      if (!expr) throw new Error('eval 需要 expression');
      const r = await evaluate(tabId, expr);
      return typeof r === 'string' ? r : JSON.stringify(r == null ? null : r);
    }
    default:
      throw new Error(`未知操作:${op}(可用 click/type/press/scroll/navigate/wait/hover/dblclick/rightClick/select/upload/networkIdle/assert/text/eval/load)`);
  }
}

/**
 * 一次跑完整段流程:模型只往返一次,扩展内部按步执行。
 * 失败默认就此打住(避免在错误页面上继续点),并把失败步和后面的步数如实报告。
 */
export async function batch(tabId, steps, opts = {}, scriptSrc = '') {
  const list = Array.isArray(steps) ? steps.slice(0, 60) : [];
  if (!list.length) throw new Error('steps 不能为空');
  const results = [];
  let failedAt = null;
  for (let i = 0; i < list.length; i++) {
    const step = list[i] || {};
    const op = String(step.op || '');
    try {
      const detail = await runStep(tabId, step, scriptSrc);
      results.push({ index: i + 1, op, ok: true, detail: String(detail == null ? '' : detail) });
    } catch (e) {
      results.push({ index: i + 1, op, ok: false, detail: String((e && e.message) || e) });
      failedAt = i + 1;
      if (opts.stopOnError !== false) break;
    }
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const policy = opts.snapshot || 'on_error';
  let snapshotData;
  if (scriptSrc && (policy === 'always' || (policy === 'on_error' && failedAt !== null))) {
    snapshotData = await snapshot(tabId, scriptSrc, {}).catch(() => undefined);
  }
  return {
    ok: failedAt === null,
    steps: results,
    failedAt,
    url: (tab && tab.url) || '',
    title: (tab && tab.title) || '',
    snapshotData
  };
}
