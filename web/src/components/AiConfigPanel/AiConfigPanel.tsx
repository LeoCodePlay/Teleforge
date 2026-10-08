// AI 模型 · 提供商配置面板(位于设置面板中)
// 布局:我的提供商列表(使用中置顶,增删改复制);预置提供商不单独展示,
// 仅作为「添加提供方」弹窗里的快速填充模板(预置了标准接口地址,免手输 Base URL)
// 状态与聊天输入框下方的切换器共享(见 llm-context.tsx);生图端点配置已独立为设置菜单的「生图配置」
import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLlm } from '../../context/llm-context';
import { PROVIDERS, getDefaultModelContext } from '../../data/llm-providers';
import type { LlmProvider, ProviderDraft, ModelContextConfig, KeyState, LlmProtocol } from '../../types';
import { parseCountInput, formatCountInput } from '../../utils/tokens';
import { IconTrashOutline14, IconEye16, IconEyeOff16 } from '../icons/icons';
import GlassSelect from '../GlassSelect/GlassSelect';
import './AiConfigPanel.scss';

export default function AiConfigPanel() {
  const llm = useLlm();
  const { userProviders, providerId, switchProvider, addProvider, updateProvider,
    duplicateProvider, removeProvider, resetProviderKey } = llm;
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
            onDelete={() => removeProvider(p.id)}
            onResetKey={(k) => resetProviderKey(p.id, k)} />
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

/** 该提供商配置的全部 Key(去重、去空);首位为主 Key(apiKey) */
function keyList(p: LlmProvider): string[] {
  return [...new Set([p.apiKey, ...(p.apiKeys || [])].map((k) => String(k || '').trim()).filter(Boolean))] as string[];
}

/** Key 是否已被判定不可用(余额不足 / 鉴权失败):两种标记的徽标文案不同,但都不参与轮询 */
function keyUnusable(st?: KeyState): boolean {
  return st?.exhausted === true || st?.invalid === true;
}

/** 展示用脱敏:只露头尾,避免整串 Key 出现在界面上 */
function maskKey(k: string): string {
  return k.length <= 12 ? k : `${k.slice(0, 6)}…${k.slice(-4)}`;
}

// ---- 提供商卡片:名称/地址/模型数 + 编辑/复制/删除 ----
interface ProviderCardProps {
  p: LlmProvider;
  active: boolean;
  onUse: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
  /** 清除某个「无余额」Key 的标记(充值后点「重置」,下次重试会再次尝试它) */
  onResetKey: (key: string) => void;
}

function ProviderCard({ p, active, onUse, onEdit, onCopy, onDelete, onResetKey }: ProviderCardProps) {
  return (
    <div className={'provider-card' + (active ? ' active' : '')} onClick={onUse}>
      <div className="pc-head">
        <span className="pc-name">{p.name}</span>
        {active && <span className="badge ok">使用中</span>}
        {/* 非 OpenAI 协议的条目要一眼能认出来:它决定了端点与请求形态,排查时不能靠点开弹窗才知道 */}
        {p.protocol && p.protocol !== 'openai' && <span className="badge">{PROTOCOL_LABEL[p.protocol]}</span>}
      </div>
      <div className="pc-url">{p.baseUrl}</div>
      <div className="pc-meta">
        <span>{p.models.length > 0 ? `${p.models.length} 个模型` : '无模型(手动输入)'}</span>
        <span>{keyList(p).length > 1 ? `${keyList(p).length} 个 Key` : (p.apiKey ? 'Key 已配置' : '未配置 Key')}</span>
      </div>
      {/* 多 Key 状态:被判定不可用的 Key 显示「无余额」(充值)或「失效」(鉴权失败/无效),
          并给出「重置」——两种都靠重置按钮恢复参与轮询(否则会被一直跳过) */}
      {keyList(p).length > 0 && (
        <div className="pc-keys" onClick={(e) => e.stopPropagation()}>
          {keyList(p).map((k) => {
            const st = p.keyStates?.[k];
            const bad = keyUnusable(st);
            return (
              <div key={k} className={'pc-key' + (bad ? ' exhausted' : '')}>
                <span className="pc-key-mask">{maskKey(k)}</span>
                {bad
                  ? (
                    <>
                      <span className="badge warn" data-tip={st?.reason || (st?.invalid ? '该 Key 鉴权失败(无效/过期/被撤销)' : '该 Key 余额不足')}>
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

// ---- 添加 / 编辑提供商弹窗 ----
// 添加模式:可从预置提供商下拉快速填充;两类模式均可「获取模型列表」勾选模型
interface ProviderModalProps {
  editProvider: LlmProvider | null;
  onClose: () => void;
  onSave: (data: ProviderDraft) => Promise<boolean>;
}

/** 协议选项:决定请求端点、鉴权头与请求/响应体方言(见 server/agent/llm.ts 的协议适配) */
const PROTOCOL_OPTIONS: { value: LlmProtocol; label: string; hint: string }[] = [
  { value: 'openai', label: 'OpenAI 兼容 · /chat/completions', hint: '默认,覆盖绝大多数网关' },
  { value: 'anthropic', label: 'Anthropic Messages · /v1/messages', hint: 'Claude 及兼容端点' },
  { value: 'gemini', label: 'Google Gemini · 原生', hint: 'streamGenerateContent' }
];

/** 协议短名(卡片徽标、预置下拉后缀用) */
const PROTOCOL_LABEL: Record<string, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic 协议',
  gemini: 'Gemini 协议'
};

/** Base URL 的占位按协议给:协议已在上方选定,标签统一为 "Base URL",
 *  地址形态由占位示例表达(官方地址直接填,不必自己补 /v1/messages 之类的路径段) */
const PROTOCOL_URL_PLACEHOLDER: Record<LlmProtocol, string> = {
  openai: 'https://your-gateway/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta'
};

function ProviderModal({ editProvider, onClose, onSave }: ProviderModalProps) {
  const isEdit = !!editProvider;
  const [name, setName] = useState(isEdit ? editProvider.name : '');
  const [baseUrl, setBaseUrl] = useState(isEdit ? editProvider.baseUrl : '');
  // 协议:旧条目没有该字段 → 按 OpenAI 兼容处理
  const [protocol, setProtocol] = useState<LlmProtocol>(isEdit ? (editProvider.protocol || 'openai') : 'openai');
  const isOpenAiProtocol = protocol === 'openai';
  // 多个 API Key(轮询用):某个 Key 余额不足时自动切换到下一个;首位为主 Key
  const [apiKeys, setApiKeys] = useState<string[]>(() => {
    if (!isEdit) return [''];
    const list = [...new Set([editProvider.apiKey, ...(editProvider.apiKeys || [])]
      .map((k) => String(k || '').trim()).filter(Boolean))];
    return list.length ? list : [''];
  });
  const [models, setModels] = useState<string[]>(isEdit ? [...(editProvider.models || [])] : []);
  // 每个模型的上下文能力(输入窗口/输出上限),随条目随保存落盘
  const [modelConfig, setModelConfig] = useState<Record<string, ModelContextConfig>>(
    isEdit ? { ...(editProvider.modelConfig || {}) } : {}
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // 明文显示的行(按行下标记录,与 apiKeys 数组同序)。默认全部遮罩:
  // Key 是密码级信息,滚动/截屏时不应默认外露;要看时点行尾眼睛显式露出。
  // 增删 Key 后下标会错位,但最坏只是某行延续了相邻行的显隐状态,不影响输入与保存。
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  // 数字输入框的文本草稿(键 = 模型名 + 字段):值支持 1M / 128k 这类带单位写法。
  // 若不保留草稿、直接受控于解析后的数字,"1.5M" 在敲到 "1." 时就会被打断改写。
  const [numDraft, setNumDraft] = useState<Record<string, string>>({});
  const draftKey = (m: string, field: string) => m + '\u0000' + field;
  const setDraft = (key: string, text: string) => setNumDraft((d) => ({ ...d, [key]: text }));
  // 失焦后丢弃草稿:输入框回到规范化显示(输入 1000000 → 显示 1M;非法文本回落到上一次有效值)
  const dropDraft = (key: string) => setNumDraft((d) => {
    if (!(key in d)) return d;
    const next = { ...d };
    delete next[key];
    return next;
  });

  // 直接更新某模型的能力配置(上下文窗口/输出上限/多模态/生图);全部为空或关闭时清除该条配置。
  // 布尔开关用 '1'/'' 两个字符串值复用同一签名(与数字字段一致的调用形态)
  const updateModelCfg = (m: string, field: 'contextWindow' | 'maxTokens' | 'multimodal' | 'imageGen', raw: string) => {
    setModelConfig((cur) => {
      const next = { ...cur };
      const prev: ModelContextConfig = { ...(next[m] || {}) };
      if (field === 'multimodal' || field === 'imageGen') prev[field] = raw === '1' ? true : undefined;
      else {
        // 数字字段支持带单位输入(1M=1000000、128k=128000);清空即取消配置,非法文本保留上一次有效值
        const text = String(raw ?? '').trim();
        if (!text) prev[field] = undefined;
        else {
          const n = parseCountInput(text);
          if (n !== undefined) prev[field] = n;
        }
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

  // 预置模板下拉(添加模式):选中后填充名称、协议与 Base URL
  const [presetId, setPresetId] = useState('');
  const applyPreset = (id: string) => {
    setPresetId(id);
    const p = PROVIDERS.find((x) => x.id === id);
    if (p) {
      setName(p.name);
      setBaseUrl(p.baseUrl);
      setProtocol(p.protocol || 'openai');
    }
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
        body: JSON.stringify({ baseUrl: b, apiKey: (apiKeys[0] || '').trim(), protocol })
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
      // 移除模型时同步清除其上下文配置与输入草稿
      setModelConfig((mc) => { const n = { ...mc }; delete n[m]; return n; });
      setNumDraft((d) => {
        const n = { ...d };
        for (const k of Object.keys(n)) if (k.startsWith(m + '\u0000')) delete n[k];
        return n;
      });
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
    // 去空去重后提交:apiKey 镜像首个(主 Key),apiKeys 是完整轮询列表
    const keys = [...new Set(apiKeys.map((k) => k.trim()).filter(Boolean))];
    const ok = await onSave({ name: n, baseUrl: b, protocol, models, apiKey: keys[0] || '', apiKeys: keys, modelConfig });
    if (ok) onClose();
    else setSaving(false);
  };

  // portal 到 body:本弹窗内联在设置面板里。既避免被祖先的 overflow/fixed 包含块困住,
  // 也保证遮罩覆盖整页而不是只覆盖设置面板内部(同 SessionPanel 重命名弹窗的处理)。
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
              <label>从预置提供商快速填充(可选,选择后自动带入名称、协议与地址)</label>
              <GlassSelect full value={presetId} onChange={(v) => applyPreset(v)}
                placeholder="选择预置提供商…"
                options={PROVIDERS.filter((p) => !p.mock).map((p) => ({
                  value: p.id,
                  label: p.name,
                  hint: PROTOCOL_LABEL[p.protocol || 'openai']
                }))} />
            </div>
          )}
          <div className="field">
            <label>名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="如 公司内部网关 / my-proxy" autoFocus={!isEdit} />
          </div>
          {/* 协议决定端点与鉴权方式:非 OpenAI 兼容的厂商(Claude / Gemini)必须在这里选对,否则请求形态不匹配 */}
          <div className="field">
            <label>协议</label>
            <GlassSelect full value={protocol} onChange={(v) => setProtocol(v as LlmProtocol)}
              options={PROTOCOL_OPTIONS.map((o) => ({ value: o.value, label: o.label, hint: o.hint }))} />
          </div>
          <div className="field">
            <label>Base URL</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={PROTOCOL_URL_PLACEHOLDER[protocol]} />
          </div>
          <div className="field">
            <label>API Key(可填多个:某个 Key 不可用时自动切换到下一个;仅存本机)</label>
            <div className="key-list">
              {apiKeys.map((k, i) => {
                const st = isEdit ? editProvider.keyStates?.[k.trim()] : undefined;
                const bad = keyUnusable(st);
                const shown = revealed.has(i);
                return (
                  <div key={i} className={'key-row' + (bad ? ' exhausted' : '')}>
                    <input type={shown ? 'text' : 'password'} value={k}
                      placeholder={i === 0 ? 'sk-…(主 Key)' : 'sk-…(备用 Key)'}
                      onChange={(e) => setApiKeys((cur) => cur.map((v, j) => (j === i ? e.target.value : v)))} />
                    {bad && (
                      <span className="badge warn" data-tip={st?.reason || (st?.invalid ? '该 Key 鉴权失败(无效/过期/被撤销)' : '该 Key 余额不足')}>
                        {st?.invalid ? '失效' : '无余额'}
                      </span>
                    )}
                    {/* 显隐切换:点眼睛在明文/遮罩之间切换(仅影响显示,不改动值) */}
                    <button type="button" className="key-reveal action-icon"
                      aria-label={shown ? '隐藏 Key' : '显示 Key 明文'}
                      aria-pressed={shown}
                      onClick={() => setRevealed((cur) => {
                        const next = new Set(cur);
                        if (next.has(i)) next.delete(i); else next.add(i);
                        return next;
                      })}>
                      {shown ? <IconEyeOff16 size={16} /> : <IconEye16 size={16} />}
                    </button>
                    {/* 单 Key 行不给删除:删空后无从恢复「主 Key」输入位,由上方「＋ 添加 Key」重新加行 */}
                    {apiKeys.length > 1 && (
                      <button type="button" className="key-del action-icon danger"
                        aria-label="删除该 Key"
                        onClick={() => setApiKeys((cur) => cur.filter((_, j) => j !== i))}>
                        <IconTrashOutline14 size={14} />
                      </button>
                    )}
                  </div>
                );
              })}
              <button type="button" className="sm" onClick={() => setApiKeys((cur) => [...cur, ''])}>＋ 添加 Key</button>
            </div>
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
                  // 生图链路只实现了 OpenAI 协议端点(/images/generations|edits):
                  // 非 OpenAI 协议下该开关不生效(禁用),避免"开了却不走生图"的静默错配
                  const mm = cfg.multimodal === true;
                  const ig = cfg.imageGen === true && isOpenAiProtocol;
                  const ctxKey = draftKey(m, 'contextWindow');
                  const outKey = draftKey(m, 'maxTokens');
                  return (
                    <div key={m} className={`model-config-row${ig ? ' ig-on' : ''}`}>
                      <span className="mc-name" data-tip={m}>{m}</span>
                      {/* 生图开关:纯图像端点模型(gpt-image-2 等)在 chat/completions 会被网关 503 拒绝,
                          开启后该对话每一轮直接走 /images/generations(文生图)或 /images/edits(图生图) */}
                      <label className="mc-field mc-ig" data-tip={!isOpenAiProtocol
                        ? '生图对话只支持 OpenAI 兼容协议(/images/generations 与 /images/edits);当前协议下该开关不生效'
                        : ig
                          ? '已开启:该对话每轮直接生成图片(文生图 / 图生图 / 按上文成图迭代修改)'
                          : '开启后本对话切换为生图对话:直接调用 /images/generations 与 /images/edits,不再走文本对话与工具'}>
                        <span>生图</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={ig}
                          disabled={!isOpenAiProtocol}
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
                      {/* 上下文/最大输出只对文本模型有意义:生图链路不注入历史、不设 max_tokens。
                          均为文本输入框,接受 1M / 128k 这类带单位写法(1M=1000000、128k=128000) */}
                      <label className="mc-field" data-tip={ig ? '生图模型不使用该参数(不走文本请求)' : '可填纯数字,也可带单位:1M = 100 万、128k = 12.8 万'}>
                        <span>上下文</span>
                        <input type="text" inputMode="numeric" autoComplete="off" disabled={ig}
                          value={numDraft[ctxKey] ?? formatCountInput(cfg.contextWindow)}
                          placeholder={dflt.contextWindow ? '默认 ' + formatCountInput(dflt.contextWindow) : '默认'}
                          onChange={(e) => { setDraft(ctxKey, e.target.value); updateModelCfg(m, 'contextWindow', e.target.value); }}
                          onBlur={() => dropDraft(ctxKey)} />
                      </label>
                      <label className="mc-field" data-tip={ig ? '生图模型不使用该参数(不走文本请求)' : '可填纯数字,也可带单位:1M = 100 万、32k = 3.2 万'}>
                        <span>最大输出</span>
                        <input type="text" inputMode="numeric" autoComplete="off" disabled={ig}
                          value={numDraft[outKey] ?? formatCountInput(cfg.maxTokens)}
                          placeholder={dflt.maxTokens ? '默认 ' + formatCountInput(dflt.maxTokens) : '默认'}
                          onChange={(e) => { setDraft(outKey, e.target.value); updateModelCfg(m, 'maxTokens', e.target.value); }}
                          onBlur={() => dropDraft(outKey)} />
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