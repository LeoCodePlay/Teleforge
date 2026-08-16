import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { PROVIDERS, getProvider, DEFAULT_PROVIDER } from '../llm-providers.js';

const LS = (k, v) => localStorage.getItem('sshai.' + k) || v;
const LSS = (k, v) => localStorage.setItem('sshai.' + k, v);

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

  // ---- LLM 配置:提供商 + 模型 + 分提供商 Key ----
  const [providerId, setProviderId] = useState(() => LS('llm.provider', DEFAULT_PROVIDER));
  const provider = getProvider(providerId);
  const [model, setModel] = useState(() => LS('llm.model.' + providerId, ''));
  const [customModel, setCustomModel] = useState(() => LS('llm.customModel', ''));
  const [customBase, setCustomBase] = useState(() => LS('llm.customBase', ''));
  // 兼容旧版本单 Key 存储:旧 Key 迁移到 deepseek 名下
  const [apiKey, setApiKey] = useState(() => LS('llm.key.' + providerId, '') || (providerId === DEFAULT_PROVIDER ? LS('llmKey', '') : ''));

  const connected = status.status === 'connected';
  const connecting = status.status === 'connecting' || status.status === 'reconnecting';
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // 生效的配置
  const isMock = providerId === 'mock';
  const isCustom = providerId === 'custom';
  const effModel = isMock ? 'mock'
    : isCustom ? customModel
      : provider.models.length === 0 ? model
        : model === '__custom__' ? customModel
          : (model || provider.models[0] || '');
  const effBaseUrl = isCustom ? customBase : provider.baseUrl;
  const effKey = isMock ? '' : apiKey;

  const switchProvider = (pid) => {
    setProviderId(pid);
    setApiKey(LS('llm.key.' + pid, ''));
    const saved = LS('llm.model.' + pid, '');
    const p = getProvider(pid);
    setModel(saved || p.models[0] || '');
  };

  // 切换/修改即生效:自动应用 + 持久化(Key 按提供商分别保存)
  useEffect(() => {
    api.send('llm', { llm: { baseUrl: effBaseUrl, apiKey: effKey, model: effModel } });
    LSS('llm.provider', providerId);
    LSS('llm.customBase', customBase);
    LSS('llm.customModel', customModel);
    if (isMock) { localStorage.removeItem('sshai.llm.model.' + providerId); }
    else {
      LSS('llm.model.' + providerId, model);
      LSS('llm.key.' + providerId, apiKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effBaseUrl, effKey, effModel, providerId, apiKey, customBase, customModel, model]);

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
      <div className="field">
        <select value={providerId} onChange={(e) => switchProvider(e.target.value)}>
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {isCustom ? (
        <>
          <div className="field">
            <input value={customBase} onChange={(e) => setCustomBase(e.target.value)} placeholder="Base URL,如 https://your-gateway/v1" />
          </div>
          <div className="field">
            <input value={customModel} onChange={(e) => setCustomModel(e.target.value)} placeholder="模型名,如 my-model" />
          </div>
        </>
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
      <div className="hint">切换提供商/模型即时生效,API Key 按提供商分开记忆</div>
    </div>
  );
}