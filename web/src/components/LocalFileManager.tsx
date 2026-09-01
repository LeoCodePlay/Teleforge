import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useFeedback } from '../feedback';
import type { DirEntry } from '../types';

function fmtSize(n: number | undefined | null) {
  if (n == null) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
}
function fmtTime(ms: number | undefined) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}
// 本地路径分隔符可能是 \ (Windows) 或 / (POSIX):规范化/取上级统一按「任一分隔符」处理
const norm = (p: string | null | undefined) => { const s = String(p || '').replace(/[\\/]+$/, ''); return s || '/'; };
const baseName = (p: string) => (p || '').split(/[\\/]/).filter(Boolean).pop() || 'item';
const upDir = (p: string) => {
  const t = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
  return i <= 0 ? t : t.slice(0, i);
};
const sepOf = (p: string) => (String(p || '').includes('\\') ? '\\' : '/');

// 本地删除可能很慢(尤其递归删大目录),放宽请求超时
const DELETE_TIMEOUT = 600000;

interface LocalFileManagerProps {
  workspace?: string | null;
  home?: string | null;
  remoteCwd?: string;                // 远程面板当前目录(传到远程的目标)
  onCwdChange?: (p: string) => void; // 当前目录变化时上报
  onOpenLocalFile: (path: string) => void;
}

interface CtxMenu {
  x: number;
  y: number;
  item: DirEntry | null;
}
interface Clipboard {
  items: string[];
  op: string;
}
interface DeletingInfo {
  index: number;
  total: number;
  name: string;
  done: number;
  current: string;
}
interface WriteState {
  done: number;
  total: number;
}

