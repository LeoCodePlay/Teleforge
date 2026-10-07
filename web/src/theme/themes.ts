// ============================================================
// 主题系统(6 色驱动)
//
// 设计语言:实色界面 Solid UI(见 web/DESIGN_SYSTEM.md)
//   - 无毛玻璃 / 无模糊 / 无内高光 / 无光晕:所有表面都是不透明实色。
//   - 层次靠「表面明度差 + 1px 发丝描边 + 极淡单一投影」表达,而不是模糊。
//
// 唯一事实来源:用户只需要给出 6 个颜色,页面里出现的**每一个**颜色都由这 6 个色
// 派生而来(见 deriveThemeVars)。组件里不允许再出现任何硬编码色值。
//
//   1. bg       背景基色(页面底色,同时决定深色/浅色方向)
//   2. surface  表面色(顶栏/侧栏/面板/卡片/弹层)
//   3. text     文字主色(同时派生所有次级文字与描边深浅)
//   4. accent   强调色(主按钮/选中/链接/焦点)
//   5. success  成功色(连接正常/通过/diff 新增)
//   6. danger   危险色(错误/删除/diff 删除;警告色由它旋转色相派生)
//
// 唯一例外:终端 ANSI 色板与控制台/代码语法高亮(shiki)是为「内容可读性」服务的
// 独立调色板,不参与 6 色派生 —— 见 web/DESIGN_SYSTEM.md「例外」一节。
//
// 预设 4 套(三深一浅,不可删除)+ 用户自定义主题(localStorage 持久化)。
// ============================================================

export interface ThemeColors {
  /* 1. 背景基色 */
  bg: string;
  /* 2. 表面色 */
  surface: string;
  /* 3. 文字主色 */
  text: string;
  /* 4. 强调色 */
  accent: string;
  /* 5. 成功色 */
  success: string;
  /* 6. 危险色 */
  danger: string;
}

export interface ThemeTokens extends ThemeColors {
  name: string;
}

export interface ThemeDef extends ThemeTokens {
  id: string;
  /** true = 内置预设,不可删除 */
  preset?: boolean;
}

/** 主题 6 色 → CSS 变量名的映射(其余变量全部由 deriveThemeVars 派生) */
const VAR_MAP: Record<keyof ThemeColors, string> = {
  bg: '--bg-deep',
  surface: '--surface',
  text: '--text',
  accent: '--accent',
  success: '--green',
  danger: '--red'
};

/* ---------------- 颜色数学(全部接受 #hex / rgb() / rgba()) ---------------- */

type RGB = [number, number, number];

function parseColor(input: string): RGB {
  const s = String(input || '').trim();
  const rgb = s.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (rgb) return [Math.round(+rgb[1]), Math.round(+rgb[2]), Math.round(+rgb[3])];
  let h = s.replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6);
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 两色线性混合,t∈[0,1]:0 = 全 a,1 = 全 b */
function mixRgb(a: string, b: string, t: number): RGB {
  const ca = parseColor(a);
  const cb = parseColor(b);
  const k = clamp(t, 0, 1);
  return [
    Math.round(ca[0] + (cb[0] - ca[0]) * k),
    Math.round(ca[1] + (cb[1] - ca[1]) * k),
    Math.round(ca[2] + (cb[2] - ca[2]) * k)
  ];
}

