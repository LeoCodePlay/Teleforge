/* ============================================================
   覆盖式悬浮滚动条(自定义滚动条引擎)
   原生滚动条在 styles.scss 中全局隐藏(不参与布局),
   滚动条出现/消失不会引起页面宽度抖动。

   行为:
   - 滚动发生时,在容器边缘悬浮显示细窄滚动条拇指;
   - 停止滚动 IDLE_MS(3s)后自动淡出;
   - 支持鼠标拖拽(与原生滚动条行为一致);
   - 终端(xterm)、文本域、表格等保留自身的原生滚动条,不被接管。
   ============================================================ */

const IDLE_MS = 3000;      // 停止滚动后多久淡出
const REVEAL_MS = 1200;    // 首屏初始化时短暂点亮,让用户看到当前滚动位置
const MIN_THUMB = 28;      // 拇指最小长度
const THUMB_GAP = 2;       // 拇指距容器内边缘
const AUTO_SCROLL = /(?:auto|scroll|overlay)/;

interface ObState {
  v?: HTMLDivElement;   // 垂直拇指
  h?: HTMLDivElement;   // 水平拇指
  timer?: number;       // 淡出定时器
  host?: HTMLElement;   // 拇指宿主(挂载与定位容器,缺省为滚动元素自身)
}

const states = new Map<HTMLElement, ObState>();

/* ---------- 拇指宿主 ----------
   默认拇指挂在滚动元素自身:绝对定位于其内容坐标系,随内容一起滚动,绘制时需加回 scrollTop。
   通过 setScrollbarHost 可把拇指挂到外部宿主(如聊天面板整列容器):拇指不再随内容滚动,
   轨道为宿主的完整可见高度——滚动条得以跨越滚动区之外的区域(如聊天输入区),视觉上铺满整列。 */
const hosts = new WeakMap<HTMLElement, HTMLElement>();

/** 为滚动元素指定外部拇指宿主(host 为 null 时解除,回落为挂载在滚动元素自身) */
export function setScrollbarHost(el: HTMLElement, host: HTMLElement | null): void {
  if (host) hosts.set(el, host); else hosts.delete(el);
  const s = states.get(el);
  if (s) { s.v?.remove(); s.h?.remove(); s.v = undefined; s.h = undefined; s.host = undefined; }
}

function getHost(el: HTMLElement): HTMLElement {
  return hosts.get(el) || el;
}

/* ---------- 排除规则:这些元素保留原生滚动条 ---------- */
function isExcluded(el: HTMLElement): boolean {
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'INPUT' || tag === 'TABLE' || tag === 'IFRAME') return true;
  if ('obSkip' in el.dataset) return true; // 显式豁免:data-ob-skip
  return el.closest('.xterm') !== null;    // xterm 终端自带滚动条
}

function isAxisScrollable(cs: CSSStyleDeclaration, axis: 'x' | 'y'): boolean {
  return AUTO_SCROLL.test(axis === 'y' ? cs.overflowY : cs.overflowX);
}

function computeOverflow(el: HTMLElement, cs: CSSStyleDeclaration): { v: boolean; h: boolean } {
  // 测量前先隐藏本容器的拇指:拇指是绝对定位子元素,位置可达 scrollHeight 底部,
  // 内容整段替换后残留的旧拇指会撑大 scrollHeight,造成"因拇指而可滚动"的自引用——
  // 内容其实已变短,却仍报告可滚动,旧拇指得以残留、滚动位置卡在旧底部。
  // 先隐藏拇指再测,得到的才是真实溢出。
  const s = states.get(el);
  const vPrev = s?.v ? s.v.style.display : null;
  const hPrev = s?.h ? s.h.style.display : null;
  if (s?.v) s.v.style.display = 'none';
  if (s?.h) s.h.style.display = 'none';
  const out = {
    v: isAxisScrollable(cs, 'y') && el.scrollHeight - el.clientHeight > 1,
    h: isAxisScrollable(cs, 'x') && el.scrollWidth - el.clientWidth > 1
  };
  if (vPrev != null && s?.v) s.v.style.display = vPrev;
  if (hPrev != null && s?.h) s.h.style.display = hPrev;
  return out;
}

/* 让容器成为绝对定位拇指的包含块(static -> relative 不影响布局) */
function ensureContainingBlock(el: HTMLElement): void {
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
}

function makeThumb(el: HTMLElement, host: HTMLElement, axis: 'v' | 'h'): HTMLDivElement {
  const div = document.createElement('div');
  div.className = axis === 'v' ? 'ob-thumb ob-v' : 'ob-thumb ob-h';
  div.setAttribute('aria-hidden', 'true');
  host.appendChild(div);
  bindDrag(div, el, axis);
  return div;
}

