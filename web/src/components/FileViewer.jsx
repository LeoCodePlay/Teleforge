import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

function fmtSize(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
}

export default function FileViewer({ path, name, onClose }) {
  const [content, setContent] = useState('');
  const [orig, setOrig] = useState('');
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLoading(true); setError(''); setContent(''); setOrig(''); setMeta(null); setSaved(false);
    api.request('read_file', { path }, 20000)
      .then((r) => {
        setMeta({ size: r.size, truncated: r.truncated, binary: r.binary });
        if (r.binary) { setError('二进制文件,无文本预览'); setContent(''); }
        else { setContent(r.content); setOrig(r.content); }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [path]);

  const dirty = content !== orig;
  const save = async () => {
    setSaving(true); setError('');
    try {
      await api.request('write_file', { path, content }, 30000);
      setOrig(content); setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal fviewer" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span title={path}>📄 {name} <span className="muted">{meta && `${fmtSize(meta.size)}${meta.truncated ? ' (仅展示前部)' : ''}`}</span></span>
          <div className="row gap">
            <a className="btn-link" href={`/api/download?path=${encodeURIComponent(path)}`} title="下载到本机">⬇ 下载</a>
            {dirty && <button className="primary sm" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存修改'}</button>}
            {saved && <span className="okline">✓ 已保存</span>}
            <button className="ghost" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="modal-body">
          {loading && <div className="muted">加载中…</div>}
          {error && <div className="error">✕ {error}</div>}
          {!loading && !error && (
            <textarea className="codeedit" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
          )}
        </div>
        <div className="modal-foot muted sm">保存后修改将直接写入服务器(仅工作区文件;路径越权由服务器校验)</div>
      </div>
    </div>
  );
}