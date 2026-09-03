// ============================================================
// 主题系统集中管理
// 所有主题样式(色板)统一在此定义;应用时把 token 写入
// document.documentElement 的内联 CSS 变量,覆盖 styles.scss 的 :root 默认值。
// 四套内置预设(三深一浅,不可删除) + 用户自定义主题(localStorage 持久化)。
// 新增/修改主题只需改这里的 token 定义,无需动组件样式。
// ============================================================

export interface ThemeTokens {
  name: string;
  /* 深空底色 */
  bgDeep: string;
  /* 极光光斑(背景玻璃的生命线) */
  aurora1: string;
  aurora2: string;
  aurora3: string;
  /* 玻璃材质 */
  glassBg: string;
  glassBgStrong: string;
  glassBgHover: string;
  glassBgInset: string;
  glassBorder: string;
  glassBorderHover: string;
  glassHi: string;
  glassLo: string;
  glassShadow: string;
  glassShadowLg: string;
  /* 文字与语义色 */
  text: string;
  muted: string;
  accent: string;
  accent2: string;
  accentGlow: string;
  accentSoft: string;
  green: string;
  red: string;
  amber: string;
}

export interface ThemeDef extends ThemeTokens {
  id: string;
  /** true = 内置预设,不可删除 */
  preset?: boolean;
}

/** ThemeTokens 字段 → CSS 变量名的映射(必须与 styles.scss :root 一致) */
const VAR_MAP: Record<Exclude<keyof ThemeTokens, 'name'>, string> = {
  bgDeep: '--bg-deep',
  aurora1: '--aurora-1',
  aurora2: '--aurora-2',
  aurora3: '--aurora-3',
  glassBg: '--glass-bg',
  glassBgStrong: '--glass-bg-strong',
  glassBgHover: '--glass-bg-hover',
  glassBgInset: '--glass-bg-inset',
  glassBorder: '--glass-border',
  glassBorderHover: '--glass-border-hover',
  glassHi: '--glass-hi',
  glassLo: '--glass-lo',
  glassShadow: '--glass-shadow',
  glassShadowLg: '--glass-shadow-lg',
  text: '--text',
  muted: '--muted',
  accent: '--accent',
  accent2: '--accent-2',
  accentGlow: '--accent-glow',
  accentSoft: '--accent-soft',
  green: '--green',
  red: '--red',
  amber: '--amber'
};

/** 深色背景专用的玻璃材质(白色半透明,浅色前景) */
const WHITE_GLASS = {
  glassBg: 'rgba(255,255,255,.055)',
  glassBgStrong: 'rgba(255,255,255,.09)',
  glassBgHover: 'rgba(255,255,255,.12)',
  glassBgInset: 'rgba(6,9,18,.42)',
  glassBorder: 'rgba(255,255,255,.14)',
  glassBorderHover: 'rgba(255,255,255,.28)',
  glassHi: 'rgba(255,255,255,.30)',
  glassLo: 'rgba(255,255,255,.04)',
  /* 阴影一律用柔和的深蓝薄雾(非纯黑),配合顶部高光形成"光线感"层次 */
  glassShadow: '0 2px 6px rgba(4,9,20,.18), 0 10px 28px rgba(4,9,20,.22)',
  glassShadowLg: '0 4px 12px rgba(4,9,20,.20), 0 24px 64px rgba(4,9,20,.30)'
};

/** 浅色背景专用的玻璃材质(白色磨砂,深色文字,整体通透) */
const LIGHT_GLASS = {
  glassBg: 'rgba(255,255,255,.58)',
  glassBgStrong: 'rgba(255,255,255,.74)',
  glassBgHover: 'rgba(255,255,255,.85)',
  glassBgInset: 'rgba(15,23,42,.06)',
  glassBorder: 'rgba(15,23,42,.12)',
  glassBorderHover: 'rgba(15,23,42,.26)',
  glassHi: 'rgba(255,255,255,.80)',
  glassLo: 'rgba(255,255,255,.04)',
  /* 浅色主题:极低透明度的蓝灰分层漫射阴影,柔和不发黑 */
  glassShadow: '0 2px 4px rgba(15,23,42,.03), 0 8px 24px rgba(15,23,42,.05)',
  glassShadowLg: '0 4px 10px rgba(15,23,42,.04), 0 18px 48px rgba(15,23,42,.07)'
};

/* ---------------- 预设主题(四套,三深一浅,不可删除) ---------------- */