/* 重算拇指位置与尺寸
   注意:绝对定位的子元素位于容器内容坐标系中,会随 scrollTop/scrollLeft 一起滚动,
   因此要把滚动量加回去,拇指才能相对"可见视口"保持不动。
   关键:拇指自身会把 scrollHeight/scrollWidth 撑大(自引用)。若用含拇指的
   scrollHeight 计算,内容整段变短后(如切换会话)旧拇指会把滚动区撑在旧长度上,
   "滚到底"落在拇指区的空白处,随后「重绘→scrollTop 被钳制→scroll 事件→再重绘」
   形成每帧缩几像素的反馈循环——表现为切换后白屏 + 内容缓缓下落约 1 秒。
   因此测量必须在同轴拇指隐藏后进行(隐藏拇指迫使布局重算,scrollTop 也随之
   钳制到真实底部),保证算出的拇指位置永远落在真实内容边界内。 */
function paint(el: HTMLElement, s: ObState, cs: CSSStyleDeclaration, ov: { v: boolean; h: boolean }): void {
  const host = s.host || el;
  if (ov.v) {
    const thumb = s.v ?? (s.v = makeThumb(el, host, 'v'));
    thumb.style.display = 'none'; // 隐藏同轴拇指后再读,拿到不含拇指的真实高度
    const ch = el.clientHeight;
    const sh = el.scrollHeight;
    const maxV = Math.max(sh - ch, 1);
    // 轨道高度:宿主模式下为宿主可见高度(拇指可跨越滚动区之外),否则为容器自身高度;
    // 拇指长度按「可见内容占比 × 轨道」折算,宿主模式下即按整列轨道等比呈现
    const trackH = host === el ? ch : host.clientHeight;
    const th = Math.max(MIN_THUMB, Math.round((ch * trackH) / sh));
    const hPx = Math.min(Math.max(th, 16), trackH - THUMB_GAP * 2);
    const track = Math.max(trackH - hPx - THUMB_GAP * 2, 1);
    const ratio = Math.min(Math.max(el.scrollTop / maxV, 0), 1);
    thumb.style.height = `${hPx}px`;
    // 拇指在滚动元素自身坐标系内会随 scrollTop 一起滚动,需加回;宿主坐标系不滚动,不加
    thumb.style.top = `${THUMB_GAP + ratio * track + (host === el ? el.scrollTop : 0)}px`;
    thumb.style.display = 'block';
  } else if (s.v) {
    s.v.style.display = 'none';
  }
  if (ov.h) {
    const thumb = s.h ?? (s.h = makeThumb(el, host, 'h'));
    thumb.style.display = 'none'; // 同上:水平拇指会撑大 scrollWidth,隐藏后测真实宽度
    const cw = el.clientWidth;
    const sw = el.scrollWidth;
    const maxH = Math.max(sw - cw, 1);
    const trackW = host === el ? cw : host.clientWidth;
    const tw = Math.max(MIN_THUMB, Math.round((cw * trackW) / sw));
    const wPx = Math.min(Math.max(tw, 16), trackW - THUMB_GAP * 2);
    const track = Math.max(trackW - wPx - THUMB_GAP * 2, 1);
    const ratio = Math.min(Math.max(el.scrollLeft / maxH, 0), 1);
    thumb.style.width = `${wPx}px`;
    thumb.style.left = `${THUMB_GAP + ratio * track + (host === el ? el.scrollLeft : 0)}px`;
    thumb.style.display = 'block';
  } else if (s.h) {
    s.h.style.display = 'none';
  }
}

/* 点亮拇指,并在 idleMs 后淡出
   instant=true:强制重算场景(整段内容替换/会话切换)下暂时去掉透明度过渡,
   让拇指在同一帧立即就位,而不是再花 0.18s 淡入("滚动条没有立即显示")。 */
function flash(el: HTMLElement, idleMs: number, instant = false): void {
  if (isExcluded(el)) return;
  const cs = getComputedStyle(el);
  if (cs.display === 'none') return;
  const ov = computeOverflow(el, cs);
  if (!ov.v && !ov.h) {
    hide(el);
    // 真实不可滚动:移除拇指节点与状态。仅淡出不够——残留的绝对定位拇指仍在 DOM 里
    // 占据 scrollHeight,继续让容器"看起来可滚动"(旧滚动位置卡住,内容看不见)。
    const st = states.get(el);
    if (st) { st.v?.remove(); st.h?.remove(); states.delete(el); }
    return;
  }
  let s = states.get(el);
  if (!s) {
    s = {};
    states.set(el, s);
  }
  // 宿主可能随时注册/更换:换宿主时丢弃旧拇指(旧坐标系作废),在新宿主上重建
  const host = getHost(el);
  if (s.host !== host) {
    s.v?.remove(); s.h?.remove(); s.v = undefined; s.h = undefined;
    s.host = host;
    ensureContainingBlock(host); // 让宿主成为绝对定位拇指的包含块
  }
  if (instant) {
    s.v?.style.setProperty('transition', 'none');
    s.h?.style.setProperty('transition', 'none');
  }
  paint(el, s, cs, ov);
  s.v?.classList.add('ob-on');
  s.h?.classList.add('ob-on');
  if (instant) {
    // 下一帧恢复过渡,保留停止滚动后的淡出与悬停反馈
    requestAnimationFrame(() => {
      s.v?.style.removeProperty('transition');
      s.h?.style.removeProperty('transition');
    });
  }
  window.clearTimeout(s.timer);
  s.timer = window.setTimeout(hide, idleMs, el, s);
}

