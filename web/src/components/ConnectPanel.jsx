import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

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

  // LLM 配置
  const [baseUrl, setBaseUrl] = useState(() => LS('llmBase', 'https://api.deepseek.com'));
  const [apiKey, setApiKey] = useState(() => LS('llmKey', ''));
  const [model, setModel] = useState(() => LS('llmModel', 'deepseek-chat'));
  const [llmSaved, setLlmSaved] = useState(false);

  const connected = status.status === 'connected';
  const connecting = status.status === 'connecting' || status.status === 'reconnecting';
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (llmSaved) {
      const t = setTimeout(() => setLlmSaved(false), 2000);
      return () => clearTimeout(t);
    }
  }, [llmSaved]);

  // 加载后自动回传 LLM 配置,便于重连后恢复
  useEffect(() => {
    api.send('llm', { llm: { baseUrl, apiKey, model } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, apiKey, baseUrl]);

  const saveLlm = () => {
    LSS('llmBase', baseUrl); LSS('llmKey', apiKey); LSS('llmModel', model);
    api.send('llm', { llm: { baseUrl, apiKey, model } });
    setLlmSaved(true);
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

      <div className="panel-title">AI 模型配置(mock 免 Key 联调)</div>
      <div className="field">
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Base URL,如 https://api.deepseek.com" />
      </div>
      <div className="field">
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API Key(仅存本机浏览器)" />
      </div>
      <div className="field">
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型名,如 deepseek-chat / gpt-4o / mock" />
      </div>
      <button className="grow" onClick={saveLlm}>{llmSaved ? '✓ 已保存' : '保存模型配置'}</button>
      <div className="hint">model 填 <code>mock</code> 可离线跑通完整 Agent 流程</div>
    </div>
  );
}