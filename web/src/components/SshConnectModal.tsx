// SSH 连接弹窗(右上角入口):已保存服务器列表 + 添加/编辑服务器表单(可保存也可不保存)
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useFeedback } from '../feedback';
import type { ServerStatus } from '../types';

const LS = (k: string, v: string) => localStorage.getItem('sshai.' + k) || v;
const LSS = (k: string, v: string) => localStorage.setItem('sshai.' + k, v);

// ---- 已保存的 SSH 服务器配置(含密码/密钥,仅存本机) ----
interface SshProfile {
  id: string;
  name: string;
  host: string;
  port: string;
  username: string;
  authType: 'password' | 'key' | string;
  password: string;
  keyText: string;
  keyPath: string;
  passphrase: string;
  autoReconnect: boolean;
}

interface SshForm {
  name: string;
  host: string;
  port: string;
  user: string;
  authType: 'password' | 'key' | string;
  password: string;
  keyText: string;
  keyPath: string;
  passphrase: string;
  autoReconnect: boolean;
  save: boolean;
}

function loadProfiles(): SshProfile[] {
  try {
    const a = JSON.parse(localStorage.getItem('sshai.sshProfiles') || '[]');
    return Array.isArray(a) ? a.filter((p: SshProfile) => p && p.id && p.host) : [];
  } catch { return []; }
}
function saveProfiles(list: SshProfile[]) {
  localStorage.setItem('sshai.sshProfiles', JSON.stringify(list));
}

const emptyForm = (): SshForm => ({
  name: '', host: LS('host', ''), port: '22', user: LS('user', ''),
  authType: 'password', password: '', keyText: '', keyPath: '', passphrase: '',
  autoReconnect: true, save: true
});

interface SshConnectModalProps {
  status: ServerStatus;
  onClose: () => void;
}

