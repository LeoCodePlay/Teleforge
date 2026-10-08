// 主题设置面板(位于设置面板中)
// 集中管理主题:切换预设(深色三套 + 亮色一套)/ 新建 / 编辑 / 删除自定义主题。
// 自定义主题只需要 **6 个颜色** —— 页面里出现的每一个颜色都由它们派生
// (派生规则见 ../themes.ts 的 deriveThemeVars),因此这里只提供 6 个取色器。
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  applyTheme, getAllThemes, getTheme, loadThemeState, saveThemeState,
  buildCustomTheme, newThemeId, toDraft,
  type PersistedThemeState, type ThemeDef, type CustomThemeDraft
} from '../../theme/themes';
import './ThemePanel.scss';

/** 预设兜底 id(删除激活的自定义主题时回落到它) */
const PRESET_FIRST_ID = 'ink';

/** 6 色调色板的字段定义:顺序即「从底到顶」的直觉顺序 */
const COLOR_FIELDS: { key: keyof CustomThemeDraft; label: string; hint: string }[] = [
  { key: 'bg', label: '背景色', hint: '页面底色,决定深色/浅色方向' },
  { key: 'surface', label: '表面色', hint: '顶栏 / 侧栏 / 面板 / 弹层' },
  { key: 'text', label: '文字色', hint: '正文,并派生描边与悬浮态' },
  { key: 'accent', label: '强调色', hint: '主按钮 / 选中 / 链接 / 焦点' },
  { key: 'success', label: '成功色', hint: '连接正常 / 通过 / 新增' },
  { key: 'danger', label: '危险色', hint: '错误 / 删除;警告色由它派生' }
];

export default function ThemePanel() {
  const [state, setState] = useState<PersistedThemeState>(() => loadThemeState());
  // 弹窗状态:null=关闭;{edit}=编辑该主题;{}=新建
  const [editor, setEditor] = useState<{ edit?: ThemeDef } | null>(null);

  const all = getAllThemes(state);
  const active = getTheme(state.active, state) || all[0];
  const customs = state.custom || [];

  const commit = (next: PersistedThemeState, apply: boolean) => {
    setState(next);
    saveThemeState(next);
    if (apply) {
      const t = getTheme(next.active, next);
      if (t) applyTheme(t);
    }
  };

  const switchTheme = (id: string) => {
    const t = getTheme(id, state);
    if (!t) return;
    commit({ ...state, active: id }, true);
  };

  const saveCustom = (draft: CustomThemeDraft, editId?: string) => {
    let id = editId;
    let list: ThemeDef[];
    if (editId) {
      // 编辑:原地替换,保持 id 与激活状态
      list = (state.custom || []).map((t) => (t.id === editId ? buildCustomTheme(editId, draft) : t));
    } else {
      id = newThemeId();
      list = [...(state.custom || []), buildCustomTheme(id, draft)];
    }
    commit({ active: id!, custom: list }, true);
  };

  const deleteCustom = (id: string) => {
    const list = (state.custom || []).filter((t) => t.id !== id);
    // 删除的是当前激活主题时回落到第一套预设
    const active = state.active === id ? PRESET_FIRST_ID : state.active;
    commit({ active, custom: list }, true);
  };

  return (
    <div>
      <div className="panel-title row">
        <span>主题</span>
        <span className="grow" />
        <span className="muted sm">当前:{active.name}</span>
      </div>

      {/* 当前主题预览 */}
      <ThemePreview t={active} badge="使用中" />

      {/* 预设主题 */}
      <div className="panel-title row">
        <span>预设主题</span>
        <span className="grow" />
        <span className="muted sm">点击卡片切换</span>
      </div>
      <div className="theme-grid">
        {all.filter((t) => t.preset).map((t) => (
          <ThemeCard key={t.id} t={t} active={t.id === state.active} onClick={() => switchTheme(t.id)} />
        ))}
      </div>

      {/* 自定义主题 */}
      <div className="panel-title row">
        <span>我的主题</span>
        <span className="muted sm">({customs.length})</span>
        <span className="grow" />
        <button className="sm" onClick={() => setEditor({})}>＋ 新建主题</button>
      </div>
      {customs.length === 0 ? (
        <div className="provider-empty">还没有自定义主题,点击「新建主题」创建</div>
      ) : (
        <div className="theme-grid">
          {customs.map((t) => (
            <ThemeCard
              key={t.id} t={t} active={t.id === state.active}
              onEdit={() => setEditor({ edit: t })}
              onDelete={() => deleteCustom(t.id)}
              onClick={() => switchTheme(t.id)}
            />
          ))}
        </div>
      )}
      <div className="hint">
        自定义主题只要选 <b>6 个颜色</b>(背景 / 表面 / 文字 / 强调 / 成功 / 危险),
        其余全部颜色(描边、悬浮态、按钮、阴影、状态底色…)由这 6 色自动派生。
        主题保存在本机浏览器,可随时新建 / 编辑 / 删除。
      </div>

      {/* 新建 / 编辑主题弹窗 */}
      {editor && (
        <ThemeEditor
          edit={editor.edit}
          onClose={() => setEditor(null)}
          onSave={(draft) => { saveCustom(draft, editor.edit?.id); setEditor(null); }}
        />
      )}
    </div>
  );
}

