// 技能管理面板(位于设置面板中)
// 照搬 deepseek-harness 的技能形态:技能 = Markdown 指令文件,六级来源,高优先级覆盖低优先级:
//   内置(builtin)            随工具分发的本地技能库(deepseek-harness / Claude Code 收集)
//   用户级本机(local-user)         <本机主目录>/.agents/skills       跨项目共享,无需 SSH
//   用户级远程(user)              <远程家目录>/.agents/skills      跨工作区,需 SSH
//   项目级本机(local-project)     <工具运行目录>/.agents/skills    随本机项目,无需 SSH
//   工作区级本机(local-workspace) <本地工作区>/.agents/skills      随本地工作区,无需 SSH
//   项目级远程(project)          <工作区>/.agents/skills          随工作区,需 SSH
// 文件头 frontmatter(name/description)是目录,正文是给 AI 的完整指令;
// 模型通过 skill 工具按需加载。内置技能不可编辑,可"复制到"任意级别成为可编辑副本。
import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useFeedback } from '../context/feedback';
import GlassSelect from './GlassSelect';

interface SkillEntry {
  name: string;
  description: string;
  file: string;
  source: 'builtin' | 'project' | 'user' | 'local-project' | 'local-user' | 'local-workspace';
}

// 覆盖优先级从低到高(前端仅做展示分组,实际覆盖在后端合并时完成)
const SRC_LABEL: Record<SkillEntry['source'], string> = {
  builtin: '内置',
  project: '项目级·远程',
  user: '用户级·远程',
  'local-project': '项目级·本机',
  'local-user': '用户级·本机',
  'local-workspace': '工作区·本机'
};

// target 是否本机(无需 SSH)
const isLocal = (t: string) => t.startsWith('local-');