const NEBULA: ThemeDef = {
  id: 'nebula',
  name: '深空冰蓝',
  preset: true,
  bgDeep: '#05070f',
  aurora1: 'rgba(58,118,255,.17)',
  aurora2: 'rgba(130,84,255,.13)',
  aurora3: 'rgba(38,196,255,.10)',
  ...WHITE_GLASS,
  text: '#e2e8f0',
  muted: '#8a93a6',
  accent: '#6aa8ff',
  accent2: '#8dbdff',
  accentGlow: 'rgba(106,168,255,.45)',
  accentSoft: 'rgba(106,168,255,.14)',
  green: '#4ade80',
  red: '#fb7185',
  amber: '#fbbf24'
};

const VIOLET: ThemeDef = {
  id: 'violet',
  name: '紫夜星云',
  preset: true,
  bgDeep: '#0b0616',
  aurora1: 'rgba(167,80,255,.20)',
  aurora2: 'rgba(90,60,255,.16)',
  aurora3: 'rgba(255,80,180,.10)',
  ...WHITE_GLASS,
  text: '#f0e9fb',
  muted: '#a99fbf',
  accent: '#c084fc',
  accent2: '#d8b4fe',
  accentGlow: 'rgba(192,132,252,.45)',
  accentSoft: 'rgba(192,132,252,.16)',
  green: '#4ade80',
  red: '#fb7185',
  amber: '#fbbf24'
};

const EMERALD: ThemeDef = {
  id: 'emerald',
  name: '翠林幽光',
  preset: true,
  bgDeep: '#04120c',
  aurora1: 'rgba(52,211,153,.16)',
  aurora2: 'rgba(56,189,248,.10)',
  aurora3: 'rgba(74,222,128,.10)',
  ...WHITE_GLASS,
  text: '#e6f7ef',
  muted: '#8fb8a8',
  accent: '#34d399',
  accent2: '#6ee7b7',
  accentGlow: 'rgba(52,211,153,.40)',
  accentSoft: 'rgba(52,211,153,.14)',
  green: '#4ade80',
  red: '#fb7185',
  amber: '#fbbf24'
};

const DAWN: ThemeDef = {
  id: 'dawn',
  name: '晨光云白',
  preset: true,
  bgDeep: '#eef2fa',
  aurora1: 'rgba(96,165,250,.26)',
  aurora2: 'rgba(196,181,253,.22)',
  aurora3: 'rgba(125,211,252,.20)',
  ...LIGHT_GLASS,           // 浅色背景用白色磨砂玻璃,保持通透与层次
  text: '#1e293b',
  muted: '#5b6b82',
  accent: '#3b82f6',
  accent2: '#93c5fd',
  accentGlow: 'rgba(59,130,246,.32)',
  accentSoft: 'rgba(59,130,246,.14)',
  green: '#16a34a',
  red: '#e11d48',
  amber: '#d97706'
};

export const PRESET_THEMES: ThemeDef[] = [NEBULA, VIOLET, EMERALD, DAWN];

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

/* ---------------- 应用主题 ---------------- */

/** 方向化派生令牌:根据主题深浅方向,把页面所有叠加/表面/线条/按钮/状态色统一派生。
    深色主题 = 白色叠加系(近黑实体表面),浅色主题 = 深色叠加系(近白实体表面),
    保证样式表与组件里不再出现与主题无关的硬编码颜色。 */