// ---- 主题预览条:用这套主题的 6 色画一个迷你界面 ----
function ThemePreview({ t, badge }: { t: CustomThemeDraft; badge?: string }) {
  const dark = isDark(t.bg);
  const onAccent = isDark(t.accent) ? (dark ? t.text : t.bg) : dark ? t.bg : t.text;
  return (
    <div className="theme-preview" style={{ background: t.bg, borderColor: mix(t.surface, t.text, dark ? 0.12 : 0.16) }}>
      <div className="tp-window" style={{ background: t.surface, borderColor: mix(t.surface, t.text, dark ? 0.1 : 0.14) }}>
        <span className="tp-bar" style={{ background: mix(t.surface, t.text, dark ? 0.05 : 0.34) }}>
          <i style={{ background: t.accent }} />
          <i style={{ background: t.success }} />
          <i style={{ background: t.danger }} />
        </span>
        <span className="tp-line" style={{ background: mix(t.surface, t.text, 0.14), width: '62%' }} />
        <span className="tp-line" style={{ background: mix(t.surface, t.text, 0.34), width: '84%' }} />
        <span className="tp-btns">
          <b style={{ background: t.accent, color: onAccent }}>主按钮</b>
          <b style={{ background: mix(t.surface, t.text, dark ? 0.08 : 0.3), color: t.text }}>次按钮</b>
        </span>
      </div>
      <span className="tp-meta">
        <span className="tp-name" style={{ color: t.text }}>{t.name || '未命名主题'}</span>
        {/* 16 进制色值读数是给人看的次要信息,不能压在 3.4:1 —— 用与全站 --muted
            同一档的插值比例,保证在任意主题的 bg 上都过 AA */}
        <span className="tp-desc" style={{ color: mix(t.surface, t.text, 0.55) }}>
          {t.bg} · {t.accent}
        </span>
      </span>
      {/* 状态徽标只靠文字色表达语义:inline 的 borderColor 会重新引入彩色描边 */}
      {badge && <span className="badge ok" style={{ color: t.success }}>{badge}</span>}
    </div>
  );
}

