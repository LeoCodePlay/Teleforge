// AI 模型 · 提供商配置面板(位于设置面板中)
// 布局:我的提供商列表(使用中置顶,增删改复制);预置提供商不单独展示,
// 仅作为「添加提供方」弹窗里的快速填充模板(预置了标准接口地址,免手输 Base URL)
// 状态与聊天输入框下方的切换器共享(见 llm-context.tsx);生图端点配置已独立为设置菜单的「生图配置」
import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLlm } from '../../context/llm-context';
import { PROVIDERS, getDefaultModelContext } from '../../data/llm-providers';
import type { LlmProvider, ProviderDraft, ModelContextConfig } from '../../types';
import GlassSelect from '../GlassSelect/GlassSelect';
import './AiConfigPanel.scss';

export default function AiConfigPanel() {
  const llm = useLlm();
  const { userProviders, providerId, switchProvider, addProvider, updateProvider,
    duplicateProvider, removeProvider } = llm;
  // 弹窗状态:null=关闭;{provider}=编辑该条目;{}=添加
  const [modal, setModal] = useState<{ provider?: LlmProvider } | null>(null);

  const handleSave = (data: ProviderDraft) => (modal?.provider ? updateProvider(modal.provider.id, data) : addProvider(data));

  // 当前使用中的提供商置顶显示
  const sortedProviders = useMemo(() => {
    return [...userProviders].sort((a, b) => {
      if (a.id === providerId) return -1;
      if (b.id === providerId) return 1;
      return 0;
    });
  }, [userProviders, providerId]);

  return (
    <div>
      {llm.err && <div className="error" onClick={() => llm.setErr('')}>✕ {llm.err}</div>}

      {/* ---- 我的提供商列表(使用中置顶,点击卡片切换为当前使用) ---- */}
      <div className="panel-title row">
        <span>我的提供商</span>
        <span className="muted sm">({userProviders.length})</span>
        <span className="grow" />
        <span className="muted sm">点击卡片切换为当前使用</span>
      </div>
      <div className="provider-list">
        {userProviders.length === 0 && (
          <div className="provider-empty">还没有自定义提供商,点击下方按钮添加</div>
        )}
        {sortedProviders.map((p) => (
          <ProviderCard key={p.id} p={p} active={p.id === providerId}
            onUse={() => switchProvider(p.id)}
            onEdit={() => setModal({ provider: p })}
            onCopy={() => duplicateProvider(p.id)}
            onDelete={() => removeProvider(p.id)} />
        ))}
        <button className="provider-add" onClick={() => setModal({})}>
          <span className="pa-icon">＋</span> 添加提供方
        </button>
      </div>

      {/* ---- 预置提供商不单独展示:预置仅是模板(标准接口地址),添加提供方时可快速填充 ---- */}
      {/* 添加 / 编辑提供商弹窗:portal 到 body——设置弹窗自身带 backdrop-filter,
          嵌套其中会成为 backdrop-root,导致本弹窗 blur 采不到真实页面(玻璃失效、文字透出)。
          与重命名弹窗同一处理(见 SessionPanel) */}
      {modal && createPortal(
        <ProviderModal
          editProvider={modal.provider || null}
          onClose={() => setModal(null)}
          onSave={handleSave}
        />,
        document.body
      )}
    </div>
  );
}

// ---- 提供商卡片:名称/地址/模型数 + 编辑/复制/删除 ----
interface ProviderCardProps {
  p: LlmProvider;
  active: boolean;
  onUse: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
}

function ProviderCard({ p, active, onUse, onEdit, onCopy, onDelete }: ProviderCardProps) {
  return (
    <div className={'provider-card' + (active ? ' active' : '')} onClick={onUse}>
      <div className="pc-head">
        <span className="pc-name">{p.name}</span>
        {active && <span className="badge ok">使用中</span>}
      </div>
      <div className="pc-url">{p.baseUrl}</div>
      <div className="pc-meta">
        <span>{p.models.length > 0 ? `${p.models.length} 个模型` : '无模型(手动输入)'}</span>
        <span>{p.apiKey ? 'Key 已配置' : '未配置 Key'}</span>
      </div>
      <div className="pc-actions" onClick={(e) => e.stopPropagation()}>
        {!active && <button className="sm" onClick={onUse}>使用</button>}
        <button className="sm" onClick={onEdit}>编辑</button>
        <button className="sm" onClick={onCopy}>复制</button>
        <button className="sm danger" onClick={onDelete}>删除</button>
      </div>
    </div>
  );
}

