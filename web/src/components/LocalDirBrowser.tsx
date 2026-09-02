// 本地目录浏览弹窗:用于选择本地工作区
// 数据源走 list_local_dir;支持"我的电脑"根视图(root: → Windows 盘符 / POSIX 根),
// 可从家目录起步,导航到任意本地目录(此电脑所有盘符/文件夹)
import React, { useState } from 'react';
import { api } from '../api';
import type { DirEntry } from '../types';

const ROOT = 'root:';

interface LocalDirBrowserProps {
  initial?: string;
  home?: string | null;
  onClose: () => void;
  onPick: (path: string) => void;
}

export default function LocalDirBrowser({ initial, home, onClose, onPick }: LocalDirBrowserProps) {
  // Windows 盘符根保留尾斜杠(F: → F:\),与 LocalFileManager 的 norm 一致
  const normDrive = (p: string | null | undefined) => {
    const s = String(p || '').replace(/[\\/]+$/, '');
    if (!s) return ROOT;
    return /^[A-Za-z]:$/.test(s) ? s + '\\' : s;
  };

  const [path, setPath] = useState<string>(() => normDrive(initial || home || ''));
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async (p: string) => {
    const target = normDrive(p);
    setLoadingPath(p); setError('');
    try {
      const r = await api.request('list_local_dir', { path: target }, 20000);
      setPath(target); setEntries(r.entries || []);
    } catch (e) { setError((e as Error).message); }
    finally { setLoadingPath(null); }
  };

  const mounted = React.useRef(false);
  React.useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    load(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 上级目录:盘符根(C:) → 我的电脑;我的电脑无上级;其余取最后一段分隔符之前
  const upDir = (p: string): string => {
    if (!p || p === ROOT) return ROOT;
    const t = String(p).replace(/[\\/]+$/, '');
    if (/^[A-Za-z]:$/.test(t)) return ROOT;
    const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
    return i <= 0 ? ROOT : t.slice(0, i);
  };
  const isRoot = path === ROOT;
  const up = () => { if (!isRoot) load(upDir(path)); };
  // 子项路径:根视图下盘符名(C:\)直接作为完整路径;其余按分隔符拼接
  const dir = (name: string) =>
    isRoot ? name : (path.endsWith('\\') || path.endsWith('/')) ? path + name : path + (path.includes('\\') ? '\\' : '/') + name;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><span>选择本地工作区</span><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="row gap">
            <button className="ghost" onClick={up} disabled={isRoot}>⬆ 上级</button>
            <input className="grow" value={path} onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') load(path); }} />
            <button onClick={() => load(path)} disabled={loadingPath !== null}>{loadingPath === path ? '…' : '跳转'}</button>
          </div>
          <div className="row gap" style={{ marginTop: 6 }}>
            <button className="link" onClick={() => load(ROOT)}>💻 我的电脑</button>
            {home && <button className="link" onClick={() => load(home)}>🏠 家目录 {home}</button>}
            {isRoot && <span className="muted sm">请选择一个磁盘/文件夹</span>}
          </div>
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
              <div key={e.name} className="dirlink muted2 disabled">📄 {e.name}</div>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <button className="primary grow" disabled={isRoot} title={isRoot ? '请先进入一个磁盘或文件夹' : ''} onClick={() => onPick(path)}>以此目录为本地工作区</button>
        </div>
      </div>
    </div>
  );
}
