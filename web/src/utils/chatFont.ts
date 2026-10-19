// 对话字号:设置面板 + 快捷键共用的一处实现。
//
// 对齐 dsh 0.2.1-rc 的 `8096e18504 feat(web): add desktop conversation font size shortcuts`:
// 对话正文/代码/工具卡片的字号可整体缩放,并支持 Cmd/Ctrl + = / - 实时调整。
// 与浏览器自带缩放的区别:
//   - 只放大**内容**(对话正文与卡片),侧栏/顶栏等 chrome 尺寸不变,布局不会挤爆;
//   - 偏好持久化在本机,重装/刷新后一致(浏览器缩放是每站点每窗口的临时状态)。
//
// 实现方式:在 <html> 上写两个变量,样式表统一用 calc(基准px * var(--chat-scale)) 消费。
//   --chat-fs     当前对话基准字号(px 数字,便于设置页展示)
//   --chat-scale  = --chat-fs / 14 的无量纲倍率(样式表里直接参与 calc)
const STORAGE_KEY = 'teleforge.chat.font.v1';

/** 可选档位(基准 14 与现有样式一致,所以默认值不动任何像素) */
export const CHAT_FONT_SIZES = [12, 13, 14, 15, 16, 18] as const;
export const CHAT_FONT_DEFAULT = 14;
const MIN = CHAT_FONT_SIZES[0];
const MAX = CHAT_FONT_SIZES[CHAT_FONT_SIZES.length - 1];

/** 样式表里所有对话字号都以这个基准写 calc,改这里要同步改 CSS 的基准值 */
export const CHAT_FONT_BASE = 14;

const listeners = new Set<(px: number) => void>();
let current = CHAT_FONT_DEFAULT;

/** 读持久化的字号;非法/越界值一律回落默认(手改 localStorage 也不该把界面搞坏) */
export function readChatFont(): number {
  try {
    const raw = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(raw) && raw >= MIN && raw <= MAX) return Math.round(raw);
  } catch { /* 隐私模式 / 存储禁用:用默认值 */ }
  return CHAT_FONT_DEFAULT;
}

/** 当前生效字号(不读存储,避免每次渲染都碰 localStorage) */
export function currentChatFont(): number {
  return current;
}

/** 把字号写进 CSS 变量并持久化;返回真正生效的值(已 clamp 到档位范围) */
export function applyChatFont(px: number, persist = true): number {
  const next = Math.max(MIN, Math.min(MAX, Math.round(Number.isFinite(px) ? px : CHAT_FONT_DEFAULT)));
  current = next;
  const root = document.documentElement;
  root.style.setProperty('--chat-fs', String(next));
  root.style.setProperty('--chat-scale', String(next / CHAT_FONT_BASE));
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* 存不下就只在本次会话生效 */ }
  }
  for (const fn of listeners) fn(next);
  return next;
}

/** 按档位步进(不是按像素),这样连按几下能落在预设的档位上 */
export function stepChatFont(delta: number): number {
  const list = CHAT_FONT_SIZES;
  const at = list.findIndex((s) => s >= current);
  const idx = at === -1 ? list.length - 1 : at;
  // 当前值正好落在某档上时,按方向取相邻档;否则先归到最近的档
  const exact = list[idx] === current ? idx : (delta > 0 ? idx : Math.max(0, idx - 1));
  const next = list[Math.max(0, Math.min(list.length - 1, exact + delta))];
  return applyChatFont(next);
}

/** 订阅字号变化(设置面板据此重绘) */
export function onChatFontChange(fn: (px: number) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 焦点是否落在「不该被我们抢走快捷键」的表面:终端、代码编辑器、弹窗输入等 */
function isOwnedByRichSurface(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  return !!el.closest('.xterm, .cm-editor, textarea.codeedit, [contenteditable="true"], .mc-levels-body');
}

/**
 * 安装全局快捷键:Cmd/Ctrl + `=`(含 `Shift+=` 即 `+`)放大,Cmd/Ctrl + `-` 缩小。
 * 只在没有其它修饰键、非输入法组合、非重复触发时生效;命中后 preventDefault,
 * 免得浏览器把 Ctrl+`=` 当成页面缩放(整页缩放会把侧栏一起放大,和这里的意图不同)。
 */
export function installChatFontShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing || e.repeat) return;
    // macOS:只认 Cmd;其它平台:只认 Ctrl(与 dsh 的平台判定同一口径)
    const mac = /mac/i.test(navigator.platform || navigator.userAgent);
    if (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return;
    if (isOwnedByRichSurface(e.target)) return;
    const code = e.code;
    if (code !== 'Equal' && code !== 'Minus' && code !== 'NumpadAdd' && code !== 'NumpadSubtract') return;
    e.preventDefault();
    stepChatFont(code === 'Equal' || code === 'NumpadAdd' ? 1 : -1);
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}
