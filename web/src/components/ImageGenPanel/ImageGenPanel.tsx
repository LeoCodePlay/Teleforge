// 生图配置面板(设置左侧菜单「生图配置」,与「AI 配置」并列的独立设置面板)
//
// 布局与「AI 配置 → 我的提供商」一致:上面是模型商卡片列表(使用中置顶,点击卡片切换),
// 下面是「添加模型商」;点编辑/添加弹出同一个表单弹窗。每条模型商自带
// Base URL / API Key(可多个)/ 模型名 / 默认质量尺寸 / 参考图方言。
//
// 它与「AI 配置 → 我的提供商」彻底解耦 —— 对话用哪个文本模型都不影响生图走这里配的端点,
// 两者甚至可以是完全不同的两家平台。generate_image 工具始终使用「使用中」的那一条。
//
// 生图有两条链路,面板下方据此向用户解释二者分工:
//  1) generate_image 工具(推荐)—— 对话模型仍是文本模型,由它在需要画图时调用本页端点;
//  2) imageGen 生图对话 —— 所选模型本身就是纯图像端点模型,整轮旁路到 /images/*,
//     用的是该提供方自己的端点配置(在「AI 配置」里声明),不吃本页这份配置。
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import GlassSelect from '../GlassSelect/GlassSelect';
import ApiKeyList from '../ApiKeyList/ApiKeyList';
import { keyUnusable, type KeyState } from '../../types';
import { keyList, keyStateTip, maskKey } from '../../utils/apiKeys';
import './ImageGenPanel.scss';

// 预设仅填充名称 / Base URL / 模型名 / 方言(绝不含任何 Key),可自由改成任意 OpenAI 兼容图像网关
const IMAGE_TOOL_PRESETS = [
  { id: 'openai_gpt_image', name: 'OpenAI 官方 · gpt-image-1', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', dialect: 'image_array' },
  { id: 'fucheers_gpt_image2', name: 'fucheers 网关 · gpt-image-2', baseUrl: 'https://www.fucheers.top/v1', model: 'gpt-image-2', dialect: 'image_array' },
  { id: 'openai_dalle2', name: 'OpenAI · dall-e-2(仅单图参考)', baseUrl: 'https://api.openai.com/v1', model: 'dall-e-2', dialect: 'image_single' }
];
const IMAGE_DIALECTS = [
  { value: 'auto', label: '自动(依次试 multipart 多图 → 单图 → JSON base64)' },
  { value: 'image_array', label: 'image[] 多图(gpt-image 系列,multipart 文件)' },
  { value: 'image_single', label: 'image 单图(dall-e-2 等旧方言,multipart 文件)' },
  { value: 'json_base64', label: 'JSON + base64(不收文件上传的网关)' }
];

/** 一条生图模型商(与服务端 image-providers-store 的 ImageProvider 同形) */
interface ImageProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiKeys?: string[];
  keyStates?: Record<string, KeyState>;
  model: string;
  quality: string;
  size: string;
  dialect: string;
}

interface ImageToolOptions {
  qualities: string[];
  sizes: Array<{ value: string; label: string }>;
}

/** 弹窗提交的草稿(apiKey 由 apiKeys 派生,不单独填) */
interface ImageProviderDraft {
  name: string;
  baseUrl: string;
  apiKeys: string[];
  model: string;
  quality: string;
  size: string;
  dialect: string;
}

const DEFAULT_OPTIONS: ImageToolOptions = {
  qualities: ['auto', 'low', 'medium', 'high'],
  sizes: [{ value: 'auto', label: '自动(由上游决定)' }]
};

