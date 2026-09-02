// SSH 连接弹窗(右上角入口):
// - 「保持中的连接」:多台服务器同时在线,一键切换(不重新连接)
// - 「已保存的服务器」:配置存于后端(server/data/ssh-profiles.json),切换浏览器/刷新共享
// - 添加/编辑服务器表单(可保存也可不保存)
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useFeedback } from '../feedback';
import type { ConnInfo, ServerStatus, SshProfileInfo } from '../types';

const LS = (k: string, v: string) => localStorage.getItem('sshai.' + k) || v;
const LSS = (k: string, v: string) => localStorage.setItem('sshai.' + k, v);

const CONN_LABEL: Record<string, string> = {
  connected: '已连接', connecting: '连接中…', reconnecting: '重连中', disconnected: '未连接'
};

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
  const [profiles, setProfiles] = useState<SshProfileInfo[]>([]);
  const [view, setView] = useState<'list' | 'form'>('list');
  const [form, setForm] = useState<SshForm>(emptyForm);
  const [editId, setEditId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const conns = status.conns || [];
  const activeConn = status.activeConn ?? null;
  const connected = status.status === 'connected';
  const connecting = status.status === 'connecting' || status.status === 'reconnecting';

  // 从后端拉取已保存的服务器(跨浏览器/刷新共享)
  const refreshProfiles = useCallback(() => {
    api.request('ssh_profiles_list', {}, 8000)
      .then((m) => setProfiles(m.profiles || []))
      .catch(() => {});
  }, []);
  useEffect(() => { refreshProfiles(); }, [refreshProfiles]);

  // 仅在弹窗打开期间「未连接 -> 已连接」时自动关闭(打开时已连接则保留,便于断开/切换)
  const prevConnected = useRef(connected);
  useEffect(() => {
    if (connected && !prevConnected.current) onClose();
    prevConnected.current = connected;
  }, [connected, onClose]);

  const set = <K extends keyof SshForm>(k: K, v: SshForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  // 连接(或快速切换)已保存的服务器:服务端若已有存活连接则秒切,否则建立新连接,其他连接保持不断
  const connectProfile = async (p: SshProfileInfo) => {
    setErr('');
    setBusy(true);
    try {
      await api.request('connect', { profileId: p.id }, 30000);
      LSS('host', p.host); LSS('user', p.username);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  // 快速切换活动连接(不做任何网络动作)
  const switchConn = async (c: ConnInfo) => {
    setErr('');
    setBusy(true);
    try { await api.request('conn_switch', { id: c.id }, 8000); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const disconnectConn = async (c?: ConnInfo) => {
    setErr('');
    setBusy(true);
    try { await api.request('conn_disconnect', c ? { id: c.id } : {}, 8000); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  // 反查某连接对应的已保存配置(用于在「保持中的连接」里显示保存名称;按配置 id 或 host/port/user 匹配)
  const profileForConn = (c: ConnInfo) =>
    profiles.find((p) => (p.id === c.profileId)
      || (c.host === p.host && String(c.port) === String(p.port || '22') && c.username === p.username)) || null;

  // 手动表单:连接(可同时保存到后端)
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
        await api.request('ssh_profile_save', {
          profile: {
            id, name: form.name.trim() || `${form.user.trim()}@${form.host.trim()}`,
            host: form.host.trim(), port: form.port || '22', username: form.user.trim(),
            authType: form.authType, password: form.password, keyText: form.keyText,
            keyPath: form.keyPath, passphrase: form.passphrase, autoReconnect: form.autoReconnect
          }
        }, 8000);
        refreshProfiles();
      }
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const openAdd = () => { setForm(emptyForm()); setEditId(''); setView('form'); };

  const openEdit = (p: SshProfileInfo) => {
    setForm({
      name: p.name || '', host: p.host, port: p.port || '22', user: p.username || '',
      authType: p.authType || 'password', password: '', // 编辑时密码/密钥不回显(存于后端),留空 = 保持原值
      keyText: '', keyPath: p.keyPath || '', passphrase: '',
      autoReconnect: p.autoReconnect !== false, save: true
    });
    setEditId(p.id);
    setView('form');
  };

  const deleteProfile = async (p: SshProfileInfo) => {
    const ok = await confirm({
      title: '删除连接配置',
      message: `删除连接配置「${p.name || ''}」?(其中保存的密码/密钥会一并删除;已在线的连接不受影响)`,
      confirmLabel: '删除',
      danger: true
    });
    if (!ok) return;
    setBusy(true);
    try { await api.request('ssh_profile_delete', { id: p.id }, 8000); refreshProfiles(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
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
              {(connected || connecting) && (
                <div className="ssh-cur">
                  <span className="dot">●</span>
                  <div className="grow">
                    <div className="ssh-cur-title">{connected ? '当前连接' : CONN_LABEL[status.status]}</div>
                    <div className="ssh-cur-sub">{status.username}@{status.host}:{status.port}{status.platform ? ` (${status.platform})` : ''}</div>
                  </div>
                  <button className="danger sm" disabled={busy} onClick={() => disconnectConn()}>断开</button>
                </div>
              )}
              {!connected && !connecting && (
                <div className="ssh-cur off">
                  <span className="dot">●</span>
                  <div className="grow">
                    <div className="ssh-cur-title off">未连接</div>
                    <div className="ssh-cur-sub">连接后可保持多台服务器同时在线,随时快速切换</div>
                  </div>
                </div>
              )}
              {err && <div className="error" onClick={() => setErr('')} title="点击关闭">✕ {err}</div>}

              {conns.length > 0 && (
                <div className="field">
                  <label>保持中的连接 {conns.length} 个 · 点「切换」秒切,不重新连接;切换不中断正在进行的对话(会话列表里可看到后台运行)</label>
                  <div className="ssh-list">
                    {conns.map((c) => {
                      const isActive = c.id === activeConn;
                      const prof = profileForConn(c); // 已保存的名称(未保存则直接显示 host 信息)
                      return (
                        <div key={c.id} className="ssh-item">
                          <button
                            className="ssh-item-main"
                            disabled={busy}
                            onClick={() => { if (!isActive && c.status !== 'disconnected') switchConn(c); }}
                            title={isActive ? '当前操作连接' : (c.status === 'connected' ? '点击切换到该服务器(不重连)' : '未连接')}
                          >
                            <span className="ssh-item-name">{prof ? prof.name : `${c.username}@${c.host}:${c.port}`}</span>
                            <span className="ssh-item-sub">
                              {prof ? `${c.username}@${c.host}:${c.port} ` : ''}
                              [{CONN_LABEL[c.status] || c.status}{c.status === 'reconnecting' && c.retry ? `第${c.retry}次` : ''}{c.status === 'reconnecting' && c.reason ? ` · ${c.reason}` : ''}]
                              {c.workspace ? ` 工作区:${c.workspace}` : ''}
                            </span>
                          </button>
                          {!isActive && c.status === 'connected' && (
                            <button className="sm ok" title="快速切换(不重连)" disabled={busy} onClick={() => switchConn(c)}>切换</button>
                          )}
                          <button className="sm danger" title="断开此连接" disabled={busy} onClick={() => disconnectConn(c)}>断开</button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="field">
                <label>已保存的服务器(存于后端,跨浏览器共享)</label>
                {profiles.length === 0 ? (
                  <div className="ssh-empty">还没有已保存的服务器,点击下方按钮添加</div>
                ) : (
                  <div className="ssh-list">
                    {profiles.map((p) => (
                      <div key={p.id} className="ssh-item">
                        <button className="ssh-item-main" disabled={busy || connecting} onClick={() => connectProfile(p)}>
                          <span className="ssh-item-name">{p.name}</span>
                          <span className="ssh-item-sub">{p.username}@{p.host}:{p.port}{p.authType === 'key' ? ' · 私钥' : ''}{p.hasPassword ? '' : p.authType === 'password' ? ' · 未存密码' : ''}</span>
                        </button>
                        <button className="sm" title="编辑" disabled={busy} onClick={() => openEdit(p)}>✎</button>
                        <button className="sm" title="删除" disabled={busy} onClick={() => deleteProfile(p)}>🗑</button>
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
                  <input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder={editId ? (form.password ? '密码(留空保持原值)' : '新密码(留空保持原值)') : '密码'} />
                </div>
              ) : (
                <>
                  <div className="field">
                    <textarea rows={3} value={form.keyText} onChange={(e) => set('keyText', e.target.value)} placeholder={editId ? '粘贴新 PEM 私钥内容(留空保持原值)' : '粘贴 PEM 私钥内容(可留空,用下方路径读取)'} spellCheck={false} />
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
                    保存到服务器
                  </label>
                </div>
                <div className="hint">{form.save ? '保存到后端,换浏览器 / 刷新页面都可用;密码密钥只存服务端' : '连接后不保存该服务器,下次需重新填写'}</div>
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