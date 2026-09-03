// 主题设置面板(位于设置面板中)
// 集中管理主题:切换预设(深色三套 + 亮色一套)/ 新建 / 编辑 / 删除自定义主题。
// 主题的 token 定义与持久化逻辑见 ../themes.ts,本组件只负责 UI 与「应用+保存」。
import React, { useState } from 'react';
import {
  applyTheme, getAllThemes, getTheme, loadThemeState, saveThemeState,
  buildCustomTheme, newThemeId, toDraft,
  type PersistedThemeState, type ThemeDef, type CustomThemeDraft
} from '../theme/themes';

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
    const next = { ...state, active: id };
    commit(next, true);
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
    const next: PersistedThemeState = { active: id!, custom: list };
    commit(next, true);
  };

  const deleteCustom = (id: string) => {
    const list = (state.custom || []).filter((t) => t.id !== id);
    // 删除的是当前激活主题时回落到第一套预设
    const active = state.active === id ? getAllThemes({ active: PRESET_FIRST_ID, custom: list })[0].id : state.active;
    commit({ active, custom: list }, active !== state.active || state.active === id);
  };

  return (
    <div>
      <div className="panel-title row">
        <span>主题</span>
        <span className="grow" />
        <span className="muted sm">当前: {active.name}</span>
      </div>

      {/* 当前主题色板预览 */}
      <div className="theme-preview" style={{ background: `linear-gradient(135deg, ${active.bgDeep}, ${active.aurora2})` }}>
        <span className="tp-swatch" style={{ background: active.accent, boxShadow: `0 0 12px ${active.accentGlow}` }} />
        <span className="tp-meta">
          <span className="tp-name">{active.name}</span>
          <span className="tp-desc" style={{ color: active.muted }}>
            背景 {active.bgDeep} · 强调 {active.accent}
          </span>
        </span>
        <span className="badge ok" style={{ borderColor: active.accent, color: active.accent }}>使用中</span>
      </div>

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
      <div className="hint">自定义主题保存在本机浏览器,可随时新建 / 编辑 / 删除,并一键切换生效。</div>

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

/** 预设兜底 id(删除激活的自定义主题时回落到它) */
const PRESET_FIRST_ID = 'nebula';

// ---- 主题卡片:名称 + 色板 + 操作 ----
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
        <span className="sw" style={{ background: t.bgDeep, borderColor: t.glassBorder }} />
        <span className="sw" style={{ background: t.aurora1 }} />
        <span className="sw" style={{ background: t.accent }} />
        <span className="sw" style={{ background: t.text }} />
        <span className="sw" style={{ background: t.green }} />
        <span className="sw" style={{ background: t.red }} />
      </div>
      <div className="tc-actions" onClick={(e) => e.stopPropagation()}>
        {onEdit && <button className="sm" onClick={onEdit}>编辑</button>}
        {onDelete && <button className="sm danger" onClick={onDelete}>删除</button>}
      </div>
    </div>
  );
}

// ---- 新建 / 编辑主题弹窗 ----
interface ThemeEditorProps {
  edit?: ThemeDef;
  onClose: () => void;
  onSave: (draft: CustomThemeDraft) => void;
}

function ThemeEditor({ edit, onClose, onSave }: ThemeEditorProps) {
  const init = edit ? toDraft(edit) : {
    name: '',
    bgDeep: '#0b1020',
    accent: '#6aa8ff',
    aurora1: 'rgba(58,118,255,.17)',
    aurora2: 'rgba(130,84,255,.13)',
    aurora3: 'rgba(38,196,255,.10)'
  };
  const [name, setName] = useState(init.name);
  const [bgDeep, setBgDeep] = useState(init.bgDeep);
  const [accent, setAccent] = useState(init.accent);
  const [aurora1, setAurora1] = useState(init.aurora1);
  const [aurora2, setAurora2] = useState(init.aurora2);
  const [aurora3, setAurora3] = useState(init.aurora3);
  const [error, setError] = useState('');

  // 颜色输入框:预设的 rgba 值转成 hex 供 <input type=color> 使用
  const toHex = (v: string) => {
    const m = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) {
      const n = (n: string) => Number(n).toString(16).padStart(2, '0');
      return `#${n(m[1])}${n(m[2])}${n(m[3])}`;
    }
    return /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) ? v.trim() : '#000000';
  };

  // 实时预览:用当前输入派生主题,套在预览条上(不落盘)
  const preview = buildCustomTheme('preview', { name, bgDeep, accent, aurora1, aurora2, aurora3 });

  const submit = () => {
    if (!name.trim()) return setError('请填写主题名称');
    setError('');
    onSave({ name, bgDeep, accent, aurora1, aurora2, aurora3 });
  };

  const ColorField = ({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) => (
    <label className="theme-color-field">
      <span>{label}</span>
      <span className="tc-input">
        <input type="color" value={toHex(value)} onChange={(e) => onChange(e.target.value)} />
        <code>{value}</code>
      </span>
    </label>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal theme-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{edit ? `编辑主题 · ${edit.name}` : '新建自定义主题'}</span>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>主题名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 我的深夜主题" autoFocus />
          </div>
          <div className="theme-color-grid">
            <ColorField label="背景色" value={bgDeep} onChange={setBgDeep} />
            <ColorField label="强调色" value={accent} onChange={setAccent} />
            <ColorField label="光斑 1" value={aurora1} onChange={setAurora1} />
            <ColorField label="光斑 2" value={aurora2} onChange={setAurora2} />
            <ColorField label="光斑 3" value={aurora3} onChange={setAurora3} />
          </div>
          {/* 实时预览条 */}
          <div className="theme-preview live" style={{ background: `linear-gradient(135deg, ${preview.bgDeep}, ${preview.aurora2})` }}>
            <span className="tp-swatch" style={{ background: preview.accent, boxShadow: `0 0 12px ${preview.accentGlow}` }} />
            <span className="tp-meta">
              <span className="tp-name" style={{ color: preview.text }}>{preview.name || '未命名主题'}</span>
              <span className="tp-desc" style={{ color: preview.muted }}>预览 · 文字 {preview.text} · 玻璃基于背景明暗自动适配</span>
            </span>
          </div>
          {error && <div className="error">✕ {error}</div>}
        </div>
        <div className="modal-foot row gap">
          <button className="grow" onClick={onClose}>取消</button>
          <button className="primary grow" onClick={submit}>{edit ? '保存' : '保存并使用'}</button>
        </div>
      </div>
    </div>
  );
}