// ---- 添加 / 编辑提供商弹窗 ----
// 添加模式:可从预置提供商下拉快速填充;两类模式均可「获取模型列表」勾选模型
interface ProviderModalProps {
  editProvider: LlmProvider | null;
  onClose: () => void;
  onSave: (data: ProviderDraft) => Promise<boolean>;
}

function ProviderModal({ editProvider, onClose, onSave }: ProviderModalProps) {
  const isEdit = !!editProvider;
  const [name, setName] = useState(isEdit ? editProvider.name : '');
  const [baseUrl, setBaseUrl] = useState(isEdit ? editProvider.baseUrl : '');
  const [apiKey, setApiKey] = useState(isEdit ? (editProvider.apiKey || '') : '');
  const [models, setModels] = useState<string[]>(isEdit ? [...(editProvider.models || [])] : []);
  // 每个模型的上下文能力(输入窗口/输出上限),随条目随保存落盘
  const [modelConfig, setModelConfig] = useState<Record<string, ModelContextConfig>>(
    isEdit ? { ...(editProvider.modelConfig || {}) } : {}
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // 直接更新某模型的能力配置(上下文窗口/输出上限/多模态/生图);全部为空或关闭时清除该条配置。
  // 布尔开关用 '1'/'' 两个字符串值复用同一签名(与数字字段一致的调用形态)
  const updateModelCfg = (m: string, field: 'contextWindow' | 'maxTokens' | 'multimodal' | 'imageGen', raw: string) => {
    setModelConfig((cur) => {
      const next = { ...cur };
      const prev: ModelContextConfig = { ...(next[m] || {}) };
      if (field === 'multimodal' || field === 'imageGen') prev[field] = raw === '1' ? true : undefined;
      else {
        const n = Math.floor(Number(raw));
        prev[field] = n > 0 ? n : undefined;
      }
      const merged: ModelContextConfig = {};
      if (prev.contextWindow) merged.contextWindow = prev.contextWindow;
      if (prev.maxTokens) merged.maxTokens = prev.maxTokens;
      if (prev.multimodal) merged.multimodal = true;
      if (prev.imageGen) merged.imageGen = true;
      if (Object.keys(merged).length > 0) next[m] = merged;
      else delete next[m];
      return next;
    });
  };

  // 预置模板下拉(添加模式):选中后填充名称与 Base URL
  const [presetId, setPresetId] = useState('');
  const applyPreset = (id: string) => {
    setPresetId(id);
    const p = PROVIDERS.find((x) => x.id === id);
    if (p) { setName(p.name); setBaseUrl(p.baseUrl); }
  };

  // 获取模型列表(经服务端代理,避免浏览器 CORS)
  const [fetching, setFetching] = useState(false);
  const [remoteModels, setRemoteModels] = useState<string[] | null>(null); // null=尚未获取
  const [filter, setFilter] = useState('');
  const [manualModel, setManualModel] = useState('');

  const fetchModelList = async () => {
    const b = baseUrl.trim();
    if (!/^https?:\/\//i.test(b)) return setError('请先填写正确的 Base URL 再获取模型列表');
    setFetching(true);
    setError('');
    try {
      const r = await fetch('/api/providers/fetch-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: b, apiKey: apiKey.trim() })
      });
      let j: any;
      try { j = await r.json(); }
      catch {
        // 后端返回了非 JSON(通常是旧进程没有此接口,Express 返回 404 HTML 页面)
        throw new Error(r.status === 404
          ? '后端服务未提供该接口,请重启后端服务后再试'
          : `后端返回了异常响应(HTTP ${r.status}),请重启后端服务后再试`);
      }
      if (!r.ok) throw new Error(j.error || '获取失败');
      setRemoteModels(j.models || []);
      if (!(j.models || []).length) setError('该端点未返回任何模型,可手动输入模型名');
    } catch (e) {
      setError('获取模型列表失败:' + (e as Error).message);
    } finally {
      setFetching(false);
    }
  };

  const toggleModel = (m: string) => setModels((cur) => {
    if (cur.includes(m)) {
      // 移除模型时同步清除其上下文配置
      setModelConfig((mc) => { const n = { ...mc }; delete n[m]; return n; });
      return cur.filter((x) => x !== m);
    }
    return [...cur, m];
  });

  const addManualModel = () => {
    const m = manualModel.trim();
    if (!m) return;
    if (!models.includes(m)) setModels((cur) => [...cur, m]);
    setManualModel('');
  };

  const filteredRemote = useMemo(() => {
    if (!remoteModels) return [];
    const kw = filter.trim().toLowerCase();
    return kw ? remoteModels.filter((m) => m.toLowerCase().includes(kw)) : remoteModels;
  }, [remoteModels, filter]);

  const submit = async () => {
    const n = name.trim();
    const b = baseUrl.trim().replace(/\/+$/, '');
    if (!n) return setError('请填写提供商名称(如 公司内部网关)');
    if (!b) return setError('请填写 Base URL');
    if (!/^https?:\/\//i.test(b)) return setError('Base URL 需以 http:// 或 https:// 开头');
    setSaving(true);
    setError('');
    const ok = await onSave({ name: n, baseUrl: b, models, apiKey: apiKey.trim(), modelConfig });
    if (ok) onClose();
    else setSaving(false);
  };

  // portal 到 body:本弹窗内联在设置面板里,而 .settings 自带 backdrop-filter ——
  // 按 Chromium backdrop-root 机制,内层 .modal 的液态玻璃只能采样到设置面板内部、
  // 采不到真实页面,玻璃退化成半透明平色(能看清弹窗后面的文字);且该祖先会成为
  // fixed 遮罩的包含块,遮罩也被困在面板内。portal 出去与设置弹窗同层才生效
  // (同 SessionPanel 重命名弹窗的处理)
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal provider-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{isEdit ? `编辑提供方 · ${editProvider.name}` : '添加提供方'}</span>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {!isEdit && (
            <div className="field">
              <label>从预置提供商快速填充(可选,选择后自动带入名称与地址)</label>
              <GlassSelect full value={presetId} onChange={(v) => applyPreset(v)}
                placeholder="选择预置提供商…"
                options={PROVIDERS.filter((p) => !p.mock).map((p) => ({ value: p.id, label: p.name }))} />
            </div>
          )}
          <div className="field">
            <label>名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="如 公司内部网关 / my-proxy" autoFocus={!isEdit} />
          </div>
          <div className="field">
            <label>Base URL(OpenAI 兼容端点)</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-gateway/v1" />
          </div>
          <div className="field">
            <label>API Key(可选,仅存本机,随本条目保存)</label>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
          </div>

          {/* 模型区:手动输入 + 获取模型列表勾选 */}
          <div className="model-section">
            <div className="ms-head">
              <span className="ms-title">模型列表{models.length > 0 && ` · 已选 ${models.length} 个`}</span>
              <button className="sm" onClick={fetchModelList} disabled={fetching}>
                {fetching ? '获取中…' : '⟳ 获取模型列表'}
              </button>
            </div>
            <div className="row">
              <input className="grow" value={manualModel} onChange={(e) => setManualModel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addManualModel(); } }}
                placeholder="手动输入模型名,回车添加" />
              <button onClick={addManualModel}>添加</button>
            </div>
            {models.length > 0 && (
              <div className="model-config-list">
                {models.map((m) => {
                  const cfg = modelConfig[m] || {};
                  const dflt = getDefaultModelContext(m);
                  const fmt = (n?: number) => (n ? (n >= 1000000 ? (n / 1000000) + 'M' : n >= 1000 ? (n / 1000) + 'k' : String(n)) : '');
                  const mm = cfg.multimodal === true;
                  const ig = cfg.imageGen === true;
                  return (
                    <div key={m} className={`model-config-row${ig ? ' ig-on' : ''}`}>
                      <span className="mc-name" data-tip={m}>{m}</span>
                      {/* 生图开关:纯图像端点模型(gpt-image-2 等)在 chat/completions 会被网关 503 拒绝,
                          开启后该对话每一轮直接走 /images/generations(文生图)或 /images/edits(图生图) */}
                      <label className="mc-field mc-ig" data-tip={ig
                        ? '已开启:该对话每轮直接生成图片(文生图 / 图生图 / 按上文成图迭代修改)'
                        : '开启后本对话切换为生图对话:直接调用 /images/generations 与 /images/edits,不再走文本对话与工具'}>
                        <span>生图</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={ig}
                          className={`mc-switch ${ig ? 'on' : ''}`}
                          onClick={() => {
                            // 与多模态互斥:生图模型没有 chat 通道,"看图对话"这一能力对它无意义
                            if (!ig && mm) updateModelCfg(m, 'multimodal', '');
                            updateModelCfg(m, 'imageGen', ig ? '' : '1');
                          }}
                        ><span className="mc-knob" /></button>
                      </label>
                      {/* 多模态开关:开启后聊天输入框支持粘贴/上传图片(模型支持看图才勾选) */}
                      <label className="mc-field mc-mm" data-tip={mm ? '已开启:聊天中可发送图片' : '开启后聊天中可向该模型发送图片'}>
                        <span>多模态</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={mm}
                          disabled={ig}
                          className={`mc-switch ${mm ? 'on' : ''}`}
                          onClick={() => updateModelCfg(m, 'multimodal', mm ? '' : '1')}
                        ><span className="mc-knob" /></button>
                      </label>
                      {/* 上下文/最大输出只对文本模型有意义:生图链路不注入历史、不设 max_tokens */}
                      <label className="mc-field" data-tip={ig ? '生图模型不使用该参数(不走文本请求)' : undefined}>
                        <span>上下文</span>
                        <input type="number" min={0} step={1000} disabled={ig}
                          value={cfg.contextWindow ? String(cfg.contextWindow) : ''}
                          placeholder={dflt.contextWindow ? '默认 ' + fmt(dflt.contextWindow) : '默认'}
                          onChange={(e) => updateModelCfg(m, 'contextWindow', e.target.value)} />
                      </label>
                      <label className="mc-field" data-tip={ig ? '生图模型不使用该参数(不走文本请求)' : undefined}>
                        <span>最大输出</span>
                        <input type="number" min={0} step={256} disabled={ig}
                          value={cfg.maxTokens ? String(cfg.maxTokens) : ''}
                          placeholder={dflt.maxTokens ? '默认 ' + fmt(dflt.maxTokens) : '默认'}
                          onChange={(e) => updateModelCfg(m, 'maxTokens', e.target.value)} />
                      </label>
                      <button className="mc-remove action-icon danger" onClick={() => toggleModel(m)}>✕</button>
                      {ig && (
                        <div className="mc-ig-hint">
                          该模型将作为生图模型使用:发送文字＝文生图；附带图片＝图生图；后续每轮自动携带上一张成图继续修改
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {remoteModels && (
              <div className="model-picker">
                {remoteModels.length > 8 && (
                  <input placeholder={`过滤 ${remoteModels.length} 个模型…`} value={filter}
                    onChange={(e) => setFilter(e.target.value)} />
                )}
                <div className="model-rows">
                  {filteredRemote.map((m) => (
                    <label key={m} className="model-row">
                      <input type="checkbox" checked={models.includes(m)} onChange={() => toggleModel(m)} />
                      <span>{m}</span>
                    </label>
                  ))}
                  {filteredRemote.length === 0 && <div className="model-empty">无匹配模型</div>}
                </div>
                {remoteModels.length > 0 && (
                  <div className="hint">端点共 {remoteModels.length} 个模型,勾选加入提供方</div>
                )}
              </div>
            )}

          </div>

          {error && <div className="error">✕ {error}</div>}
        </div>
        <div className="modal-foot row gap">
          <button className="grow" onClick={onClose} disabled={saving}>取消</button>
          <button className="primary grow" onClick={submit} disabled={saving || fetching}>
            {saving ? '保存中…' : isEdit ? '保存' : '保存并使用'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}