// ---- 主题卡片:名称 + 6 色色板 + 操作 ----
interface ThemeCardProps {
  t: ThemeDef;
  active: boolean;
  onClick: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

function ThemeCard({ t, active, onClick, onEdit, onDelete }: ThemeCardProps) {
  return (
    <div className={'theme-card' + (active ? ' active' : '')} onClick={onClick}>
      <div className="tc-head">
        <span className="tc-name">{t.name}</span>
        {t.preset ? <span className="muted sm">预设</span> : active ? <span className="badge ok">使用中</span> : null}
      </div>
      <div className="tc-swatches">
        <span className="sw" style={{ background: t.bg }} data-tip="背景色" />
        <span className="sw" style={{ background: t.surface }} data-tip="表面色" />
        <span className="sw" style={{ background: t.text }} data-tip="文字色" />
        <span className="sw" style={{ background: t.accent }} data-tip="强调色" />
        <span className="sw" style={{ background: t.success }} data-tip="成功色" />
        <span className="sw" style={{ background: t.danger }} data-tip="危险色" />
      </div>
      <div className="tc-actions" onClick={(e) => e.stopPropagation()}>
        {onEdit && <button className="sm" onClick={onEdit}>编辑</button>}
        {onDelete && <button className="sm danger" onClick={onDelete}>删除</button>}
      </div>
    </div>
  );
}

// ---- 新建 / 编辑主题弹窗:只要 6 个颜色 + 名字 ----
interface ThemeEditorProps {
  edit?: ThemeDef;
  onClose: () => void;
  onSave: (draft: CustomThemeDraft) => void;
}

function ThemeEditor({ edit, onClose, onSave }: ThemeEditorProps) {
  const init: CustomThemeDraft = edit ? toDraft(edit) : {
    name: '',
    bg: '#0d0f13',
    surface: '#16191f',
    text: '#e7eaf0',
    accent: '#5b8cff',
    success: '#3fb26f',
    danger: '#ef5f5f'
  };
  const [draft, setDraft] = useState<CustomThemeDraft>(init);
  const [error, setError] = useState('');
  const set = <K extends keyof CustomThemeDraft>(key: K, value: CustomThemeDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  // 颜色值统一成 #rrggbb 供 <input type=color> 使用(兼容历史 rgba 数据)
  const toHex = (v: string) => {
    const rgb = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (rgb) {
      const n = (s: string) => Number(s).toString(16).padStart(2, '0');
      return `#${n(rgb[1])}${n(rgb[2])}${n(rgb[3])}`;
    }
    const h = v.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(h)) return h;
    if (/^#[0-9a-fA-F]{3}$/.test(h)) return `#${h.slice(1).split('').map((c) => c + c).join('')}`;
    return '#000000';
  };

  const submit = () => {
    if (!draft.name.trim()) return setError('请填写主题名称');
    setError('');
    onSave(draft);
  };

  // portal 到 body:.settings 面板的层叠上下文会困住 fixed 遮罩
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal theme-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{edit ? `编辑主题 · ${edit.name}` : '新建自定义主题'}</span>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>主题名称</label>
            <input
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="如 我的深夜主题"
              autoFocus
            />
          </div>

          <div className="theme-color-grid">
            {COLOR_FIELDS.map((f) => (
              <label className="theme-color-field" key={f.key}>
                <span className="tcf-label">{f.label}</span>
                <span className="tc-input">
                  <input
                    type="color"
                    value={toHex(String(draft[f.key]))}
                    onChange={(e) => set(f.key, e.target.value as CustomThemeDraft[typeof f.key])}
                  />
                  <code>{String(draft[f.key])}</code>
                </span>
                <span className="tcf-hint">{f.hint}</span>
              </label>
            ))}
          </div>

          {/* 实时预览:6 色改动立刻反映在小界面上 */}
          <ThemePreview t={draft} />
          {error && <div className="error">✕ {error}</div>}
        </div>
        <div className="modal-foot row gap">
          <button className="grow" onClick={onClose}>取消</button>
          <button className="primary grow" onClick={submit}>{edit ? '保存' : '保存并使用'}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/* ---- 与 themes.ts 同源的少量颜色数学(预览条内联样式需要) ---- */
function hexToRgb(hex: string): [number, number, number] {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = Math.min(1, Math.max(0, t));
  return `rgb(${Math.round(ca[0] + (cb[0] - ca[0]) * k)}, ${Math.round(ca[1] + (cb[1] - ca[1]) * k)}, ${Math.round(ca[2] + (cb[2] - ca[2]) * k)})`;
}
function isDark(hex: string): boolean {
  const [r, g, b] = hexToRgb(hex);
  return (r * 299 + g * 587 + b * 114) / 1000 < 140;
}