export default function ImageGenPanel() {
  const [providers, setProviders] = useState<ImageProvider[]>([]);
  const [activeId, setActiveId] = useState('');
  const [options, setOptions] = useState<ImageToolOptions>(DEFAULT_OPTIONS);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');
  // 弹窗状态:null=关闭;{provider}=编辑该条目;{}=添加
  const [modal, setModal] = useState<{ provider?: ImageProvider } | null>(null);

  // 尺寸/质量枚举与服务端(settings-store)同源,避免前端再抄一份
  const applyOptions = (raw: any) => {
    const qualities = Array.isArray(raw?.qualities) && raw.qualities.length ? raw.qualities : DEFAULT_OPTIONS.qualities;
    const sizes = Array.isArray(raw?.sizes) && raw.sizes.length ? raw.sizes : DEFAULT_OPTIONS.sizes;
    setOptions({ qualities, sizes });
  };

  useEffect(() => {
    let alive = true;
    fetch('/api/image-providers')
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
        if (!alive) return;
        if (Array.isArray(j?.providers)) setProviders(j.providers as ImageProvider[]);
        if (typeof j?.activeId === 'string') setActiveId(j.activeId);
        applyOptions(j?.options);
      })
      .catch((e) => { if (alive) setErr('读取生图配置失败:' + (e as Error).message); })
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  // 所有写操作共用:成功后用服务端回包刷新列表与「使用中」,避免前端自己猜状态
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(path, init);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
    if (Array.isArray(j?.providers)) setProviders(j.providers as ImageProvider[]);
    if (typeof j?.activeId === 'string') setActiveId(j.activeId);
    return j;
  };

  const useProvider = async (id: string) => {
    try { await call(`/api/image-providers/${id}/use`, { method: 'POST' }); }
    catch (e) { setErr('切换生图模型商失败:' + (e as Error).message); }
  };

  const removeProvider = async (id: string) => {
    try { await call(`/api/image-providers/${id}`, { method: 'DELETE' }); }
    catch (e) { setErr('删除生图模型商失败:' + (e as Error).message); }
  };

  const resetKey = async (id: string, key: string) => {
    try {
      await call(`/api/image-providers/${id}/reset-key`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
    } catch (e) { setErr('重置 API Key 状态失败:' + (e as Error).message); }
  };

  // 复制:新增一条同配置的条目,但**不抢走**当前使用中的那条
  const copyProvider = async (p: ImageProvider) => {
    try {
      await call('/api/image-providers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: p.name + '(副本)', baseUrl: p.baseUrl, apiKeys: keyList(p), model: p.model,
          quality: p.quality, size: p.size, dialect: p.dialect, activate: false
        })
      });
    } catch (e) { setErr('复制生图模型商失败:' + (e as Error).message); }
  };

  // 弹窗保存:新增时切换为使用中(「保存并使用」);编辑只改当前条目
  const saveProvider = async (data: ImageProviderDraft, editing?: ImageProvider): Promise<void> => {
    const body = JSON.stringify({ ...data, ...(editing ? {} : { activate: true }) });
    await call(editing ? `/api/image-providers/${editing.id}` : '/api/image-providers', {
      method: editing ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
  };

  // 当前使用中的提供商置顶显示
  const sortedProviders = useMemo(() => [...providers].sort((a, b) => {
    if (a.id === activeId) return -1;
    if (b.id === activeId) return 1;
    return 0;
  }), [providers, activeId]);

  const active = providers.find((p) => p.id === activeId);

  return (
    <div className="image-gen-panel">
      <div className="panel-title row">
        <span>生图配置</span>
        <span className={`muted sm ${providers.length ? 'ig-on' : 'ig-off'}`}>
          ({providers.length ? `已配置 ${providers.length} 个 · 使用中 ${active?.name || '?'}` : '未配置'})
        </span>
        <span className="grow" />
        <span className="muted sm">与对话模型互相独立</span>
      </div>
      <div className="hint ig-lead">
        AI 在对话中画图时实际打的图像接口(OpenAI 兼容)。可添加多个生图模型商,
        点卡片切换「使用中」的那一个;改完立即生效,下一轮对话即用新配置。
      </div>

      {err && <div className="error" onClick={() => setErr('')}>✕ {err}</div>}

      {/* ---- 我的生图模型商(使用中置顶,点击卡片切换) ---- */}
      <div className="panel-title row">
        <span>我的生图模型商</span>
        <span className="muted sm">({providers.length})</span>
        <span className="grow" />
        <span className="muted sm">点击卡片切换为当前使用</span>
      </div>
      <div className="provider-list">
        {loaded && providers.length === 0 && (
          <div className="provider-empty">还没有生图模型商,点击下方按钮添加</div>
        )}
        {sortedProviders.map((p) => (
          <ProviderCard key={p.id} p={p} active={p.id === activeId}
            onUse={() => useProvider(p.id)}
            onEdit={() => setModal({ provider: p })}
            onCopy={() => copyProvider(p)}
            onDelete={() => removeProvider(p.id)}
            onResetKey={(k) => resetKey(p.id, k)} />
        ))}
        <button className="provider-add" onClick={() => setModal({})}>
          <span className="pa-icon">＋</span> 添加模型商
        </button>
      </div>

      {/* 添加 / 编辑弹窗:portal 到 body —— 设置弹窗自身带 backdrop-filter,
          嵌套其中会成为 backdrop-root,导致本弹窗 blur 采不到真实页面(玻璃失效、文字透出)。
          与 AI 配置的提供商弹窗同一处理(见 AiConfigPanel) */}
      {modal && createPortal(
        <ProviderModal
          editProvider={modal.provider || null}
          options={options}
          onClose={() => setModal(null)}
          onSave={(data) => saveProvider(data, modal.provider)}
        />,
        document.body
      )}

      {/* ---- 生图链路说明:用户最常问的是"我这样接对不对",放在列表下方备查 ---- */}
      <div className="panel-title ig-paths-title">生图链路</div>
      <div className="ig-paths">
        <div className="ig-path">
          <div className="ig-path-head">
            <span className="ig-path-tag">推荐</span>
            <span className="ig-path-name">对话式生图(generate_image 工具)</span>
          </div>
          <div className="ig-path-desc">
            对话仍用任意文本模型,由它在你要求画图时自动调用当前使用中的模型商:文本模型手里有完整对话历史,
            能把"再亮一点""把帽子换蓝"补全成自包含提示词,并自行决定文生图/图生图与尺寸质量。
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- 模型商卡片:名称/地址/模型/Key 状态 + 使用/编辑/复制/删除 ----
interface ProviderCardProps {
  p: ImageProvider;
  active: boolean;
  onUse: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
  /** 清除某个不可用 Key 的标记(充值/换好 Key 后点「重置」,下次重试会再次尝试它) */
  onResetKey: (key: string) => void;
}

function ProviderCard({ p, active, onUse, onEdit, onCopy, onDelete, onResetKey }: ProviderCardProps) {
  const keys = keyList(p);
  return (
    <div className={'provider-card' + (active ? ' active' : '')} onClick={onUse}>
      <div className="pc-head">
        <span className="pc-name">{p.name}</span>
        {active && <span className="badge ok">使用中</span>}
      </div>
      <div className="pc-url">{p.baseUrl}</div>
      <div className="pc-meta">
        <span>模型 {p.model}</span>
        <span>{keys.length > 1 ? `${keys.length} 个 Key` : (p.apiKey ? 'Key 已配置' : '未配置 Key')}</span>
        <span>默认 {p.quality} · {p.size}</span>
      </div>
      {/* 多 Key 状态:被判定不可用的 Key 显示「无余额」或「失效」,并给出「重置」 */}
      {keys.length > 0 && (
        <div className="pc-keys" onClick={(e) => e.stopPropagation()}>
          {keys.map((k) => {
            const st = p.keyStates?.[k];
            const bad = keyUnusable(st);
            return (
              <div key={k} className={'pc-key' + (bad ? ' exhausted' : '')}>
                <span className="pc-key-mask">{maskKey(k)}</span>
                {bad
                  ? (
                    <>
                      <span className="badge warn" data-tip={keyStateTip(st)}>
                        {st?.invalid ? '失效' : '无余额'}
                      </span>
                      <button className="sm" onClick={() => onResetKey(k)}>重置</button>
                    </>
                  )
                  : <span className="badge ok">可用</span>}
              </div>
            );
          })}
        </div>
      )}
      <div className="pc-actions" onClick={(e) => e.stopPropagation()}>
        {!active && <button className="sm" onClick={onUse}>使用</button>}
        <button className="sm" onClick={onEdit}>编辑</button>
        <button className="sm" onClick={onCopy}>复制</button>
        <button className="sm danger" onClick={onDelete}>删除</button>
      </div>
    </div>
  );
}

// ---- 添加 / 编辑模型商弹窗 ----
interface ProviderModalProps {
  editProvider: ImageProvider | null;
  options: ImageToolOptions;
  onClose: () => void;
  onSave: (data: ImageProviderDraft) => Promise<void>;
}

function ProviderModal({ editProvider, options, onClose, onSave }: ProviderModalProps) {
  const isEdit = !!editProvider;
  const [name, setName] = useState(isEdit ? editProvider.name : '');
  const [baseUrl, setBaseUrl] = useState(isEdit ? editProvider.baseUrl : '');
  // 多个 API Key(轮询用):某个 Key 余额不足/鉴权失败时自动切换到下一个;首位为主 Key
  const [apiKeys, setApiKeys] = useState<string[]>(() => {
    if (!isEdit) return [''];
    const list = keyList(editProvider);
    return list.length ? list : [''];
  });
  const [model, setModel] = useState(isEdit ? editProvider.model : '');
  const [quality, setQuality] = useState(isEdit ? editProvider.quality : 'auto');
  const [size, setSize] = useState(isEdit ? editProvider.size : 'auto');
  const [dialect, setDialect] = useState(isEdit ? editProvider.dialect : 'auto');
  const [presetId, setPresetId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // 预置模板下拉(添加模式):只填名称/地址/模型/方言,绝不覆盖已填的 Key
  const applyPreset = (id: string) => {
    setPresetId(id);
    const p = IMAGE_TOOL_PRESETS.find((x) => x.id === id);
    if (p) {
      setName(p.name);
      setBaseUrl(p.baseUrl);
      setModel(p.model);
      setDialect(p.dialect);
    }
    setError(''); setMsg(null);
  };

  // 连通性自检:拉一次模型列表。生图端点即使没有 /models 也能正常出图,
  // 所以这里失败只提示、不拦保存(避免把可用端点误判为不可用)。
  const testConn = async () => {
    const b = baseUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(b)) return setError('请先填写正确的 Base URL 再测试连接');
    const key = apiKeys.map((k) => k.trim()).find(Boolean) || '';
    setTesting(true); setError(''); setMsg(null);
    try {
      const r = await fetch('/api/image-providers/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: b, apiKey: key })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      const m = model.trim();
      const hit = (j.models || []).includes(m);
      setMsg({
        kind: 'ok',
        text: j.models?.length
          ? `端点可达,返回 ${j.models.length} 个模型${hit ? `,已确认含 ${m}` : `,但未列出 ${m}(仍可尝试保存:部分网关不枚举图像模型)`}`
          : '端点可达(/models 未返回模型清单,不影响生图)'
      });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally { setTesting(false); }
  };

  const submit = async () => {
    const n = name.trim();
    const b = baseUrl.trim().replace(/\/+$/, '');
    const m = model.trim();
    if (!n) return setError('请填写模型商名称(如 OpenAI 官方 / 公司图像网关)');
    if (!b) return setError('请填写 Base URL');
    if (!/^https?:\/\//i.test(b)) return setError('Base URL 需以 http:// 或 https:// 开头');
    if (!m) return setError('请填写生图模型名(如 gpt-image-1 / gpt-image-2)');
    setSaving(true); setError(''); setMsg(null);
    // 去空去重后提交:服务端会把 apiKey 对齐为 apiKeys 首项
    const keys = [...new Set(apiKeys.map((k) => k.trim()).filter(Boolean))];
    try {
      await onSave({ name: n, baseUrl: b, apiKeys: keys, model: m, quality, size, dialect });
      onClose();
    } catch (e) {
      setError('保存失败:' + (e as Error).message);
      setSaving(false);
    }
  };

  // portal 到 body:既避免被祖先的 overflow/fixed 包含块困住,
  // 也保证遮罩覆盖整页而不是只覆盖设置面板内部(同 AI 配置的提供商弹窗)
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal image-provider-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{isEdit ? `编辑模型商 · ${editProvider.name}` : '添加生图模型商'}</span>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {!isEdit && (
            <div className="field">
              <label>从预设平台快速填充(可选,选择后自动带入名称、地址、模型与方言)</label>
              <GlassSelect full value={presetId} onChange={applyPreset}
                placeholder="选择生图平台…"
                options={IMAGE_TOOL_PRESETS.map((p) => ({ value: p.id, label: p.name }))} />
            </div>
          )}
          <div className="field">
            <label>名称</label>
            <input value={name} onChange={(e) => { setName(e.target.value); setError(''); setMsg(null); }}
              placeholder="如 OpenAI 官方 / fucheers 网关" autoFocus={!isEdit} />
          </div>
          <div className="field">
            <label>Base URL(OpenAI 兼容图像端点,需含 /v1)</label>
            <input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setError(''); setMsg(null); }}
              placeholder="https://www.fucheers.top/v1 或 https://api.openai.com/v1" />
          </div>
          <div className="field">
            <label>API Key(可填多个:某个 Key 不可用时自动切换到下一个;仅存本机)</label>
            <ApiKeyList keys={apiKeys} onChange={setApiKeys} states={isEdit ? editProvider.keyStates : undefined} />
          </div>
          <div className="field">
            <label>生图模型名</label>
            <input value={model} onChange={(e) => { setModel(e.target.value); setError(''); setMsg(null); }}
              placeholder="gpt-image-2 / gpt-image-1 / dall-e-2…" />
          </div>
          <div className="ig-grid">
            <div className="field">
              <label>默认质量</label>
              <GlassSelect full value={quality} onChange={setQuality}
                options={options.qualities.map((q) => ({ value: q, label: q }))} />
            </div>
            <div className="field">
              <label>默认尺寸</label>
              <GlassSelect full value={size} onChange={setSize} options={options.sizes} />
            </div>
          </div>
          <div className="field">
            <label>参考图字段方言(图生图)</label>
            <GlassSelect full value={dialect} onChange={setDialect} options={IMAGE_DIALECTS} />
          </div>
          {msg && <div className={`ig-msg ${msg.kind}`}>{msg.kind === 'ok' ? '✓ ' : '✕ '}{msg.text}</div>}
          {error && <div className="error">✕ {error}</div>}
        </div>
        <div className="modal-foot row gap">
          <button className="grow" onClick={onClose} disabled={saving}>取消</button>
          <button className="grow" onClick={testConn} disabled={saving || testing || !/^https?:\/\//i.test(baseUrl.trim())}>
            {testing ? '测试中…' : '测试连通性'}
          </button>
          <button className="primary grow" onClick={submit} disabled={saving || testing}>
            {saving ? '保存中…' : isEdit ? '保存' : '保存并使用'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