const toRgb = (c: RGB) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
const toRgba = (c: RGB, a: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

function mix(a: string, b: string, t: number): string {
  return toRgb(mixRgb(a, b, t));
}

function withAlpha(color: string, a: number): string {
  return toRgba(parseColor(color), a);
}

/** 感知亮度(0-255):用于判断深浅方向与选取反色文字 */
function luminance(color: string): number {
  const [r, g, b] = parseColor(color);
  return (r * 299 + g * 587 + b * 114) / 1000;
}

function isDarkColor(color: string): boolean {
  return luminance(color) < 140;
}

/** sRGB 相对亮度(0-1,WCAG 定义),用于算真实对比度 */
function relLuminance(color: string): number {
  const [r, g, b] = parseColor(color).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度(1–21) */
function contrastRatio(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 取对比度更高的文字色:在主题自身的深浅两端里选对比度更高的那个,不引入调色板外颜色 */
function readableOn(color: string, lightest: string, darkest: string): string {
  return contrastRatio(color, lightest) >= contrastRatio(color, darkest) ? lightest : darkest;
}

/** HSL 色相旋转:把颜色绕色轮转动 deg 度(保持饱和度/明度,用于派生警告色等) */
function hueShift(color: string, deg: number): string {
  const [r0, g0, b0] = parseColor(color).map((v) => v / 255) as RGB;
  const max = Math.max(r0, g0, b0);
  const min = Math.min(r0, g0, b0);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r0) h = ((g0 - b0) / d) % 6;
    else if (max === g0) h = (b0 - r0) / d + 2;
    else h = (r0 - g0) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  h = (h + deg + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: RGB;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return toRgb(rgb.map((v) => Math.round((v + m) * 255)) as RGB);
}

/* ---------------- 派生令牌:6 色 → 全站每一个颜色 ---------------- */

/**
 * 把 6 个主题色展开成页面用到的全部 CSS 变量。
 * 深色主题向文字色(亮)偏移提亮、向背景色(暗)偏移下沉;浅色主题反向。
 * 组件只消费这些变量,因此不会出现「某个元素自带一种颜色」的情况。
 */
function deriveThemeVars(t: ThemeColors): Record<string, string> {
  const dark = isDarkColor(t.bg);

  /* 向文字色偏移:k 越大越「亮/深」,正是悬浮、选中、描边所需的提亮方向 */
  const tint = (k: number) => mix(t.surface, t.text, k);
  /* 向背景色偏移:k 越大越「下沉」,用于输入框/代码块这类内嵌槽 */
  const sink = (k: number) => mix(t.surface, t.bg, k);

  /* 主题自身的深浅两端,供反色文字与阴影取用,避免出现调色板外的白/黑 */
  const lightest = dark ? t.text : t.bg;
  const darkest = dark ? t.bg : t.text;
  /* 阴影:深色主题用背景色压暗亮面,浅色主题用文字色压暗浅面;两者都是实色的低透明投影 */
  const shade = (a: number) => (dark ? withAlpha(t.bg, a) : withAlpha(t.text, a));
  const sh1 = shade(dark ? 0.45 : 0.06);
  const sh2 = shade(dark ? 0.55 : 0.10);

  /* 警告色 = 危险色旋转色相(红 → 琥珀),保证只由 6 色派生 */
  const warn = hueShift(t.danger, 44);
  /* 上下文分项用的第二强调色 = 强调色旋转色相,与主色同族但不撞色 */
  const alt = hueShift(t.accent, 58);

  return {
    /* ---- 文字层级:从主题的 surface 向 text 插值,保证每一级都够读 ---- */
    '--text-2': tint(0.78),
    '--text-faint': dark ? tint(0.52) : tint(0.60),
    '--muted': tint(0.62),
    '--placeholder': withAlpha(t.text, 0.60),
    '--code-ink': t.text,
    '--danger': t.danger,
    '--ok': t.success,
    '--warn': warn,
    '--amber': warn,
    '--amber-bright': warn,

    /* ---- 表面:三级抬升 + 一级内嵌,全部不透明实色 ---- */
    '--surface-2': dark ? tint(0.05) : sink(0.34),
    '--surface-3': dark ? tint(0.10) : t.surface,
    '--surface-inset': sink(0.45),

    /* 顶栏/侧栏/底栏:与表面同色,靠发丝描边与主区分开 */
    '--bar-tint-a': t.surface,
    '--bar-tint-b': t.surface,
    '--bar-tint-strong-a': dark ? tint(0.05) : t.surface,
    '--bar-tint-strong-b': dark ? tint(0.03) : t.surface,

    /* 兼容层:老令牌名继续可用,值改为实色。
       --glass-border 与 --line 取同一个值:按钮/控件无论引用哪一个,描边都完全一致 */
    '--glass-bg': tint(0.04),
    '--glass-bg-strong': dark ? tint(0.10) : t.surface,
    '--glass-bg-hover': withAlpha(t.text, dark ? 0.12 : 0.11),
    '--glass-bg-inset': sink(0.45),
    '--glass-border': dark ? tint(0.13) : tint(0.18),
    '--glass-border-hover': dark ? tint(0.22) : tint(0.26),
    '--glass-hi': 'transparent',
    '--glass-lo': 'transparent',
    '--glass-shadow': `0 1px 2px ${sh1}, 0 6px 18px ${sh2}`,
    '--glass-shadow-lg': `0 2px 6px ${sh1}, 0 18px 44px ${sh2}`,

    /* 弹层/下拉/右键菜单表面 */
    '--pop-bg': dark ? tint(0.10) : t.surface,
    '--pop-bg-lo': dark ? tint(0.10) : t.surface,
    '--pop-bg-strong': dark ? tint(0.14) : t.surface,

    /* 填充与交互态。
       注意:悬浮态一律用「以文字色为底的半透明叠加」,而不是固定实色 ——
       列表行可能盖在 surface / pop-bg / 卡片 等不同层上,固定实色无法保证
       「比父层更亮」,会出现"行悬浮和父面板几乎同色、悬浮等于没有"的问题;
       半透明叠加无论盖在哪一层上都能给出稳定可辨的亮(深色)/暗(浅色)变化。 */
    '--fill-1': dark ? tint(0.03) : sink(0.20),
    '--fill-1-lo': dark ? tint(0.02) : sink(0.14),
    '--fill-2': dark ? tint(0.06) : sink(0.28),
    '--fill-2-lo': dark ? tint(0.04) : sink(0.20),
    '--row-hover': withAlpha(t.text, dark ? 0.09 : 0.08),
    '--hover-bg': withAlpha(t.text, dark ? 0.12 : 0.11),
    '--hover-bg-strong': withAlpha(t.text, dark ? 0.16 : 0.14),
    '--hover-bg-hard': withAlpha(t.text, dark ? 0.21 : 0.18),
    '--ins-hl': 'transparent',

    /* 代码/内嵌表面 */
    '--code-bg': sink(0.42),
    '--code-bg-soft': sink(0.28),
    '--code-bg-solid': sink(0.55),
    '--code-bor': dark ? tint(0.10) : tint(0.12),
    '--bg-code': sink(0.42),
    /* 终端:两方向都取主题最深端,保证终端内容对比度 */
    '--xterm-bg': darkest,

    /* ---- 描边 ---- */
    '--line-faint': dark ? tint(0.07) : tint(0.10),
    '--line-soft': dark ? tint(0.10) : tint(0.14),
    '--line': dark ? tint(0.13) : tint(0.18),
    '--line-strong': dark ? tint(0.22) : tint(0.26),
    '--line-dash': dark ? tint(0.20) : tint(0.24),
    '--border': dark ? tint(0.13) : tint(0.18),

    /* ---- 强调色族 ---- */
    '--accent-2': mix(t.accent, t.text, 0.35),
    '--accent-glow': withAlpha(t.accent, 0.20),
    '--accent-soft': withAlpha(t.accent, dark ? 0.14 : 0.10),
    '--accent-fill': withAlpha(t.accent, dark ? 0.18 : 0.12),
    '--accent-fill-soft': withAlpha(t.accent, dark ? 0.10 : 0.07),
    '--accent-fill-hover': withAlpha(t.accent, dark ? 0.06 : 0.04),
    '--accent-border': withAlpha(t.accent, dark ? 0.50 : 0.48),
    '--focus-ring': withAlpha(t.accent, 0.35),
    '--sel-glow': withAlpha(t.accent, dark ? 0.28 : 0.18),

    /* ---- 语义状态 ---- */
    '--ok-bg': withAlpha(t.success, 0.10),
    '--ok-border': withAlpha(t.success, dark ? 0.36 : 0.38),
    '--err-bg': withAlpha(t.danger, dark ? 0.11 : 0.10),
    '--err-border': withAlpha(t.danger, dark ? 0.40 : 0.45),
    '--err-text': mix(t.danger, t.text, 0.10),
    '--warn-bg': withAlpha(warn, dark ? 0.11 : 0.12),
    '--warn-border': withAlpha(warn, dark ? 0.38 : 0.42),
    '--danger-fill': withAlpha(t.danger, 0.12),
    '--danger-soft': withAlpha(t.danger, dark ? 0.14 : 0.10),
    '--danger-soft-strong': withAlpha(t.danger, 0.24),
    '--running': mix(t.accent, t.text, 0.15),
    '--run-border': withAlpha(t.accent, dark ? 0.42 : 0.34),
    '--violet': alt,
    '--violet-glow': withAlpha(alt, 0.45),

    /* ---- 主按钮:强调色实心,反色文字由主题深浅两端选取 ---- */
    '--btn-a': t.accent,
    '--btn-b': t.accent,
    '--btn-hover-a': mix(t.accent, t.text, dark ? 0.14 : 0.10),
    '--btn-hover-b': mix(t.accent, t.text, dark ? 0.20 : 0.16),
    '--btn-text': readableOn(t.accent, lightest, darkest),
    '--btn-sheen': 'transparent',
    '--btn-bor': withAlpha(t.accent, 0.45),

    /* ---- 危险按钮 ---- */
    '--btn-danger-a': t.danger,
    '--btn-danger-b': t.danger,
    '--btn-danger-text': readableOn(t.danger, lightest, darkest),
    '--btn-danger-bor': withAlpha(t.danger, 0.45),
    '--btn-danger-glow': withAlpha(t.danger, 0.18),

    /* ---- 品牌字标:文字色 → 强调色的实色渐变 ---- */
    '--brand-a': t.text,
    '--brand-b': t.accent,

    /* ---- 开关 ---- */
    '--switch-track': tint(dark ? 0.22 : 0.20),
    '--switch-knob': lightest,

    /* ---- 滚动条 ---- */
    '--scroll-thumb': withAlpha(t.text, dark ? 0.26 : 0.28),
    '--scroll-thumb-hover': withAlpha(t.text, dark ? 0.42 : 0.46),
    '--scroll-thumb-x': withAlpha(t.text, 0.34),

    /* ---- 进度条/遮罩 ---- */
    '--progress-track': tint(dark ? 0.10 : 0.12),
    '--mask-bg': withAlpha(t.bg, dark ? 0.72 : 0.55),
    '--glare': 'transparent',

    /* ---- 变更对比:新增走成功色、删除走危险色,不再单独配色 ---- */
    '--diff-add-bg': withAlpha(t.success, dark ? 0.15 : 0.14),
    '--diff-add-gutter': withAlpha(t.success, dark ? 0.22 : 0.20),
    '--diff-add-marker': t.success,
    '--diff-del-bg': withAlpha(t.danger, dark ? 0.14 : 0.13),
    '--diff-del-gutter': withAlpha(t.danger, dark ? 0.22 : 0.20),
    '--diff-del-marker': t.danger
  };
}

/** 把主题 token 写入 document.documentElement 内联 CSS 变量(覆盖 :root 默认值) */
export function applyTheme(t: ThemeTokens): void {
  const root = document.documentElement;
  for (const [field, varName] of Object.entries(VAR_MAP)) {
    root.style.setProperty(varName, (t as any)[field]);
  }
  for (const [varName, value] of Object.entries(deriveThemeVars(t))) {
    root.style.setProperty(varName, value);
  }
  const dark = isDarkColor(t.bg);
  // 原生控件/滚动条跟随主题深浅(dark 主题用深色原生 UI,浅色主题用浅色)
  root.style.colorScheme = dark ? 'dark' : 'light';
  // 亮暗标记:给**不能用 CSS 变量表达**的地方用(shiki 双主题 token 写在行内样式上,
  // 只能靠属性选择器 + !important 覆盖;见 ChangesReview.scss)
  root.dataset.dark = dark ? '1' : '0';
}

/* ---------------- 预设主题(四套,三深一浅,不可删除) ---------------- */

const INK: ThemeDef = {
  id: 'ink',
  name: '墨黑',
  preset: true,
  bg: '#0d0f13',
  surface: '#16191f',
  text: '#e7eaf0',
  accent: '#5b8cff',
  success: '#3fb26f',
  danger: '#ef5f5f'
};

const GRAPHITE: ThemeDef = {
  id: 'graphite',
  name: '石墨',
  preset: true,
  bg: '#0d1117',
  surface: '#171b22',
  text: '#e6edf3',
  accent: '#2cc4b8',
  success: '#3fb950',
  danger: '#f0564a'
};

const DUSK: ThemeDef = {
  id: 'dusk',
  name: '暮色',
  preset: true,
  bg: '#141110',
  surface: '#1e1a17',
  text: '#f0e9e1',
  accent: '#e3a343',
  success: '#5cba7d',
  danger: '#e5624f'
};

const PAPER: ThemeDef = {
  id: 'paper',
  name: '纸白',
  preset: true,
  bg: '#eef1f5',
  surface: '#ffffff',
  text: '#16191f',
  accent: '#2563eb',
  success: '#1a7f4b',
  danger: '#c93a3a'
};

export const PRESET_THEMES: ThemeDef[] = [INK, GRAPHITE, DUSK, PAPER];

/* ---------------- 自定义主题持久化(localStorage) ---------------- */

export interface PersistedThemeState {
  /** 当前激活的主题 id */
  active: string;
  /** 用户自定义主题列表 */
  custom: ThemeDef[];
}

const STORAGE_KEY = 'sshai.themes';

function sanitize(o: any): PersistedThemeState {
  const custom = Array.isArray(o?.custom)
    ? o.custom.filter((t: any) => t && typeof t.id === 'string' && typeof t.name === 'string')
    : [];
  const active = typeof o?.active === 'string' ? o.active : PRESET_THEMES[0].id;
  return { active, custom };
}

export function loadThemeState(): PersistedThemeState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitize(JSON.parse(raw));
  } catch { /* 损坏数据按默认处理 */ }
  return { active: PRESET_THEMES[0].id, custom: [] };
}

export function saveThemeState(s: PersistedThemeState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* 存储不可用时仅会话内生效 */ }
}

