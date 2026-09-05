import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import CodeEditor from './CodeEditor';
import './FileViewer.scss';

function fmtSize(n: number | undefined) {
  if (n == null) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf';

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'];
const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'ogv', 'mov'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac'];

export const MEDIA_KIND_LABEL: Record<MediaKind, string> = {
  image: '图片', video: '视频', audio: '音频', pdf: 'PDF'
};

export function mediaKindOf(name: string): MediaKind | null {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  return null;
}

interface FileMeta {
  size: number;
  truncated: boolean;
  binary: boolean;
}

interface FileViewerProps {
  path: string;
  name: string;
  onDirtyChange?: (dirty: boolean) => void;
  onClose: () => void;
  /** 移动端「返回」按钮:回到文件管理视图(手机端打开文件时由 App 传入) */
  onBack?: () => void;
}

export default function FileViewer({ path, name, onDirtyChange, onClose, onBack }: FileViewerProps) {
  const [content, setContent] = useState('');
  const [orig, setOrig] = useState('');
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [mediaError, setMediaError] = useState('');

  const isLocal = path.startsWith('local:');
  const realPath = isLocal ? path.slice('local:'.length) : path;
  const media = mediaKindOf(name);

  // 媒体走 /api/media 字节流(按扩展名给 Content-Type,支持 Range);文本走 RPC 读内容
  const mediaUrl = useMemo(() => {
    if (!media) return '';
    const qs = new URLSearchParams({ path: realPath });
    if (isLocal) qs.set('local', '1');
    return `/api/media?${qs.toString()}`;
  }, [media, realPath, isLocal]);

  useEffect(() => {
    setLoading(true); setError(''); setContent(''); setOrig(''); setMeta(null); setSaved(false); setMediaError('');
    if (media) { setLoading(false); return; }
    (isLocal ? api.request('read_local_file', { path: realPath }, 20000)
             : api.request('read_file', { path }, 20000))
      .then((r) => {
        setMeta({ size: r.size, truncated: r.truncated, binary: r.binary });
        if (r.binary) { setError('二进制文件,无文本预览'); setContent(''); }
        else { setContent(r.content); setOrig(r.content); }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [path, media]);

  const dirty = content !== orig;
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    if (dirtyRef.current === dirty) return;
    dirtyRef.current = dirty;
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const save = async () => {
    setSaving(true); setError('');
    try {
      if (isLocal) await api.request('write_local_file', { path: realPath, content }, 30000);
      else await api.request('write_file', { path, content }, 30000);
      setOrig(content); setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  const onMediaError = () => setMediaError('媒体加载失败,文件可能不存在或编码不受支持');

  const downloadHref = media
    ? `${mediaUrl}&download=1`
    : (!isLocal ? `/api/download?path=${encodeURIComponent(path)}` : undefined);

  return (
    <div className="fviewer">
      <div className="fviewer-head">
        {onBack && <button className="ghost sm fviewer-back" onClick={onBack} title="返回文件管理">←</button>}
        <span className="fviewer-title" data-tip={path}>📄 {name} <span className="muted">{media
          ? MEDIA_KIND_LABEL[media]
          : meta && `${fmtSize(meta.size)}${meta.truncated ? ' (仅展示前部)' : ''}`}</span></span>
        <div className="fviewer-actions">
          {downloadHref && <a className="btn-link" href={downloadHref}>⬇ 下载</a>}
          {!media && dirty && <button className="primary sm" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存修改'}</button>}
          {!media && saved && <span className="okline">✓ 已保存</span>}
          <button className="ghost sm" onClick={onClose}>✕</button>
        </div>
      </div>
      <div className={`fviewer-body${media ? media === 'pdf' ? ' media pdf-mode' : ' media' : ''}`}>
        {media ? (
          <>
            {mediaError && <div className="error fviewer-msg">✕ {mediaError}</div>}
            {!mediaError && media === 'image' && <img src={mediaUrl} alt={name} onError={onMediaError} />}
            {!mediaError && media === 'video' && <video src={mediaUrl} controls autoPlay onError={onMediaError} />}
            {!mediaError && media === 'audio' && <audio src={mediaUrl} controls autoPlay onError={onMediaError} />}
            {!mediaError && media === 'pdf' && <iframe src={mediaUrl} title={name} onError={onMediaError} />}
          </>
        ) : (
          <>
            {loading && <div className="muted fviewer-msg">加载中…</div>}
            {error && <div className="error fviewer-msg">✕ {error}</div>}
            {!loading && !error && (
              <CodeEditor fileName={name} path={path} initial={content} onEdit={setContent} onSave={save} />
            )}
          </>
        )}
      </div>
      <div className="fviewer-foot muted sm">{media
        ? '媒体文件仅在线预览,不支持编辑;下载请用右上角按钮'
        : `保存后修改将直接写入${isLocal ? '本机' : '服务器'};路径越权由服务器校验`}</div>
    </div>
  );
}
