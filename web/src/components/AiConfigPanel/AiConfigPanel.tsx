// AI 模型 · 提供商配置面板(位于设置面板中)
// 布局:我的提供商列表(使用中置顶,增删改复制);预置提供商不单独展示,
// 仅作为「添加提供方」弹窗里的快速填充模板(预置了标准接口地址,免手输 Base URL)
// 状态与聊天输入框下方的切换器共享(见 llm-context.tsx)
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLlm } from '../../context/llm-context';
import { PROVIDERS, getDefaultModelContext } from '../../data/llm-providers';
import type { LlmProvider, ProviderDraft, ModelContextConfig } from '../../types';
import GlassSelect from '../GlassSelect/GlassSelect';
import './AiConfigPanel.scss';

// ---- 生图工具(generate_image)的独立端点配置 ----
// 与「我的提供商」彻底解耦:对话用哪个文本模型都不影响生图走这里配的端点。
// 这正是"对话式生图"的推荐接法 —— 文本模型负责理解需求、补全提示词、挑尺寸质量,
// 生图端点只负责一次性执行;两者可以是完全不同的两家平台。
// 预设仅填充 Base URL / 模型名 / 方言(绝不含任何 Key),可自由改成任意 OpenAI 兼容图像网关。
const IMAGE_TOOL_PRESETS = [
  { id: 'openai_gpt_image', name: 'OpenAI 官方 · gpt-image-1', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', dialect: 'image_array' },
  { id: 'fucheers_gpt_image2', name: 'fucheers 网关 · gpt-image-2', baseUrl: 'https://www.fucheers.top/v1', model: 'gpt-image-2', dialect: 'image_array' },
  { id: 'openai_dalle2', name: 'OpenAI · dall-e-2(仅单图参考)', baseUrl: 'https://api.openai.com/v1', model: 'dall-e-2', dialect: 'image_single' }
];
const IMAGE_DIALECTS = [
  { value: 'auto', label: '自动(优先 image[] 多图,被拒时降级单图)' },
  { value: 'image_array', label: 'image[] 多图(gpt-image 系列)' },
  { value: 'image_single', label: 'image 单图(dall-e-2 等旧方言)' }
];

interface ImageToolCfg {
  baseUrl: string; apiKey: string; model: string;
  quality: string; size: string; dialect: string;
}
const EMPTY_IMAGE_CFG: ImageToolCfg = { baseUrl: '', apiKey: '', model: '', quality: 'auto', size: 'auto', dialect: 'auto' };

function ImageToolCard() {
  const [cfg, setCfg] = useState<ImageToolCfg>(EMPTY_IMAGE_CFG);
  const [preset, setPreset] = useState('');
  const [sizeOpts, setSizeOpts] = useState<Array<{ value: string; label: string }>>([{ value: 'auto', label: '自动' }]);
  const [qualities, setQualities] = useState<string[]>(['auto', 'low', 'medium', 'high']);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    fetch('/api/image-tool')
      .then((r) => r.json())
      .then((j) => {
        if (j?.imageTool) { setConfigured(true); setCfg({ ...EMPTY_IMAGE_CFG, ...j.imageTool }); }
        if (Array.isArray(j?.options?.sizes) && j.options.sizes.length) setSizeOpts(j.options.sizes);
        if (Array.isArray(j?.options?.qualities) && j.options.qualities.length) setQualities(j.options.qualities);
      })
      .catch(() => { /* 读失败按未配置呈现,保存仍可重试 */ });
  }, []);

  const set = (k: keyof ImageToolCfg, v: string) => { setCfg((c) => ({ ...c, [k]: v })); setMsg(null); };
  const applyPreset = (id: string) => {
    setPreset(id);
    const p = IMAGE_TOOL_PRESETS.find((x) => x.id === id);
    if (p) setCfg((c) => ({ ...c, baseUrl: p.baseUrl, model: p.model, dialect: p.dialect }));
  };

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/image-tool', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageTool: cfg })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setConfigured(true);
      if (j?.imageTool) setCfg({ ...EMPTY_IMAGE_CFG, ...j.imageTool });
      setMsg({ kind: 'ok', text: '已保存。对话中让 AI 生图即可(文本模型会自动调用 generate_image 工具)。' });
    } catch (e) {
      setMsg({ kind: 'err', text: '保存失败:' + (e as Error).message });
    } finally { setBusy(false); }
  };

  const clear = async () => {
    setBusy(true); setMsg(null);
    try {
      await fetch('/api/image-tool', { method: 'DELETE' });
      setCfg(EMPTY_IMAGE_CFG); setPreset(''); setConfigured(false);
      setMsg({ kind: 'ok', text: '已清除配置。' });
    } catch (e) {
      setMsg({ kind: 'err', text: '清除失败:' + (e as Error).message });
    } finally { setBusy(false); }
  };

  // 连通性自检:拉一次模型列表。生图端点即使没有 /models 也能正常出图,
  // 所以这里失败只提示、不拦保存(避免把可用端点误判为不可用)。
  const testConn = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/image-tool/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      const hit = (j.models || []).includes(cfg.model);
      setMsg({
        kind: 'ok',
        text: j.models?.length
          ? `端点可达,返回 ${j.models.length} 个模型${hit ? `,已确认含 ${cfg.model}` : `,但未列出 ${cfg.model}(仍可尝试保存:部分网关不枚举图像模型)`}`
          : '端点可达(/models 未返回模型清单,不影响生图)'
      });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally { setBusy(false); }
  };

  return (
    <div className="image-tool-card">
      <div className="panel-title row">
        <span>生图工具</span>
        <span className={`muted sm ${configured ? 'it-ok' : 'it-warn'}`}>
          ({configured ? `已配置 · ${cfg.model || '?'}` : '未配置'})
        </span>
        <span className="grow" />
        <span className="muted sm">供 AI 在对话中调用,与上面的对话模型互相独立</span>
      </div>
      <div className="it-body">
        <div className="field">
          <label>从预设平台快速填充(可选,仅带入地址与模型名)</label>
          <GlassSelect full value={preset} onChange={applyPreset} placeholder="选择生图平台…"
            options={IMAGE_TOOL_PRESETS.map((p) => ({ value: p.id, label: p.name }))} />
        </div>
        <div className="field">
          <label>Base URL(OpenAI 兼容图像端点,需含 /v1)</label>
          <input value={cfg.baseUrl} onChange={(e) => set('baseUrl', e.target.value)}
            placeholder="https://www.fucheers.top/v1 或 https://api.openai.com/v1" />
        </div>
        <div className="field">
          <label>API Key(仅存本机 settings.json,不下发前端列表)</label>
          <input type="password" value={cfg.apiKey} onChange={(e) => set('apiKey', e.target.value)} placeholder="sk-…" />
        </div>
        <div className="field">
          <label>生图模型名</label>
          <input value={cfg.model} onChange={(e) => set('model', e.target.value)} placeholder="gpt-image-2 / gpt-image-1 / dall-e-2…" />
        </div>
        <div className="it-grid">
          <label className="mc-field">
            <span>默认质量</span>
            <GlassSelect full value={cfg.quality} onChange={(v) => set('quality', v)}
              options={qualities.map((q) => ({ value: q, label: q }))} />
          </label>
          <label className="mc-field">
            <span>默认尺寸</span>
            <GlassSelect full value={cfg.size} onChange={(v) => set('size', v)} options={sizeOpts} />
          </label>
        </div>
        <div className="field">
          <label>参考图字段方言(图生图)</label>
          <GlassSelect full value={cfg.dialect} onChange={(v) => set('dialect', v)} options={IMAGE_DIALECTS} />
        </div>
        {msg && <div className={`it-msg ${msg.kind}`}>{msg.kind === 'ok' ? '✓ ' : '✕ '}{msg.text}</div>}
        <div className="row it-actions">
          <button onClick={save} disabled={busy || !cfg.baseUrl.trim() || !cfg.model.trim()}>
            {busy ? '处理中…' : '保存配置'}
          </button>
          <button onClick={testConn} disabled={busy || !/^https?:\/\//i.test(cfg.baseUrl.trim())}>测试连通性</button>
          <span className="grow" />
          {configured && <button className="sm danger" onClick={clear} disabled={busy}>清除</button>}
        </div>
        <div className="hint">
          尺寸与质量是图像端点的真实参数(size / quality),不是拼进提示词传的;但部分网关会忽略
          size(实测有网关把 1024×1024 改成 1312×1199),以成图实际尺寸为准。
          未配置时,AI 调用生图会收到"请去配置"的提示,不会静默失败。
        </div>
      </div>
    </div>
  );
}

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

      {/* ---- 生图工具:独立于对话模型的图像端点配置(AI 通过 generate_image 工具调用) ---- */}
      <ImageToolCard />

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