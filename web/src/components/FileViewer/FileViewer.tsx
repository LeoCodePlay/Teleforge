import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import './FileViewer.scss';

function fmtSize(n: number | undefined) {
  if (n == null) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
}

interface FileMeta {
  size: number;
  truncated: boolean;
  binary: boolean;
}

interface FileViewerProps {
  path: string;
  name: string;
  onClose: () => void;
}

export default function FileViewer({ path, name, onClose }: FileViewerProps) {
  const [content, setContent] = useState('');
  const [orig, setOrig] = useState('');
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLoading(true); setError(''); setContent(''); setOrig(''); setMeta(null); setSaved(false);
    const isLocal = path.startsWith('local:');
    const realPath = isLocal ? path.slice('local:'.length) : path;
    (isLocal ? api.request('read_local_file', { path: realPath }, 20000)
             : api.request('read_file', { path }, 20000))
      .then((r) => {
        setMeta({ size: r.size, truncated: r.truncated, binary: r.binary });
        if (r.binary) { setError('二进制文件,无文本预览'); setContent(''); }
        else { setContent(r.content); setOrig(r.content); }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [path]);

  const dirty = content !== orig;
  const isLocal = path.startsWith('local:');
  const realPath = isLocal ? path.slice('local:'.length) : path;
  const save = async () => {
    setSaving(true); setError('');
    try {
      if (isLocal) await api.request('write_local_file', { path: realPath, content }, 30000);
      else await api.request('write_file', { path, content }, 30000);
      setOrig(content); setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal fviewer" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span data-tip={path}>📄 {name} <span className="muted">{meta && `${fmtSize(meta.size)}${meta.truncated ? ' (仅展示前部)' : ''}`}</span></span>
          <div className="row gap">
            {!isLocal && <a className="btn-link" href={`/api/download?path=${encodeURIComponent(path)}`}>⬇ 下载</a>}
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