// 本地文件管理器:导航式浏览本地目录
// 选中:单击单选 · Ctrl/Cmd+单击 多选切换 · Shift+单击 连选 · Ctrl+A 全选 · Delete 删除
// 操作:双击打开/进入 · 右键对选区执行 打开/复制/删除/粘贴 · 「传到远程」把选区发往远程当前目录
export default function LocalFileManager({ workspace, home, remoteCwd, onCwdChange, onOpenLocalFile }: LocalFileManagerProps) {
  const { confirm } = useFeedback();
  const [path, setPath] = useState(() => norm(workspace || home || '/'));
  const [pathDraft, setPathDraft] = useState(path);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [navLoading, setNavLoading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [menu, setMenu] = useState<CtxMenu | null>(null);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [msg, setMsg] = useState('');
  const [deleting, setDeleting] = useState<DeletingInfo | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [wrState, setWrState] = useState<WriteState | null>(null); // 传到远程进度
  const listRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef(0);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = (text: string) => {
    setMsg(text);
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setMsg(''), 4000);
  };

  // 进入某子目录,只在该目录行右侧显示加载,不触发全局加载(双击进文件夹)
  const load = useCallback(async (p: string, opts: { itemPath?: string; keepSelected?: boolean } = {}) => {
    const seq = ++seqRef.current;
    const target = norm(p);
    if (opts.itemPath) { setNavLoading(opts.itemPath); }
    else { setLoading(true); }
    setError('');
    try {
      const r = await api.request('list_local_dir', { path: target }, 20000);
      if (seq !== seqRef.current) return;
      setPath(target); setPathDraft(target);
      setEntries(r.entries || []);
      if (!opts.keepSelected) { setSelection(new Set()); setAnchor(null); }
      onCwdChange?.(target);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError((e as Error).message);
    } finally {
      if (seq === seqRef.current) { setLoading(false); setNavLoading(null); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 工作区/家目录变化时,回到对应目录
  useEffect(() => {
    const start = norm(workspace || home || '/');
    setPath(start); setPathDraft(start); setSelection(new Set()); setAnchor(null);
    load(start, { keepSelected: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, home]);

  const sep = sepOf(path);
  const entryPath = (name: string) => {
    const t = String(path).replace(/[\\/]+$/, '');
    return t ? t + sep + name : name;
  };
  const isRoot = path === upDir(path);
  const refresh = () => load(path, { keepSelected: true });
  const up = () => { if (!isRoot) load(upDir(path)); };

  const clearSelection = () => { setSelection(new Set()); setAnchor(null); };

  const openEntry = (e: DirEntry) => {
    if (e.type === 'dir') load(entryPath(e.name), { itemPath: entryPath(e.name) });
    else onOpenLocalFile(entryPath(e.name));
  };

  // ---- 选择交互 ----
  const handleRowClick = (e: React.MouseEvent, entry: DirEntry) => {
    e.stopPropagation();
    listRef.current?.focus();
    if (e.shiftKey && anchor) {
      const ai = entries.findIndex((x) => x.name === anchor);
      const ci = entries.findIndex((x) => x.name === entry.name);
      if (ai >= 0 && ci >= 0) {
        const [lo, hi] = ai < ci ? [ai, ci] : [ci, ai];
        setSelection(new Set(entries.slice(lo, hi + 1).map((x) => x.name)));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setSelection((prev) => {
        const next = new Set(prev);
        if (next.has(entry.name)) next.delete(entry.name); else next.add(entry.name);
        return next;
      });
      setAnchor(entry.name);
      return;
    }
    setSelection(new Set([entry.name]));
    setAnchor(entry.name);
  };

  const handleListKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      setSelection(new Set(entries.map((x) => x.name)));
      setAnchor(null);
    } else if (e.key === 'Delete' && selection.size > 0 && !deleting) {
      e.preventDefault();
      doDelete();
    }
  };

  // ---- 选区派生 ----
  const selectedEntries = entries.filter((e) => selection.has(e.name));
  const selectedPaths = selectedEntries.map((e) => entryPath(e.name));
  const opPaths = selectedPaths.filter((p) => !selectedPaths.some((q) => p.startsWith(q + sep)));
  const opCount = opPaths.length;

  // ---- 右键菜单 ----
  const openMenu = (e: React.MouseEvent, item: DirEntry | null) => {
    e.preventDefault();
    e.stopPropagation();
    if (item) {
      if (!selection.has(item.name)) {
        setSelection(new Set([item.name]));
        setAnchor(item.name);
      }
    } else {
      clearSelection();
    }
    const w = 200, h = 220;
    setMenu({
      x: Math.max(0, Math.min(e.clientX, window.innerWidth - w - 8)),
      y: Math.max(0, Math.min(e.clientY, window.innerHeight - h - 8)),
      item
    });
  };
  const closeMenu = () => setMenu(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  // 订阅服务端本地删除进度事件(单次删除只有一条在跑,直接合并到当前 deleting)
  useEffect(() => {
    const off = api.on('local_delete_progress', (m) => {
      setDeleting((d) => {
        if (!d) return d;
        return { ...d, done: m.done, current: m.current || '' };
      });
    });
    return () => { off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 订阅传输进度事件(传到远程/remote_to_local 共用),复用 wrState 进度条
  useEffect(() => {
    const off = api.on('transfer_progress', (m) => {
      if (m && typeof m.total === 'number') setWrState({ done: m.done || 0, total: m.total });
    });
    return () => { off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 选区操作 ----
  const doDelete = async () => {
    if (opCount === 0 || deleting) return;
    const tip = opCount === 1 && selectedEntries[0]?.type === 'dir'
      ? '该目录及其内容将被永久删除,不可恢复'
      : `选中的 ${opCount} 项将被永久删除,不可恢复`;
    const ok = await confirm({
      title: '确认删除',
      message: `确认删除选中的 ${opCount} 项?${tip}`,
      confirmLabel: '删除',
      danger: true
    });
    if (!ok) return;
    const errors: string[] = [];
    const paths = opPaths;
    const N = paths.length;
    for (let i = 0; i < N; i++) {
      const p = paths[i];
      setDeleting({ index: i, total: N, name: baseName(p), done: 0, current: '' });
      try { await api.request('local_delete', { path: p }, DELETE_TIMEOUT, 'local_deleted'); }
      catch (e) { errors.push(`${baseName(p)}: ${(e as Error).message}`); }
    }
    setDeleting(null);
    clearSelection();
    refresh();
    if (errors.length) setError(errors.slice(0, 5).join('; '));
    else flash(`已删除 ${opCount} 项`);
  };
  const doCopy = () => {
    if (opCount === 0) return;
    setClipboard({ items: opPaths, op: 'copy' });
    flash(`已复制 ${opCount} 项`);
  };

  // 复制到目标目录;目标已存在且未允许覆盖时服务端抛 ERR_EXISTS
  const doCopyReq = (src: string, dst: string, overwrite: boolean) => api.request('local_copy', { src, dst, overwrite }, 120000);

  const dupName = (base: string) => {
    const dot = base.lastIndexOf('.');
    if (dot > 0) return base.slice(0, dot) + ' (副本)' + base.slice(dot);
    return base + ' (副本)';
  };

  const pasteHere = async (targetDir: string) => {
    if (!clipboard || clipboard.items.length === 0) return;
    const dir = norm(targetDir);
    let ok = 0, skipped = 0;
    for (const src of clipboard.items) {
      const base = baseName(src);
      let dst = dir + sep + base;
      if (norm(src) === norm(dst)) {
        dst = dir + sep + dupName(base);
        try { await doCopyReq(src, dst, false); ok++; continue; }
        catch { skipped++; continue; }
      }
      try {
        await doCopyReq(src, dst, false);
        ok++;
      } catch (e) {
        const m = (e as Error).message || '';
        if (m.includes('目标已存在')) {
          const overwrite = await confirm({
            title: '同名文件已存在',
            message: `目标已存在同名「${base}」,是否覆盖?`,
            confirmLabel: '覆盖',
            danger: true
          });
          if (overwrite) {
            try { await doCopyReq(src, dst, true); ok++; }
            catch (e2) { setError((e2 as Error).message); return; }
          } else { skipped++; }
        } else { setError(m); return; }
      }
    }
    setMsg(`已粘贴 ${ok} 项${skipped ? `,跳过 ${skipped} 项` : ''}`);
    refresh();
  };

  // 把选中项传到远程当前目录(local_to_remote):先确认(同名覆盖),再发请求,进度走 transfer_progress
  const doTransferToRemote = async () => {
    if (opCount === 0 || !remoteCwd) return;
    const ok = await confirm({
      title: '传到远程',
      message: `将把 ${opCount} 项传到目标目录「${remoteCwd}」,同名文件将被覆盖。继续?`,
      confirmLabel: '传输',
      danger: true
    });
    if (!ok) return;
    setTransferring(true); setWrState(null); setError('');
    try {
      const r = await api.request('local_to_remote', { paths: opPaths, dir: remoteCwd }, 600000, 'transfer_done');
      refresh();
      if (r.failed > 0) setError(`⬆ 已传 ${r.uploaded} 项,${r.failed} 项失败: ${(r.errors || []).slice(0, 5).join('; ')}`);
      else flash(`⬆ 已传到远程 ${remoteCwd || ''}(共 ${r.uploaded} 项)`);
    } catch (e) { setError((e as Error).message); }
    finally { setTransferring(false); setWrState(null); }
  };

  // 逐级向上直到根(无法再取上级的层级即根,如 Windows 盘符 C:\ 或 POSIX /)
  const rootPath = () => {
    let p = path;
    for (;;) { const up = upDir(p); if (up === p) return p; p = up; }
  };
  // 面包屑(按当前分隔符切分,Windows 盘符 C: 作为一级)
  const parts = path.split(sep).filter(Boolean).filter((s, i, a) => !(s === '' && i > 0 && i === a.length - 1));
  const crumbAcc: string[] = [];
  const crumbs = parts.map((c) => {
    crumbAcc.push(c);
    const p = crumbAcc.join(sep) + (c.endsWith(':') ? sep : '');
    return { c, p };
  });

  const statusText = deleting
    ? `正在删除 ${deleting.index + 1}/${deleting.total}: ${deleting.name}…已删 ${deleting.done} 项`
    : loading ? '加载中…'
      : transferring ? (wrState ? `传到远程 ${wrState.done}/${wrState.total}` : '正在传到远程…')
        : msg ? msg
          : selection.size > 1 ? `已选 ${selection.size} 项`
            : clipboard ? (clipboard.items.length > 1 ? `已复制 ${clipboard.items.length} 项` : `已复制:${baseName(clipboard.items[0])}`) : '';

  return (
    <div className="fm">
      <div className="fm-toolbar row gap">
        <button className="ghost sm" onClick={up} disabled={isRoot} title="上级目录">⬆ 上级</button>
        <button className="ghost sm" onClick={refresh} title="刷新">↻</button>
        {home && <button className="ghost sm" onClick={() => load(home)} title={`家目录 ${home}`}>🏠</button>}
        <div className="fm-crumbs">
          <span className={`crumb ${isRoot ? 'cur' : ''}`} onClick={() => load(rootPath())}>本机</span>
          {crumbs.map(({ c, p }) => (
            <span key={p} className="crumb-wrap">
              <span className="crumb-sep">{sep}</span>
              <span className={`crumb ${p === path ? 'cur' : ''}`} onClick={() => load(p)}>{c}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="row gap fm-addrbar">
        <input className="grow" value={pathDraft} spellCheck={false}
          onChange={(e) => setPathDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && pathDraft.trim()) load(pathDraft.trim()); }} />
        <button disabled={!pathDraft.trim()} onClick={() => load(pathDraft.trim())}>跳转</button>
      </div>

      <div className="row gap" style={{ marginTop: 8 }}>
        <button className="ghost sm" disabled={opCount === 0 || !remoteCwd || transferring}
          onClick={doTransferToRemote}
          title={!remoteCwd ? '请先连接服务器并查看远程目录' : `把选中项传到远程当前目录 ${remoteCwd||''}(同名覆盖)`}>
          ⬆ 传到远程
        </button>
        {clipboard && (
          <button className="ghost sm" onClick={() => pasteHere(path)} title="把已复制的项复制到当前目录">📋 粘贴</button>
        )}
        <span className="muted sm fm-status"
          title={deleting ? `正在删除: ${deleting.current || deleting.name}` : loading ? '加载中…' : selection.size > 1 ? `已选 ${selection.size} 项,点空白处取消` : msg || (clipboard ? `已复制:${clipboard.items.join(', ')}` : '')}>
          {statusText}
        </span>
      </div>
      {(deleting || transferring) && (
        <div className="progress">
          <div className={`progress-bar ${deleting && !transferring ? 'indet' : ''}`}
            style={{ width: transferring
              ? (wrState ? Math.round((wrState.done / Math.max(wrState.total, 1)) * 100) : 100) + '%'
              : '100%' }} />
        </div>
      )}
      {error && <div className="error" onClick={() => setError('')} title="点击关闭">✕ {error}</div>}

      <div className="fmlist" ref={listRef} tabIndex={-1}
        onClick={(e) => { if (e.target === e.currentTarget) { clearSelection(); e.currentTarget.focus(); } }}
        onKeyDown={handleListKey}
        onContextMenu={(e) => openMenu(e, null)}>
        {loading && entries.length === 0 && <div className="muted fmph">加载中…</div>}
        {!loading && entries.length === 0 && <div className="muted fmph">(空目录)</div>}
        {entries.map((e) => {
          const sel = selection.has(e.name);
          const navPath = entryPath(e.name);
          return (
            <div key={e.name} className={`fmrow ${sel ? 'selected' : ''} ${navPath === navLoading ? 'nav-loading' : ''}`}
              onClick={(ev) => handleRowClick(ev, e)}
              onDoubleClick={() => openEntry(e)}
              onContextMenu={(ev) => openMenu(ev, e)}
              title={navPath}>
              <span className="fm-ico">{e.type === 'dir' ? '📁' : e.type === 'link' ? '🔗' : '📄'}</span>
              <span className="fm-name">{e.name}</span>
              <span className="fm-size">{e.type === 'dir' ? '—' : fmtSize(e.size)}</span>
              <span className="fm-time">{fmtTime(e.mtime)}</span>
              {navPath === navLoading && <span className="fm-loading" title="加载中…" />}
            </div>
          );
        })}
      </div>

      <div className="muted sm" style={{ paddingTop: 6 }}>单击选中 · Ctrl/Shift 多选 · 双击打开 · 右键操作 · 传到远程当前目录</div>

      {menu && (
        <div className="ctxmenu" style={{ left: menu.x, top: menu.y }} onContextMenu={(e) => e.preventDefault()}>
          {menu.item && selection.size === 1 && menu.item.type === 'dir' && (
            <button onClick={() => { const p = entryPath(menu.item!.name); closeMenu(); load(p, { itemPath: p }); }}>📂 打开</button>
          )}
          {menu.item && selection.size === 1 && menu.item.type !== 'dir' && (
            <button onClick={() => { closeMenu(); onOpenLocalFile(entryPath(menu.item!.name)); }}>📄 打开</button>
          )}
          {menu.item && (
            <button onClick={() => { closeMenu(); doTransferToRemote(); }}>⬆ 传到远程当前目录{opCount > 1 ? `(${opCount} 项)` : ''}</button>
          )}
          {menu.item && (
            <button onClick={() => { closeMenu(); doCopy(); }}>📋 复制{opCount > 1 ? `(${opCount} 项)` : ''}</button>
          )}
          {clipboard ? (
            <button onClick={() => { closeMenu(); pasteHere(path); }}>📥 粘贴到此处</button>
          ) : (
            <button disabled title="先右键复制文件/文件夹,再到这里粘贴">📥 粘贴到此处</button>
          )}
          {menu.item && (
            <>
              <div className="ctx-sep" />
              <button className="danger" disabled={!!deleting} onClick={() => { closeMenu(); doDelete(); }}>🗑 删除{opCount > 1 ? `(${opCount} 项)` : ''}</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}