export default function SkillsPanel({ connected }: { connected: boolean }) {
  const { confirm } = useFeedback();
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('all');
  // 弹窗状态:null=关闭;{skill}=编辑该技能;{}=新建
  const [modal, setModal] = useState<{ skill?: SkillEntry } | null>(null);

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    setErr('');
    try {
      const r = await api.request('skills_list', {}, 30000);
      setSkills(r.skills || []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const onDelete = async (s: SkillEntry) => {
    if (s.source === 'builtin') return;
    const message = s.file.startsWith('local://')
      ? `删除本机技能 ${s.name}?\n将删除本机文件 ${s.file},不可恢复`
      : `删除远程技能 ${s.name}?\n将删除远程文件 ${s.file},不可恢复`;
    const ok = await confirm({ title: '删除技能', message, confirmLabel: '删除', danger: true });
    if (!ok) return;
    setErr('');
    try {
      const r = await api.request('skill_delete', { name: s.name }, 30000);
      setSkills(r.skills || []);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  // 内置技能 → 复制到目标级别(本机/远程的项目级/用户级/工作区级),之后可编辑
  const onCopyBuiltin = async (s: SkillEntry, target: 'project' | 'user' | 'local-project' | 'local-user' | 'local-workspace') => {
    if (s.source !== 'builtin') return;
    if (!isLocal(target) && !connected) { setErr('复制到远程需要先连接 SSH,可改选本机级别'); return; }
    const where = SRC_LABEL[target];
    const loc = isLocal(target)
      ? (target === 'local-project' ? '<本机工具目录>/.agents/skills/' : target === 'local-workspace' ? '<本地工作区>/.agents/skills/' : '<本机用户主目录>/.agents/skills/')
      : (target === 'project' ? '<远程工作区>/.agents/skills/' : '<远程家目录>/.agents/skills/');
    const ok = await confirm({
      title: '复制内置技能',
      message: `把内置技能 ${s.name} 复制到${where}(${loc})?`,
      confirmLabel: '复制'
    });
    if (!ok) return;
    setErr('');
    try {
      const r = await api.request('skill_copy_builtin', { name: s.name, target }, 30000);
      setSkills(r.skills || []);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const onSaved = (list: SkillEntry[]) => {
    setSkills(list);
    setModal(null);
  };

  const counts = {
    all: skills.length,
    builtin: skills.filter((s) => s.source === 'builtin').length,
    local: skills.filter((s) => s.source === 'local-project' || s.source === 'local-user' || s.source === 'local-workspace').length,
    remote: skills.filter((s) => s.source === 'project' || s.source === 'user').length
  };
  const shown = filter === 'all' ? skills
    : filter === 'builtin' ? skills.filter((s) => s.source === 'builtin')
    : filter === 'local' ? skills.filter((s) => s.source === 'local-project' || s.source === 'local-user' || s.source === 'local-workspace')
    : skills.filter((s) => s.source === 'project' || s.source === 'user');

  return (
    <div>
      {/* 标题行:只放标题与刷新,避免窄窗口下挤压换行 */}
      <div className="panel-title row skills-head">
        <span>技能</span>
        <span className="muted sm">({counts.all})</span>
        <span className="grow" />
        <button className="sm" onClick={() => load()} disabled={loading}>{loading ? '扫描中…' : '⟳ 重新扫描'}</button>
      </div>
      {/* 筛选工具条:改用统一的 GlassSelect 组件;数量放入菜单 hint,选项文字不再挤占标题行 */}
      <div className="skill-toolbar row">
        <GlassSelect className="skill-filter" value={filter} onChange={(v) => setFilter(v)} title="按来源筛选"
          options={[
            { value: 'all', label: '全部技能', hint: `${counts.all} 个` },
            { value: 'local', label: '本机 · 项目/用户级', hint: `${counts.local} 个` },
            { value: 'remote', label: '远程 · 项目/用户级', hint: `${counts.remote} 个` },
            { value: 'builtin', label: '内置库', hint: `${counts.builtin} 个` }
          ]} />
        <span className="grow" />
        <span className="muted sm skill-count">当前显示 {shown.length} 个</span>
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>
        技能是可复用的任务指令,AI 会在任务匹配时通过 skill 工具自动加载。来源:内置(deepseek-harness 与 Claude Code)、
        项目级(远程 <code>&lt;工作区&gt;/.agents/skills</code> / 本机 <code>&lt;工具目录&gt;/.agents/skills</code>)、
        工作区级(本机 <code>&lt;本地工作区&gt;/.agents/skills</code>)、
        用户级(远程 <code>~/.agents/skills</code> / 本机 <code>&lt;主目录&gt;/.agents/skills</code>)。
        同名时 项目级(远程) &gt; 工作区级(本机) &gt; 项目级(本机) &gt; 用户级(远程) &gt; 用户级(本机) &gt; 内置。
        本机技能无需 SSH 即可创建/编辑,内置技能可复制到任意级别后编辑。
      </div>
      {err && <div className="error" onClick={() => setErr('')} title="点击关闭">✕ {err}</div>}

      <div className="provider-list">
        {loading && skills.length === 0 && <div className="provider-empty">正在扫描技能目录…</div>}
        {!loading && shown.length === 0 && <div className="provider-empty">该分类下暂无技能</div>}
        {shown.map((s) => (
          <div key={`${s.source}:${s.name}`} className="skill-card" title={s.file}>
            <div className="pc-head">
              <span className="pc-name">{s.name}</span>
              <span className={`badge ${s.source === 'builtin' ? '' : s.source === 'local-project' || s.source === 'project' ? 'ok' : 'warn'}`}>
                {SRC_LABEL[s.source]}
              </span>
            </div>
            <div className="skill-desc">{s.description || '(无描述)'}</div>
            <div className="pc-meta"><span className="skill-file">{s.file}</span></div>
            <div className="pc-actions">
              {s.source === 'builtin' ? (
                <>
                  <button className="sm" disabled={!connected} title={connected ? '复制到远程项目级后可在远程编辑(其他工作区不可见)' : '先连接 SSH'} onClick={() => onCopyBuiltin(s, 'project')}>复制→远程项目级</button>
                  <button className="sm" disabled={!connected} title={connected ? '复制到远程用户级后可在远程编辑(跨工作区共享)' : '先连接 SSH'} onClick={() => onCopyBuiltin(s, 'user')}>复制→远程用户级</button>
                  <button className="sm" title="复制到本机工具目录 .agents/skills,无需 SSH" onClick={() => onCopyBuiltin(s, 'local-project')}>复制→本机项目级</button>
                  <button className="sm" title="复制到本机用户主目录 .agents/skills,无需 SSH" onClick={() => onCopyBuiltin(s, 'local-user')}>复制→本机用户级</button>
                </>
              ) : (
                <>
                  <button className="sm" onClick={() => setModal({ skill: s })}>编辑</button>
                  <button className="sm" disabled={!connected && !isLocal(s.source)} title={isLocal(s.source) ? '删除本机技能文件' : '先连接 SSH'} onClick={() => onDelete(s)}>删除</button>
                </>
              )}
            </div>
          </div>
        ))}
        <button className="provider-add" onClick={() => setModal({})}>
          <span className="pa-icon">＋</span> 新建技能
        </button>
      </div>

      {modal && (
        <SkillModal
          edit={modal.skill || null}
          connected={connected}
          onClose={() => setModal(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

// ---- 新建 / 编辑技能弹窗 ----
interface SkillModalProps {
  edit: SkillEntry | null;
  connected: boolean;
  onClose: () => void;
  onSaved: (skills: SkillEntry[]) => void;
}

function SkillModal({ edit, connected, onClose, onSaved }: SkillModalProps) {
  const isEdit = !!edit;
  const [name, setName] = useState(isEdit ? edit.name : '');
  const [description, setDescription] = useState(isEdit ? edit.description : '');
  const [content, setContent] = useState('');
  const [target, setTarget] = useState<SkillEntry['source']>('local-project');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(isEdit); // 编辑模式先拉取正文回填

  useEffect(() => {
    if (!isEdit) return;
    let alive = true;
    api.request('skill_get', { name: edit.name }, 30000)
      .then((r) => {
        if (!alive) return;
        setDescription(r.description || '');
        setContent(r.content || '');
      })
      .catch((e) => alive && setError(`读取技能失败: ${e.message}`))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  const submit = async () => {
    const n = name.trim().toLowerCase();
    const d = description.trim();
    const c = content.trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n)) {
      return setError('技能名需为 kebab-case:小写字母/数字/连字符,如 code-review');
    }
    if (!d) return setError('请填写描述(模型据此判断何时使用该技能)');
    if (!c) return setError('请填写指令正文');
    if (!isLocal(target) && !connected) return setError('SSH 未连接,无法保存到远程;请改选本机级别');
    setSaving(true);
    setError('');
    try {
      // 编辑时不传 target:后端按原级别/原文件覆写;仅新建需要指定保存位置
      const payload: Record<string, string> = { name: n, description: d, content: c };
      if (!isEdit) payload.target = target;
      const r = await api.request('skill_save', payload, 30000);
      onSaved(r.skills || []);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal skill-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{isEdit ? `编辑技能 · ${edit.name}` : '新建技能'}</span>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {loading ? (
            <div className="provider-empty">正在读取技能内容…</div>
          ) : (
            <>
              <div className="field">
                <label>技能名(kebab-case,AI 通过 skill 工具按名加载)</label>
                <input value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="如 code-review / deploy-checklist" disabled={isEdit} autoFocus={!isEdit} />
              </div>
              <div className="field">
                <label>描述(一句话说明何时使用,会出现在 AI 的技能目录里)</label>
                <input value={description} onChange={(e) => setDescription(e.target.value)}
                  placeholder="如 审查代码变更,关注安全与性能问题" />
              </div>
              {!isEdit && (
                <div className="field">
                  <label>保存位置</label>
                  <GlassSelect full value={target} onChange={(v) => setTarget(v as SkillEntry['source'])} options={[
                    { value: 'local-project', label: '项目级 · 本机 <工具目录>/.agents/skills(随本机项目,无需 SSH)' },
                    { value: 'local-user', label: '用户级 · 本机 <主目录>/.agents/skills(跨项目共享,无需 SSH)' },
                    { value: 'local-workspace', label: '工作区 · 本机 <本地工作区>/.agents/skills(需先选择本地工作区)' },
                    { value: 'project', label: '项目级 · 远程 <工作区>/.agents/skills(需连接 SSH)' },
                    { value: 'user', label: '用户级 · 远程 ~/.agents/skills(需连接 SSH)' }
                  ]} />
                </div>
              )}
              <div className="field">
                <label>指令正文(AI 加载技能后收到的完整指令,支持 Markdown)</label>
                <textarea className="codeedit" rows={12} value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={'# 操作步骤\n1. …\n\n# 注意事项\n- …'} />
              </div>
              {isEdit && <div className="hint">将覆写文件 <code>{edit.file}</code>{!isLocal(edit.source) && !connected ? ' (需要先连接 SSH)' : ''}</div>}
            </>
          )}
          {error && <div className="error">✕ {error}</div>}
        </div>
        <div className="modal-foot row gap">
          <button className="grow" onClick={onClose} disabled={saving}>取消</button>
          <button className="primary grow" onClick={submit} disabled={saving || loading || (!isLocal(target) && !connected)}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}