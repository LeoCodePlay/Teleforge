// 目录浏览弹窗:用于选择远程工作区(输入框下方工作区栏 / 左侧文件管理都可复用)
import React, { useState } from 'react';
import { api } from '../../api';
import type { DirEntry } from '../../types';
import './dirbrowser.scss';

interface DirBrowserProps {
  initial?: string;
  home?: string | null;
  onClose: () => void;
  onPick: (path: string) => void;
}

export default function DirBrowser({ initial, home, onClose, onPick }: DirBrowserProps) {
  const [path, setPath] = useState(initial || home || '/');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loadingPath, setLoadingPath] = useState<string | null>(null); // 正在加载的目录, null 表示空闲
  const [error, setError] = useState('');

  const load = async (p: string) => {
    setLoadingPath(p); setError('');
    try {
      const r = await api.request('list_dir', { path: p }, 20000);
      setPath(p); setEntries(r.entries || []);
    } catch (e) { setError((e as Error).message); }
    finally { setLoadingPath(null); }
  };

  // 组件挂载时只加载一次;后续路径变化由父组件重新挂载(Router 内 key 控制)
  const mounted = React.useRef(false);
  React.useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    load(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const up = () => { if (path !== '/') load(path.slice(0, path.lastIndexOf('/')) || '/'); };

  const dir = (name: string) => (path === '/' ? '/' + name : path + '/' + name);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><span>选择远程工作区</span><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="row gap">
            <button className="ghost" onClick={up} disabled={path === '/'}>⬆ 上级</button>
            <input className="grow" value={path} onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') load(path); }} />
            <button onClick={() => load(path)} disabled={loadingPath !== null}>{loadingPath === path ? '…' : '跳转'}</button>
          </div>
          {home && <button className="link" onClick={() => load(home)}>📁 家目录 {home}</button>}
          {error && <div className="error">✕ {error}</div>}
          <div className="dirlist">
            {!loadingPath && entries.length === 0 && <div className="muted">(空目录)</div>}
            {entries.filter((e) => e.type === 'dir').map((e) => {
              const fp = dir(e.name);
              return (
                <div key={e.name} className="dirlink"
                  onMouseDown={(ev) => { if (ev.detail > 1) ev.preventDefault(); }}
                  onDoubleClick={() => load(fp)}>
                  <span>📁 {e.name}</span>
                  {loadingPath === fp && <span className="spinner-inline" />}
                </div>
              );
            })}
            {entries.filter((e) => e.type !== 'dir').slice(0, 50).map((e) => (
              <div key={e.name} className="dirlink muted2 disabled" onMouseDown={(ev) => { if (ev.detail > 1) ev.preventDefault(); }}>📄 {e.name}</div>
            ))}
            {loadingPath && (
              <div className="dirlist-loading"><span className="spinner" />加载中…</div>
            )}
          </div>
        </div>
        <div className="modal-foot"><button className="primary grow" onClick={() => onPick(path)}>以此目录为工作区</button></div>
      </div>
    </div>
  );
}