// ============================================================
// 主题系统集中管理
// 所有主题样式(色板)统一在此定义;应用时把 token 写入
// document.documentElement 的内联 CSS 变量,覆盖 styles.scss 的 :root 默认值。
// 三套内置预设(不可删除) + 用户自定义主题(localStorage 持久化)。
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

/** 深色玻璃材质默认值(浅色背景时会被深色玻璃替换) */
const WHITE_GLASS = {
  glassBg: 'rgba(255,255,255,.055)',
  glassBgStrong: 'rgba(255,255,255,.09)',
  glassBgHover: 'rgba(255,255,255,.12)',
  glassBgInset: 'rgba(6,9,18,.42)',
  glassBorder: 'rgba(255,255,255,.14)',
  glassBorderHover: 'rgba(255,255,255,.28)',
  glassHi: 'rgba(255,255,255,.30)',
  glassLo: 'rgba(255,255,255,.04)',
  glassShadow: '0 8px 32px rgba(0,0,0,.35)',
  glassShadowLg: '0 24px 64px rgba(0,0,0,.5)'
};

const DARK_GLASS = {
  glassBg: 'rgba(10,14,24,.40)',
  glassBgStrong: 'rgba(10,14,24,.55)',
  glassBgHover: 'rgba(10,14,24,.62)',
  glassBgInset: 'rgba(255,255,255,.10)',
  glassBorder: 'rgba(10,14,24,.25)',
  glassBorderHover: 'rgba(10,14,24,.45)',
  glassHi: 'rgba(255,255,255,.60)',
  glassLo: 'rgba(255,255,255,.16)',
  glassShadow: '0 8px 32px rgba(15,23,42,.25)',
  glassShadowLg: '0 24px 64px rgba(15,23,42,.35)'
};

/* ---------------- 预设主题(三套,不可删除) ---------------- */

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

export const PRESET_THEMES: ThemeDef[] = [NEBULA, VIOLET, EMERALD];

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

/** 把主题 token 写入 document.documentElement 内联 CSS 变量(覆盖 :root 默认值) */
export function applyTheme(t: ThemeTokens): void {
  const root = document.documentElement;
  for (const [field, varName] of Object.entries(VAR_MAP)) {
    root.style.setProperty(varName, (t as any)[field]);
  }
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
  const glass = dark ? WHITE_GLASS : DARK_GLASS;
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
