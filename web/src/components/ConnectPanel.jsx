import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { PROVIDERS, DEFAULT_PROVIDER } from '../llm-providers.js';

const LS = (k, v) => localStorage.getItem('sshai.' + k) || v;
const LSS = (k, v) => localStorage.setItem('sshai.' + k, v);

// ---- 用户添加的提供商:整体存 localStorage(含 API Key,随条目删除) ----
function loadUserProviders() {
  try {
    const arr = JSON.parse(localStorage.getItem('sshai.userProviders') || '[]');
    return Array.isArray(arr) ? arr.filter((p) => p && p.id && p.baseUrl) : [];
  } catch { return []; }
}
function saveUserProviders(list) {
  localStorage.setItem('sshai.userProviders', JSON.stringify(list));
}

export default function ConnectPanel({ status }) {
  const [host, setHost] = useState(() => LS('host', ''));
  const [port, setPort] = useState('22');
  const [user, setUser] = useState(() => LS('user', ''));
  const [authType, setAuthType] = useState('password'); // password | key
  const [password, setPassword] = useState('');
  const [keyText, setKeyText] = useState('');
  const [keyPath, setKeyPath] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [autoReconnect, setAutoReconnect] = useState(true);

  // ---- LLM 配置:用户条目 + 预置条目 ----
  const [userProviders, setUserProviders] = useState(loadUserProviders);
  const allProviders = [...userProviders, ...PROVIDERS];
  const [providerId, setProviderId] = useState(() => {
    const saved = LS('llm.provider', '');
    const known = [...loadUserProviders(), ...PROVIDERS].some((p) => p.id === saved);
    return known ? saved : DEFAULT_PROVIDER;
  });
  const provider = allProviders.find((p) => p.id === providerId) || allProviders[0];
  const isUser = userProviders.some((p) => p.id === providerId);
  const isMock = providerId === 'mock';
  const [model, setModel] = useState(() => LS('llm.model.' + providerId, ''));
  const [customModel, setCustomModel] = useState(() => LS('llm.customModel', ''));
  const [apiKey, setApiKey] = useState(() => {
    const p = allProviders.find((x) => x.id === providerId);
    if (p?.apiKey) return p.apiKey;
    return LS('llm.key.' + providerId, '') || (providerId === DEFAULT_PROVIDER ? LS('llmKey', '') : '');
  });
  const [addOpen, setAddOpen] = useState(false);

  const connected = status.status === 'connected';
  const connecting = status.status === 'connecting' || status.status === 'reconnecting';
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // ---- 生效配置 ----
  const effModel = isMock ? 'mock'
    : provider.models.length === 0 ? model
      : model === '__custom__' ? customModel
        : (model || provider.models[0] || '');
  const effBaseUrl = provider.baseUrl;
  const effKey = isMock ? '' : apiKey;

  // 切换提供商:恢复该条目的 Key 与上次使用的模型
  const switchProvider = (pid) => {
    const p = allProviders.find((x) => x.id === pid);
    setProviderId(pid);
    setApiKey(p?.apiKey || LS('llm.key.' + pid, ''));
    const saved = LS('llm.model.' + pid, '');
    setModel(saved || p?.models?.[0] || '');
  };

  // 写回用户条目的 Key(Key 随条目保存,删除条目即一并删除)
  const updateUserKey = (pid, key) => {
    setUserProviders((prev) => {
      const next = prev.map((p) => (p.id === pid ? { ...p, apiKey: key } : p));
      saveUserProviders(next);
      return next;
    });
  };

  // 应用 + 持久化(切换/修改即生效)
  useEffect(() => {
    api.send('llm', { llm: { baseUrl: effBaseUrl, apiKey: effKey, model: effModel } });
    LSS('llm.provider', providerId);
    LSS('llm.customModel', customModel);
    if (isMock) localStorage.removeItem('sshai.llm.model.' + providerId);
    else {
      LSS('llm.model.' + providerId, model);
      if (isUser) updateUserKey(providerId, apiKey);
      else LSS('llm.key.' + providerId, apiKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effBaseUrl, effKey, effModel, providerId, apiKey, model, customModel]);

  // ---- 添加 / 删除用户提供商 ----
  const addProvider = ({ name, baseUrl, models, apiKey }) => {
    const id = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const entry = { id, name, baseUrl: baseUrl.trim(), models, apiKey, note: '由用户添加' };
    const next = [...userProviders, entry];
    setUserProviders(next);
    saveUserProviders(next);
    setProviderId(id);
    setApiKey(apiKey);
    setModel(models[0] || '');
    setAddOpen(false);
  };

  const removeProvider = (id) => {
    if (!confirm(`删除提供商「${provider.name}」?其 API Key 也会一并删除`)) return;
    const next = userProviders.filter((p) => p.id !== id);
    setUserProviders(next);
    saveUserProviders(next);
    localStorage.removeItem('sshai.llm.model.' + id);
    localStorage.removeItem('sshai.llm.key.' + id);
    if (providerId === id) switchProvider(DEFAULT_PROVIDER);
  };

  const doConnect = async () => {
    setErr('');
    setBusy(true);
    try {
      if (authType === 'key') {
        let key = keyText.trim();
        if (!key && keyPath.trim()) {
          const r = await fetch('/api/readkey', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: keyPath.trim() })
          });
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || '读取私钥失败');
          key = j.content;
        }
        if (!key) throw new Error('请粘贴私钥内容或填写本机私钥文件路径');
        await api.request('connect', { ssh: { host, port, username: user, autoReconnect, auth: { type: 'privateKey', privateKey: key, passphrase: passphrase || undefined } } }, 30000);
        LSS('host', host); LSS('user', user);
      } else {
        await api.request('connect', { ssh: { host, port, username: user, autoReconnect, auth: { type: 'password', password } } }, 30000);
        LSS('host', host); LSS('user', user);
      }
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const doDisconnect = () => { api.send('disconnect', {}); };

  const clearErr = () => setErr('');
  useEffect(() => { if (status.status === 'connected') setErr(''); }, [status.status]);

  return (
    <div className="panel">
      <div className="panel-title">SSH 连接</div>

      <div className="field">
        <label>主机 / 端口 / 用户</label>
        <div className="row">
          <input className="grow" value={host} onChange={(e) => setHost(e.target.value)} placeholder="host" />
          <input className="w70" value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" />
          <input className="grow" value={user} onChange={(e) => setUser(e.target.value)} placeholder="user" />
        </div>
      </div>

      <div className="seg">
        <button className={authType === 'password' ? 'on' : ''} onClick={() => setAuthType('password')}>密码</button>
        <button className={authType === 'key' ? 'on' : ''} onClick={() => setAuthType('key')}>私钥</button>
      </div>

      {authType === 'password' ? (
        <div className="field">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="密码" />
        </div>
      ) : (
        <>
          <div className="field">
            <textarea rows={4} value={keyText} onChange={(e) => setKeyText(e.target.value)} placeholder="粘贴 PEM 私钥内容(可留空,用下方路径读取)" spellCheck={false} />
          </div>
          <div className="field">
            <div className="row">
              <input className="grow" value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="或本机私钥文件路径,如 C:\\Users\\x\\.ssh\\id_rsa" />
            </div>
          </div>
          <div className="field">
            <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="密钥口令(可选)" />
          </div>
        </>
      )}

      <label className="check"><input type="checkbox" checked={autoReconnect} onChange={(e) => setAutoReconnect(e.target.checked)} /> 断线自动重连(保活)</label>

      {err && <div className="error" onClick={clearErr} title="点击关闭">✕ {err}</div>}

      <div className="row gap">
        {!connected ? (
          <button className="primary grow" disabled={connecting || busy} onClick={doConnect}>
            {busy ? '连接中…' : '连接'}
          </button>
        ) : (
          <button className="danger grow" onClick={doDisconnect}>断开</button>
        )}
      </div>
      {connected && (
        <div className="okline">
          ✓ 已连接 {status.username}@{status.host}:{status.port} {status.platform && `(${status.platform})`}
        </div>
      )}

      <hr />

      <div className="panel-title">AI 模型 · 提供商</div>
      <div className="row gap">
        <select className="grow" value={providerId} onChange={(e) => switchProvider(e.target.value)}>
          {userProviders.length > 0 && (
            <optgroup label="我的提供商">
              {userProviders.map((p) => <option key={p.id} value={p.id}>★ {p.name}</option>)}
            </optgroup>
          )}
          <optgroup label="预置提供商">
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </optgroup>
        </select>
        <button title="添加自定义提供商" onClick={() => setAddOpen(true)}>＋</button>
        {isUser && <button className="danger sm" title="删除该提供商" onClick={() => removeProvider(providerId)}>🗑</button>}
      </div>

      {isMock ? (
        <div className="hint">mock 联调模式,无需 API Key</div>
      ) : provider.models.length > 0 ? (
        <>
          <div className="field">
            <select
              value={provider.models.includes(effModel) ? effModel : '__custom__'}
              onChange={(e) => setModel(e.target.value)}
            >
              {provider.models.map((m) => <option key={m} value={m}>{m}</option>)}
              <option value="__custom__">自定义模型…</option>
            </select>
          </div>
          {model === '__custom__' && (
            <div className="field">
              <input value={customModel} onChange={(e) => setCustomModel(e.target.value)} placeholder="输入该提供商的自定义模型名" />
            </div>
          )}
        </>
      ) : (
        <div className="field">
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型名(该提供商需手动输入)" />
        </div>
      )}

      {!isMock && (
        <div className="field">
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API Key(仅存本机,按提供商分别保存)" />
        </div>
      )}

      {provider.note && <div className="hint">💡 {provider.note}</div>}
      <div className="hint">当前生效: <code>{isMock ? 'mock' : effModel || '—'}</code> @ <code>{effBaseUrl || '未设置'}</code></div>
      <div className="hint">切换即时生效;点「＋」可添加自己的提供商(名称/地址/模型/Key 一并保存)</div>

      {addOpen && (
        <AddProviderModal
          onClose={() => setAddOpen(false)}
          onSave={addProvider}
        />
      )}
    </div>
  );
}

