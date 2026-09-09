// 生图配置面板(设置左侧菜单「生图配置」,与「AI 配置」并列的独立设置面板)
//
// 这里配的是一条独立的图像端点:Base URL / API Key / 模型名 / 默认质量尺寸 / 参考图方言。
// 它与「AI 配置 → 我的提供商」彻底解耦 —— 对话用哪个文本模型都不影响生图走这里配的端点,
// 两者甚至可以是完全不同的两家平台。
//
// 生图有两条链路,面板下方据此向用户解释二者分工:
//  1) generate_image 工具(推荐)—— 对话模型仍是文本模型,由它在需要画图时调用本端点;
//  2) imageGen 生图对话 —— 所选模型本身就是纯图像端点模型,整轮旁路到 /images/*,
//     用的是该提供方自己的端点配置(在「AI 配置」里声明),不吃本页这份配置。
import React, { useEffect, useState } from 'react';
import GlassSelect from '../GlassSelect/GlassSelect';
import './ImageGenPanel.scss';

// 预设仅填充 Base URL / 模型名 / 方言(绝不含任何 Key),可自由改成任意 OpenAI 兼容图像网关
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

export default function ImageGenPanel() {
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
        // 尺寸/质量枚举与服务端(settings-store)与工具 schema 同源,避免前端再抄一份
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
    <div className="image-gen-panel">
      <div className="panel-title row">
        <span>生图配置</span>
        <span className={`muted sm ${configured ? 'ig-on' : 'ig-off'}`}>
          ({configured ? `已配置 · ${cfg.model || '?'}` : '未配置'})
        </span>
        <span className="grow" />
        <span className="muted sm">与对话模型互相独立</span>
      </div>
      <div className="hint ig-lead">
        AI 在对话中画图时实际打的图像接口(OpenAI 兼容)。改完点「保存配置」,下一轮对话即生效。
      </div>

      <div className="ig-body">
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
        <div className="ig-grid">
          <div className="field">
            <label>默认质量</label>
            <GlassSelect full value={cfg.quality} onChange={(v) => set('quality', v)}
              options={qualities.map((q) => ({ value: q, label: q }))} />
          </div>
          <div className="field">
            <label>默认尺寸</label>
            <GlassSelect full value={cfg.size} onChange={(v) => set('size', v)} options={sizeOpts} />
          </div>
        </div>
        <div className="field">
          <label>参考图字段方言(图生图)</label>
          <GlassSelect full value={cfg.dialect} onChange={(v) => set('dialect', v)} options={IMAGE_DIALECTS} />
        </div>
        {msg && <div className={`ig-msg ${msg.kind}`}>{msg.kind === 'ok' ? '✓ ' : '✕ '}{msg.text}</div>}
        <div className="row ig-actions">
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

      {/* ---- 两条生图链路的说明:用户最常问的是"我这样接对不对",放在表单下方备查 ---- */}
      <div className="panel-title ig-paths-title">两条生图链路</div>
      <div className="ig-paths">
        <div className="ig-path">
          <div className="ig-path-head">
            <span className="ig-path-tag">推荐</span>
            <span className="ig-path-name">对话式生图(generate_image 工具)</span>
          </div>
          <div className="ig-path-desc">
            对话仍用任意文本模型,由它在你要求画图时自动调用上面这份端点:文本模型手里有完整对话历史,
            能把"再亮一点""把帽子换蓝"补全成自包含提示词,并自行决定文生图/图生图与尺寸质量。
          </div>
        </div>
        <div className="ig-path">
          <div className="ig-path-head">
            <span className="ig-path-tag alt">进阶</span>
            <span className="ig-path-name">生图对话(模型本身就是图像端点)</span>
          </div>
          <div className="ig-path-desc">
            若所选模型只能走 /images/*(纯图像端点,chat/completions 会被网关拒绝),
            请到「AI 配置 → 编辑提供方」勾选该模型的「生图」开关:该对话整轮切为生图链路,
            端点用该提供方自身的 Base URL / Key / 模型名,不走上面这份配置。
          </div>
        </div>
      </div>
    </div>
  );
}