export default function SshConnectModal({ status, onClose }: SshConnectModalProps) {
  const { confirm } = useFeedback();
  const [profiles, setProfiles] = useState<SshProfile[]>(loadProfiles);
  const [view, setView] = useState<'list' | 'form'>('list');
  const [form, setForm] = useState<SshForm>(emptyForm);
  const [editId, setEditId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const connected = status.status === 'connected';
  const connecting = status.status === 'connecting' || status.status === 'reconnecting';

  // 仅在弹窗打开期间"未连接 -> 已连接"时自动关闭(打开弹窗时已连接则保留,便于断开)
  const prevConnected = useRef(connected);
  useEffect(() => {
    if (connected && !prevConnected.current) onClose();
    prevConnected.current = connected;
  }, [connected, onClose]);

  const set = <K extends keyof SshForm>(k: K, v: SshForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  // 发起连接;成功时服务端会推送 status=connected,由上面的 effect 关闭弹窗
  const doConnect = async () => {
    setErr('');
    if (!form.host.trim() || !form.user.trim()) { setErr('请填写主机与用户名'); return; }
    if (form.authType === 'key' && !form.keyText.trim() && !form.keyPath.trim()) { setErr('请粘贴私钥内容或填写本机私钥文件路径'); return; }
    setBusy(true);
    try {
      let key = form.keyText.trim();
      if (!key && form.keyPath.trim()) {
        const r = await fetch('/api/readkey', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: form.keyPath.trim() })
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || '读取私钥失败');
        key = j.content;
      }
      const ssh = {
        host: form.host.trim(), port: form.port || '22', username: form.user.trim(),
        autoReconnect: form.autoReconnect,
        auth: form.authType === 'key'
          ? { type: 'privateKey', privateKey: key, passphrase: form.passphrase || undefined }
          : { type: 'password', password: form.password }
      };
      await api.request('connect', { ssh }, 30000);
      LSS('host', form.host.trim()); LSS('user', form.user.trim());
      if (form.save) {
        const id = editId || ('p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
        const entry: SshProfile = {
          id, name: form.name.trim() || `${form.user.trim()}@${form.host.trim()}`,
          host: form.host.trim(), port: form.port || '22', username: form.user.trim(),
          authType: form.authType, password: form.password, keyText: form.keyText,
          keyPath: form.keyPath, passphrase: form.passphrase, autoReconnect: form.autoReconnect
        };
        const next = editId ? profiles.map((p) => (p.id === editId ? entry : p)) : [...profiles, entry];
        setProfiles(next); saveProfiles(next);
      }
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const doDisconnect = () => { api.send('disconnect', {}); };

  // 从列表直接连接某个已保存服务器
  const connectProfile = async (p: SshProfile) => {
    setErr('');
    setBusy(true);
    try {
      const ssh = {
        host: p.host, port: p.port || '22', username: p.username,
        autoReconnect: p.autoReconnect !== false,
        auth: p.authType === 'key'
          ? { type: 'privateKey', privateKey: p.keyText, passphrase: p.passphrase || undefined }
          : { type: 'password', password: p.password }
      };
      await api.request('connect', { ssh }, 30000);
      LSS('host', p.host); LSS('user', p.username);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const openAdd = () => { setForm(emptyForm()); setEditId(''); setView('form'); };

  const openEdit = (p: SshProfile) => {
    setForm({
      name: p.name || '', host: p.host, port: p.port || '22', user: p.username || '',
      authType: p.authType || 'password', password: p.password || '',
      keyText: p.keyText || '', keyPath: p.keyPath || '', passphrase: p.passphrase || '',
      autoReconnect: p.autoReconnect !== false, save: true
    });
    setEditId(p.id);
    setView('form');
  };

  const deleteProfile = async (p: SshProfile) => {
    const ok = await confirm({
      title: '删除连接配置',
      message: `删除连接配置「${p.name || ''}」?(其中保存的密码/密钥会一并删除)`,
      confirmLabel: '删除',
      danger: true
    });
    if (!ok) return;
    const next = profiles.filter((x) => x.id !== p.id);
    setProfiles(next); saveProfiles(next);
  };

  const backToList = () => { setView('list'); setErr(''); };

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal ssh-modal">
        <div className="modal-head">
          <span>{view === 'list' ? 'SSH 连接' : (editId ? '编辑服务器' : '添加 SSH 服务器')}</span>
          <button className="ghost edge-toggle" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {view === 'list' ? (
            <>
              {connected && (
                <div className="ssh-cur">
                  <span className="dot">●</span>
                  <div className="grow">
                    <div className="ssh-cur-title">已连接</div>
                    <div className="ssh-cur-sub">{status.username}@{status.host}:{status.port}{status.platform ? ` (${status.platform})` : ''}</div>
                  </div>
                  <button className="danger sm" disabled={busy} onClick={doDisconnect}>断开</button>
                </div>
              )}
              {connecting && <div className="hint">正在连接…</div>}
              {err && <div className="error" onClick={() => setErr('')} title="点击关闭">✕ {err}</div>}

              <div className="field">
                <label>已保存的服务器(密码/密钥仅存本机)</label>
                {profiles.length === 0 ? (
                  <div className="ssh-empty">还没有已保存的服务器,点击下方按钮添加</div>
                ) : (
                  <div className="ssh-list">
                    {profiles.map((p) => (
                      <div key={p.id} className="ssh-item">
                        <button className="ssh-item-main" disabled={busy || connecting} onClick={() => connectProfile(p)}>
                          <span className="ssh-item-name">{p.name}</span>
                          <span className="ssh-item-sub">{p.username}@{p.host}:{p.port}</span>
                        </button>
                        <button className="sm" title="编辑" onClick={() => openEdit(p)}>✎</button>
                        <button className="sm" title="删除" onClick={() => deleteProfile(p)}>🗑</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <button className="ssh-add" onClick={openAdd}>
                <span>＋</span> 添加 SSH 服务器
              </button>
            </>
          ) : (
            <>
              <div className="field">
                <label>主机 / 端口 / 用户</label>
                <div className="row">
                  <input className="grow" value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="host" autoFocus />
                  <input className="w70" value={form.port} onChange={(e) => set('port', e.target.value)} placeholder="22" />
                  <input className="grow" value={form.user} onChange={(e) => set('user', e.target.value)} placeholder="user" />
                </div>
              </div>

              <div className="seg">
                <button className={form.authType === 'password' ? 'on' : ''} onClick={() => set('authType', 'password')}>密码</button>
                <button className={form.authType === 'key' ? 'on' : ''} onClick={() => set('authType', 'key')}>私钥</button>
              </div>

              {form.authType === 'password' ? (
                <div className="field">
                  <input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder="密码" />
                </div>
              ) : (
                <>
                  <div className="field">
                    <textarea rows={3} value={form.keyText} onChange={(e) => set('keyText', e.target.value)} placeholder="粘贴 PEM 私钥内容(可留空,用下方路径读取)" spellCheck={false} />
                  </div>
                  <div className="field">
                    <input value={form.keyPath} onChange={(e) => set('keyPath', e.target.value)} placeholder="或本机私钥文件路径,如 C:\\Users\\x\\.ssh\\id_rsa" />
                  </div>
                  <div className="field">
                    <input type="password" value={form.passphrase} onChange={(e) => set('passphrase', e.target.value)} placeholder="密钥口令(可选)" />
                  </div>
                </>
              )}

              <label className="check"><input type="checkbox" checked={form.autoReconnect} onChange={(e) => set('autoReconnect', e.target.checked)} /> 断线自动重连(保活)</label>

              <div className="field ssh-save-box">
                <label>保存选项</label>
                <div className="row">
                  <input className="grow" value={form.name} disabled={!form.save} onChange={(e) => set('name', e.target.value)} placeholder="配置名称(默认 user@host)" />
                  <label className="check ssh-save-check">
                    <input type="checkbox" checked={form.save} onChange={(e) => set('save', e.target.checked)} />
                    保存到本机
                  </label>
                </div>
                <div className="hint">{form.save ? '连接成功后保存到本机,下次可直接从列表选择连接' : '连接后不保存该服务器,下次需重新填写'}</div>
              </div>

              {err && <div className="error" onClick={() => setErr('')} title="点击关闭">✕ {err}</div>}

              <div className="row gap">
                <button className="ghost" disabled={busy} onClick={backToList}>← 返回</button>
                <button className="primary grow" disabled={busy || connecting} onClick={doConnect}>
                  {busy ? '连接中…' : (editId ? '保存并连接' : '连接')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}