// ---- 添加自定义提供商弹窗 ----
function AddProviderModal({ onClose, onSave }) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [modelsText, setModelsText] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');

  const submit = () => {
    const b = baseUrl.trim();
    if (!name.trim()) return setError('请填写提供商名称(如 公司内部网关)');
    if (!b) return setError('请填写 Base URL');
    if (!/^https?:\/\//i.test(b)) return setError('Base URL 需以 http:// 或 https:// 开头');
    const models = modelsText.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
    onSave({ name: name.trim(), baseUrl: b, models, apiKey });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><span>添加自定义提供商</span><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="field">
            <label>名称(显示在下拉列表中)</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 公司内部网关 / my-proxy" autoFocus />
          </div>
          <div className="field">
            <label>Base URL(OpenAI 兼容端点)</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-gateway/v1" />
          </div>
          <div className="field">
            <label>模型清单(可选,逗号分隔;留空则手动输入模型名)</label>
            <input value={modelsText} onChange={(e) => setModelsText(e.target.value)} placeholder="如 my-model-1, my-model-2" />
          </div>
          <div className="field">
            <label>API Key(可选,随本条目保存)</label>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
          </div>
          {error && <div className="error">✕ {error}</div>}
        </div>
        <div className="modal-foot row gap">
          <button className="grow" onClick={onClose}>取消</button>
          <button className="primary grow" onClick={submit}>保存并切换</button>
        </div>
      </div>
    </div>
  );
}