function deriveThemeVars(t: ThemeTokens): Record<string, string> {
  const dark = isDarkColor(t.bgDeep);
  const ov = (a: number) => dark ? `rgba(255,255,255,${a})` : `rgba(15,23,42,${a})`;
  return {
    /* 文字层级 */
    '--text-2': dark ? '#c3cbe0' : '#475569',          /* 次级文字(标题/链接/摘要) */
    '--text-faint': dark ? '#6b7385' : '#64748b',      /* 弱化文字(分隔点/字段键/时钟) */
    '--code-ink': dark ? '#e4eaf3' : '#1e293b',        /* 代码表面上的文字(随主题翻转) */
    '--placeholder': dark ? 'rgba(138,147,166,.7)' : 'rgba(100,116,139,.7)',
    '--running': '#5686fe',                            /* 运行中蓝(StateDot/todo 前导) */

    /* 页面级玻璃条(顶栏/侧栏/底部工具栏/输入卡) */
    '--bar-tint-a': dark ? ov(0.08) : 'rgba(255,255,255,.52)',
    '--bar-tint-b': dark ? ov(0.03) : 'rgba(255,255,255,.30)',
    '--bar-tint-strong-a': dark ? ov(0.16) : 'rgba(255,255,255,.62)',
    '--bar-tint-strong-b': dark ? ov(0.07) : 'rgba(255,255,255,.40)',

    /* 面板/卡片叠加填充 */
    '--fill-1': dark ? ov(0.06) : ov(0.05),
    '--fill-1-lo': dark ? ov(0.02) : ov(0.02),
    '--fill-2': dark ? ov(0.10) : ov(0.07),
    '--fill-2-lo': dark ? ov(0.04) : ov(0.03),

    /* hover/active 填充与内嵌高光 */
    '--hover-bg': dark ? ov(0.05) : ov(0.05),
    '--hover-bg-strong': dark ? ov(0.09) : ov(0.08),
    '--hover-bg-hard': dark ? ov(0.16) : ov(0.12),
    '--row-hover': dark ? ov(0.04) : ov(0.04),
    '--ins-hl': dark ? ov(0.05) : ov(0.04),

    /* 线条 */
    '--line-faint': dark ? ov(0.05) : ov(0.06),
    '--line-soft': dark ? ov(0.07) : ov(0.08),
    '--line': dark ? ov(0.09) : ov(0.10),
    '--line-strong': dark ? ov(0.18) : ov(0.18),
    '--line-dash': dark ? ov(0.18) : ov(0.24),

    /* 实体表面(弹窗/下拉/右键菜单/Toast) */
    '--pop-bg': dark ? 'rgba(30,38,58,.92)' : 'rgba(255,255,255,.97)',
    '--pop-bg-lo': dark ? 'rgba(18,23,38,.86)' : 'rgba(248,250,253,.94)',
    '--pop-bg-strong': dark ? 'rgba(20,26,42,.94)' : 'rgba(255,255,255,.98)',

    /* 代码类表面(代码块/工具卡片/编辑器) */
    '--code-bg': dark ? 'rgba(5,8,16,.82)' : 'rgba(255,255,255,.74)',
    '--code-bg-soft': dark ? 'rgba(10,14,24,.55)' : 'rgba(255,255,255,.52)',
    '--code-bg-solid': dark ? 'rgba(5,8,16,.88)' : 'rgba(255,255,255,.92)',
    '--code-bor': dark ? ov(0.07) : ov(0.10),

    /* 终端:两方向均保持近黑,保证终端内容对比度 */
    '--xterm-bg': 'rgba(6,9,16,.92)',

    /* 阴影色(去黑化:非纯黑、低透明度;柔和度由玻璃阴影的分层承担。
    注意:此令牌常以「0 Xpx Ypx var(--shadow-N)」前缀形式使用,必须保持为单色值) */
    '--shadow-1': dark ? 'rgba(4,9,20,.22)' : 'rgba(15,23,42,.05)',
    '--shadow-2': dark ? 'rgba(4,9,20,.30)' : 'rgba(15,23,42,.07)',

    /* accent 系表面 */
    '--accent-fill': withAlpha(t.accent, dark ? 0.20 : 0.12),
    '--accent-fill-soft': withAlpha(t.accent, dark ? 0.10 : 0.08),
    '--accent-fill-hover': withAlpha(t.accent, dark ? 0.06 : 0.05),
    '--accent-border': withAlpha(t.accent, dark ? 0.45 : 0.50),
    '--focus-ring': withAlpha(t.accent, dark ? 0.28 : 0.30),
    '--sel-glow': withAlpha(t.accent, dark ? 0.32 : 0.22),

    /* 语义状态表面 */
    '--ok-bg': withAlpha(t.green, 0.10),
    '--ok-border': withAlpha(t.green, dark ? 0.35 : 0.38),
    '--err-bg': withAlpha(t.red, dark ? 0.11 : 0.10),
    '--err-border': withAlpha(t.red, dark ? 0.40 : 0.45),
    '--warn-bg': withAlpha(t.amber, dark ? 0.11 : 0.12),
    '--warn-border': withAlpha(t.amber, dark ? 0.40 : 0.45),
    '--err-text': dark ? '#fda4af' : t.red,

    /* 主按钮(由 accent 派生,保证每套主题按钮与强调色一致) */
    '--btn-a': mix(t.accent, '#ffffff', dark ? 0.28 : 0.30),
    '--btn-b': mix(t.accent, '#000000', 0.12),
    '--btn-hover-a': mix(t.accent, '#ffffff', dark ? 0.42 : 0.45),
    '--btn-hover-b': mix(t.accent, '#ffffff', dark ? 0.08 : 0.08),
    '--btn-text': '#ffffff',
    '--btn-sheen': dark ? 'rgba(255,255,255,.42)' : 'rgba(255,255,255,.38)',
    '--btn-bor': withAlpha(t.accent, 0.55),

    /* 危险按钮(由 red 派生) */
    '--btn-danger-a': mix(t.red, '#ffffff', 0.30),
    '--btn-danger-b': mix(t.red, '#000000', 0.18),
    '--btn-danger-text': dark ? '#ffe4e8' : '#ffffff',
    '--btn-danger-bor': withAlpha(t.red, 0.5),
    '--btn-danger-glow': withAlpha(t.red, dark ? 0.35 : 0.28),

    /* 品牌渐变 */
    '--brand-a': dark ? '#eaf2ff' : '#d6e4f8',
    '--brand-b': dark ? '#b48cff' : '#a78bfa',

    /* 上下文用量条(系统/警告用独立紫/橙,保持识别度) */
    '--violet': '#8b5cf6',
    '--violet-glow': 'rgba(139,92,246,.5)',
    '--amber-bright': '#f59e0b',

    /* 开关 */
    '--switch-track': dark ? 'rgba(255,255,255,.75)' : ov(0.18),
    '--switch-knob': '#ffffff',

    /* 滚动条 */
    '--scroll-thumb': dark ? 'rgba(255,255,255,.16)' : 'rgba(15,23,42,.25)',
    '--scroll-thumb-x': 'rgba(255,255,255,.2)',   /* xterm 视口内固定亮色 */

    /* 进度条轨道 / 遮罩 / 扫光 */
    '--progress-track': dark ? 'rgba(255,255,255,.08)' : 'rgba(15,23,42,.08)',
    '--mask-bg': dark ? 'rgba(3,5,12,.5)' : 'rgba(241,245,249,.62)',
    '--glare': dark ? 'rgba(255,255,255,.12)' : 'rgba(255,255,255,.60)'
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
  // 原生控件/滚动条跟随主题深浅(dark 主题用深色原生 UI,浅色主题用浅色)
  root.style.colorScheme = isDarkColor(t.bgDeep) ? 'dark' : 'light';
}

/** 启动时应用持久化的激活主题(渲染前调用,避免首帧闪回默认色) */
export function applyActiveTheme(): string {
  const st = loadThemeState();
  const t = getTheme(st.active, st);
  if (t) applyTheme(t);
  return st.active;
}

/* ---------------- 自定义主题构建(从少量输入派生完整 token) ---------------- */

export interface CustomThemeDraft {
  name: string;
  bgDeep: string;
  accent: string;
  aurora1: string;
  aurora2: string;
  aurora3: string;
}

function hexToRgb(hex: string): [number, number, number] {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function withAlpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** 两色按 t∈[0,1] 线性混合(hexA + t*(hexB-hexA)) */
function mix(hexA: string, hexB: string, t: number): string {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** 根据背景明暗判断是否深色主题(决定文字与玻璃方向) */
function isDarkColor(hex: string): boolean {
  const [r, g, b] = hexToRgb(hex);
  return (r * 299 + g * 587 + b * 114) / 1000 < 140;
}

export function newThemeId(): string {
  return `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 从用户输入的颜色派生一套完整主题 token */
export function buildCustomTheme(id: string, d: CustomThemeDraft): ThemeDef {
  const dark = isDarkColor(d.bgDeep);
  const glass = dark ? WHITE_GLASS : LIGHT_GLASS;
  return {
    id,
    name: d.name.trim() || '未命名主题',
    preset: false,
    bgDeep: d.bgDeep,
    aurora1: d.aurora1,
    aurora2: d.aurora2,
    aurora3: d.aurora3,
    ...glass,
    // 深色背景用亮字,浅色背景用暗字
    text: dark ? '#e2e8f0' : '#1e293b',
    muted: dark ? '#8a93a6' : '#5b6b82',
    accent: d.accent,
    accent2: mix('#ffffff', d.accent, 0.22),
    accentGlow: withAlpha(d.accent, 0.45),
    accentSoft: withAlpha(d.accent, 0.16),
    green: '#4ade80',
    red: '#fb7185',
    amber: '#fbbf24'
  };
}

/** 从现有主题抽取可编辑草稿(用于「新建/编辑」表单预填) */
export function toDraft(t: ThemeDef): CustomThemeDraft {
  return {
    name: t.name,
    bgDeep: t.bgDeep,
    accent: t.accent,
    aurora1: t.aurora1,
    aurora2: t.aurora2,
    aurora3: t.aurora3
  };
}
