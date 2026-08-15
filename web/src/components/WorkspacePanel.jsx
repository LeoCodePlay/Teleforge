import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

function fmtSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
}

// 目录浏览弹窗:用于选择工作区
function DirBrowser({ initial, home, onClose, onPick }) {
  const [path, setPath] = useState(initial || home || '/');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (p) => {
    setLoading(true); setError('');
    try {
      const r = await api.request('list_dir', { path: p }, 20000);
      setPath(p); setEntries(r.entries || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(path); /* eslint-disable-line */ }, []);

  const up = () => { if (path !== '/') load(path.slice(0, path.lastIndexOf('/')) || '/'); };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><span>选择远程工作区</span><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="row gap">
            <button className="ghost" onClick={up} disabled={path === '/'}>⬆ 上级</button>
            <input className="grow" value={path} onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') load(path); }} />
            <button onClick={() => load(path)} disabled={loading}>{loading ? '…' : '跳转'}</button>
          </div>
          {home && <button className="link" onClick={() => load(home)}>📁 家目录 {home}</button>}
          {error && <div className="error">✕ {error}</div>}
          <div className="dirlist">
            {loading && <div className="muted">加载中…</div>}
            {!loading && entries.length === 0 && <div className="muted">(空目录)</div>}
            {entries.filter((e) => e.type === 'dir').map((e) => (
              <div key={e.name} className="dirlink"
                onClick={() => load(path === '/' ? '/' + e.name : path + '/' + e.name)}>📁 {e.name}</div>
            ))}
            {entries.filter((e) => e.type !== 'dir').slice(0, 50).map((e) => (
              <div key={e.name} className="dirlink muted2 disabled">📄 {e.name}</div>
            ))}
          </div>
        </div>
        <div className="modal-foot"><button className="primary grow" onClick={() => onPick(path)}>以此目录为工作区</button></div>
      </div>
    </div>
  );
}

// 工作区文件树(懒加载目录)
function FileTree({ root, onOpenFile }) {
  const [expanded, setExpanded] = useState(new Set());
  const [nodes, setNodes] = useState({}); // path -> {loaded, loading, entries} | null
  const [rootKey, setRootKey] = useState(root);
  const fetchSeq = useRef(0);

  const load = useCallback(async (p) => {
    setNodes((prev) => ({ ...prev, [p]: { loaded: false, loading: true, entries: [] } }));
    const seq = ++fetchSeq.current;
    try {
      const r = await api.request('list_dir', { path: p }, 20000);
      if (seq !== fetchSeq.current) return;
      setNodes((prev) => ({ ...prev, [p]: { loaded: true, loading: false, entries: r.entries || [] } }));
    } catch (e) {
      if (seq !== fetchSeq.current) return;
      setNodes((prev) => ({ ...prev, [p]: { loaded: true, loading: false, entries: [], error: e.message } }));
    }
  }, []);

  // 根目录变化时重置
  useEffect(() => {
    setExpanded(new Set());
    setNodes({});
    setRootKey(root);
    setExpanded((s) => new Set(s).add(root));
  }, [root]);

  useEffect(() => {
    if (expanded.has(root) && nodes[root] === undefined) load(root);
  }, [expanded, root, nodes, load]);

  const toggle = (p) => {
    const next = new Set(expanded);
    if (next.has(p)) next.delete(p);
    else { next.add(p); if (nodes[p] === undefined) load(p); }
    setExpanded(next);
  };

  const renderDir = (p, depth) => {
    const node = nodes[p];
    const rows = [];
    const dirs = (node?.entries || []).filter((c) => c.type === 'dir');
    const files = (node?.entries || []).filter((c) => c.type !== 'dir');
    for (const e of [...dirs, ...files]) {
      const cp = (p === '/' ? '' : p) + '/' + e.name;
      if (e.type === 'dir') {
        rows.push(
          <div key={cp} className="trow" style={{ paddingLeft: depth * 14 + 4 }}>
            <a className="tlink" onClick={() => toggle(cp)}>{expanded.has(cp) ? '📂' : '📁'} {e.name}</a>
          </div>
        );
        if (expanded.has(cp)) rows.push(
          <div key={cp + '-child'}>{renderDir(cp, depth + 1)}</div>
        );
      } else {
        rows.push(
          <div key={cp + e.name} className="trow" style={{ paddingLeft: depth * 14 + 4 }}>
            <a className="tlink" onClick={() => onOpenFile(cp)} title={`${cp} (${fmtSize(e.size)})`}>📄 {e.name}</a>
          </div>
        );
      }
    }
    if (node?.error) rows.push(<div key="err" className="muted sm" style={{ paddingLeft: depth * 14 + 4 }}>✕ {node.error}</div>);
    if (node?.loading) rows.push(<div key="ld" className="muted sm" style={{ paddingLeft: depth * 14 + 4 }}>加载中…</div>);
    return rows;
  };

  return (
    <div className="filetree">
      <div className="tree-title">
        <span className="clickable" onClick={() => toggle(root)}>🌳 {root}</span>
        <button className="ghost sm" title="刷新" onClick={() => setNodes((prev) => ({ ...prev, [root]: undefined }))}>↻</button>
      </div>
      {nodes[root]?.error && nodes[root]?.entries.length === 0 && <div className="muted sm">✕ {nodes[root].error}</div>}
      {renderDir(root, 0)}
      <div className="muted sm" style={{ paddingTop: 8 }}>点击目录展开 · 点击文件查看内容</div>
    </div>
  );
}

export default function WorkspacePanel({ connected, workspace, home, platform, onWorkspaceSet, onOpenFile }) {
  const [browserOpen, setBrowserOpen] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [lastSet, setLastSet] = useState('');

  const chooseWorkspace = async (p) => {
    try {
      await api.request('set_workspace', { path: p }, 20000);
      onWorkspaceSet(p); setBrowserOpen(false); setLastSet(p);
    } catch (e) { alert(e.message); }
  };

  return (
    <div className="panel">
      <div className="panel-title">远程工作区</div>
      {!connected ? (
        <div className="muted">连接服务器后即可选择工作区</div>
      ) : (
        <>
          <div className="row gap">
            <button className="primary grow" onClick={() => setBrowserOpen(true)}>浏览选择目录…</button>
            {home && <button className="ghost" title={`设为家目录 ${home}`} onClick={() => chooseWorkspace(home)}>🏠</button>}
          </div>
          <div className="row gap" style={{ marginTop: 6 }}>
            <input className="grow" value={manualPath} onChange={(e) => setManualPath(e.target.value)}
              placeholder="或直接输入远程目录路径"
              onKeyDown={(e) => { if (e.key === 'Enter' && manualPath.trim()) chooseWorkspace(manualPath.trim()); }} />
            <button disabled={!manualPath.trim()} onClick={() => chooseWorkspace(manualPath.trim())}>设为工作区</button>
          </div>
          {workspace && <div className="okline">当前工作区:📂 {workspace}</div>}
          <FileTree key={lastSet ? 'ws-' + lastSet : 'home'} root={workspace || home || '/'} onOpenFile={onOpenFile} />
        </>
      )}
      {browserOpen && (
        <DirBrowser initial={workspace || home || '/'} home={home} onClose={() => setBrowserOpen(false)} onPick={chooseWorkspace} />
      )}
    </div>
  );
}