/** 全部主题:预设在前,自定义在后 */
export function getAllThemes(state: PersistedThemeState): ThemeDef[] {
  return [...PRESET_THEMES, ...(state?.custom || [])];
}

export function getTheme(id: string, state: PersistedThemeState): ThemeDef | undefined {
  return getAllThemes(state).find((t) => t.id === id);
}

/* ---------------- 自定义主题构建 ---------------- */

/** 自定义主题只需要 6 个颜色 + 一个名字 */
export type CustomThemeDraft = ThemeTokens;

export function newThemeId(): string {
  return `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 从 6 个颜色构建一套完整主题(颜色即全部,无需再补任何派生值) */
export function buildCustomTheme(id: string, d: ThemeTokens): ThemeDef {
  return {
    id,
    name: (d.name || '').trim() || '未命名主题',
    preset: false,
    bg: d.bg,
    surface: d.surface,
    text: d.text,
    accent: d.accent,
    success: d.success,
    danger: d.danger
  };
}

/** 从现有主题抽取可编辑草稿(用于「新建/编辑」表单预填) */
export function toDraft(t: ThemeDef): CustomThemeDraft {
  return {
    name: t.name,
    bg: t.bg,
    surface: t.surface,
    text: t.text,
    accent: t.accent,
    success: t.success,
    danger: t.danger
  };
}

/** 启动时应用持久化的激活主题(渲染前调用,避免首帧闪回默认色) */
export function applyActiveTheme(): string {
  const st = loadThemeState();
  const t = getTheme(st.active, st);
  if (t) applyTheme(t);
  return st.active;
}