function hide(el: HTMLElement, s?: ObState): void {
  const st = s ?? states.get(el);
  if (!st) return;
  st.v?.classList.remove('ob-on');
  st.h?.classList.remove('ob-on');
  st.timer = undefined;
}

/* ---------- 滚动监听:捕获阶段一次监听,接管所有容器 ---------- */
const pending = new Set<HTMLElement>();
let rafPending = 0;

function onScroll(e: Event): void {
  const t = e.target;
  if (!(t instanceof HTMLElement) || t === document.body || t === document.documentElement) return;
  if (isExcluded(t)) return;
  pending.add(t);
  if (!rafPending) {
    rafPending = requestAnimationFrame(() => {
      rafPending = 0;
      const batch = Array.from(pending);
      pending.clear();
      for (const el of batch) flash(el, IDLE_MS);
    });
  }
}

function relayoutAll(): void {
  for (const el of Array.from(states.keys())) flash(el, IDLE_MS);
}

/* 定时清理已卸载容器的状态避免泄漏 */
function prune(): void {
  for (const [el, s] of states) {
    if (!el.isConnected || el.closest('.xterm')) {
      s.v?.remove();
      s.h?.remove();
      states.delete(el);
    }
  }
}

/* ---------- 鼠标拖拽 ---------- */
function bindDrag(thumb: HTMLDivElement, el: HTMLElement, axis: 'v' | 'h'): void {
  thumb.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const isV = axis === 'v';
    const start = isV ? e.clientY : e.clientX;
    const startScroll = isV ? el.scrollTop : el.scrollLeft;
    const maxScroll = (isV ? el.scrollHeight : el.scrollWidth) - (isV ? el.clientHeight : el.clientWidth);
    const trackLen = (isV ? el.clientHeight : el.clientWidth) - (isV ? thumb.offsetHeight : thumb.offsetWidth) - THUMB_GAP * 2;
    if (maxScroll <= 0 || trackLen <= 0) return;
    thumb.setPointerCapture(e.pointerId);
    document.body.classList.add('ob-dragging');
    const onMove = (ev: PointerEvent) => {
      const delta = (isV ? ev.clientY : ev.clientX) - start;
      if (isV) el.scrollTop = startScroll + (delta / trackLen) * maxScroll;
      else el.scrollLeft = startScroll + (delta / trackLen) * maxScroll;
    };
    const onUp = () => {
      thumb.removeEventListener('pointermove', onMove);
      document.body.classList.remove('ob-dragging');
      try { thumb.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
    };
    thumb.addEventListener('pointermove', onMove);
    thumb.addEventListener('pointerup', onUp, { once: true });
    thumb.addEventListener('pointercancel', onUp, { once: true });
  });
}

/* ---------- 初始化 ---------- */
// 模块加载即挂监听(React 尚未渲染也能捕获到滚动)
document.addEventListener('scroll', onScroll, { capture: true, passive: true });
window.addEventListener('resize', relayoutAll);
window.setInterval(prune, 4000);

let revealed = false;

/** 首屏点亮一次既有滚动容器的拇指,方便用户看到当前滚动位置(可重复调用,幂等) */
export function initOverlayScrollbar(): void {
  if (revealed) return;
  revealed = true;
  // 全量扫描可能触发大量布局读取,分批跨帧执行避免首屏卡顿
  const els = Array.from(document.querySelectorAll<HTMLElement>('*'));
  let i = 0;
  const step = () => {
    const end = Math.min(i + 150, els.length);
    for (; i < end; i++) {
      const el = els[i];
      if (!isExcluded(el)) flash(el, REVEAL_MS);
    }
    if (i < els.length) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** 内容变化后强制重算指定容器(缺省全部)的悬浮滚动条。
    引擎平时只靠 scroll/resize 事件驱动,React 整段替换内容(如切换会话)不一定触发
    scroll 事件;且残留的绝对定位拇指会撑大 scrollHeight(自引用),让内容变短后
    仍报告可滚动、旧拇指残留、滚动位置卡在旧底部——由调用方在内容提交后调用,
    flash 会用「隐藏拇指后测量」的真实溢出判断:不可滚动则移除拇指,可滚动则重绘位置。
    instant=true 时拇指跳过淡入、立即显示(会话切换等强制重算场景)。 */
export function refreshOverlayScrollbar(el?: HTMLElement | null, instant = false): void {
  if (el) flash(el, IDLE_MS, instant);
  else relayoutAll();
}