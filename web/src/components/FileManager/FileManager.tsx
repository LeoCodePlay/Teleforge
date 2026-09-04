import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api';
import { useFeedback } from '../../context/feedback';
import { useHorizontalScroller } from '../../hooks/useHorizontalScroller';
import type { DirEntry } from '../../types';
import './fm.scss';

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
const norm = (p: string | null | undefined) => { const s = String(p || '').replace(/\/+$/, ''); return s || '/'; };
const baseName = (p: string) => (p || '').split('/').filter(Boolean).pop() || 'item';

// 复制/粘贴专用错误标记(服务端在目标已存在且未允许覆盖时抛出)
const ERR_EXISTS = '目标已存在';
// 删除可能很慢(尤其递归删大目录),放宽请求超时
const DELETE_TIMEOUT = 600000;

interface FileManagerProps {
  workspace?: string | null;
  home?: string | null;
  connId?: string | null;            // 当前活动连接 id:切换服务器时即使 workspace/home 相同也强制回到新服务器目录
  localCwd?: string;                 // 本地面板当前目录(传到本地的目标)
  onCwdChange?: (p: string) => void; // 当前目录变化时上报
  onOpenFile: (path: string) => void;
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

// 文件管理器:导航式浏览远程目录(进入目录即显示其内容)
// 选中:单击单选 · Ctrl/Cmd+单击 多选切换 · Shift+单击 连选 · Ctrl+A 全选 · Delete 删除
// 操作:双击打开/进入 · 右键对选区执行 打开/下载/复制/删除/粘贴
export default function FileManager({ workspace, home, connId, localCwd, onCwdChange, onOpenFile }: FileManagerProps) {
  const { confirm } = useFeedback();
  const [path, setPath] = useState(() => norm(workspace || home || '/'));
  const [pathDraft, setPathDraft] = useState(path);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false); // 全局加载(返回/刷新/切换目录/首次加载)
  const [navLoading, setNavLoading] = useState<string | null>(null); // 正在进入的子目录完整路径(仅行内加载)
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<Set<string>>(new Set()); // 选中的条目 name 集合
  const [anchor, setAnchor] = useState<string | null>(null); // shift 连选的锚点 name
  const [menu, setMenu] = useState<CtxMenu | null>(null); // 右键菜单 {x, y, item|null}
  const [uploadMenu, setUploadMenu] = useState(false); // 「上传」按钮展开的选择菜单
  const [renaming, setRenaming] = useState<string | null>(null); // 正在重命名的条目 name
  const [renameDraft, setRenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false); // 正在真正下发重命名:行右侧显示加载圈
  const renameSubmitting = useRef(false); // 防 Enter 与 blur 双触发重复提交
  const [clipboard, setClipboard] = useState<Clipboard | null>(null); // {items: [path], op}
  const [msg, setMsg] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [deleting, setDeleting] = useState<DeletingInfo | null>(null); // 删除进度
  const [wrState, setWrState] = useState<WriteState | null>(null); // 服务端写入远程进度
  const [transferring, setTransferring] = useState(false); // 传到本地进行中
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef(0);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useHorizontalScroller(crumbsRef);

  const flash = (text: string) => {
    setMsg(text);
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setMsg(''), 4000);
  };

  // opts.itemPath:进入某子目录,只在该目录行右侧显示加载,不触发全局加载(双击进文件夹)
  const load = useCallback(async (p: string, opts: { itemPath?: string; keepSelected?: boolean } = {}) => {
    const seq = ++seqRef.current;
    const target = norm(p);
    if (opts.itemPath) { setNavLoading(opts.itemPath); }
    else { setLoading(true); }
    setError('');
    try {
      const r = await api.request('list_dir', { path: target }, 20000);
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

  // 工作区/家目录变化,或切换到另一台服务器(即使 workspace/home 值相同,目录内容也属于新服务器)时,
  // 回到对应目录并重新加载
  useEffect(() => {
    const start = norm(workspace || home || '/');
    setPath(start); setPathDraft(start); setSelection(new Set()); setAnchor(null);
    load(start, { keepSelected: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, home, connId]);

  const refresh = () => load(path, { keepSelected: true });
  const up = () => { if (path !== '/') load(path.slice(0, path.lastIndexOf('/')) || '/'); };
  const entryPath = (name: string) => (path === '/' ? '/' + name : path + '/' + name);

  const clearSelection = () => { setSelection(new Set()); setAnchor(null); };

  const openEntry = (e: DirEntry) => {
    if (e.type === 'dir') load(entryPath(e.name), { itemPath: entryPath(e.name) });
    else onOpenFile(entryPath(e.name));
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
        return; // 锚点保持不变
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
    } else if (e.key === 'F2' && selection.size === 1 && !renaming) {
      e.preventDefault();
      const only = selectedEntries[0];
      if (only) startRename(only.name);
    }
  };

  // ---- 选区派生 ----
  const selectedEntries = entries.filter((e) => selection.has(e.name));
  const selectedPaths = selectedEntries.map((e) => entryPath(e.name));
  // 去掉嵌套在其它选中项内部的多余项(父目录被删/复制时已覆盖子项)
  const opPaths = selectedPaths.filter((p) => !selectedPaths.some((q) => p.startsWith(q + '/')));
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
    // 用 pointerdown 而非 click 监听关闭:文件行的 click 被 stopPropagation 拦截(见 handleRowClick),
    // 但按下事件仍会冒泡到 window;点在菜单内部则忽略,保证菜单项的 click 能被正常触发
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current && menuRef.current.contains(t)) return;
      setMenu(null);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  // 「上传」菜单:点击外部或 Esc 时收起
  useEffect(() => {
    if (!uploadMenu) return;
    const close = () => setUploadMenu(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setUploadMenu(false); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey); };
  }, [uploadMenu]);

  // 订阅服务端删除进度事件(单次删除只有一条在跑,直接合并到当前 deleting)
  useEffect(() => {
    const off = api.on('delete_progress', (m) => {
      setDeleting((d) => {
        if (!d) return d;
        return { ...d, done: m.done, current: m.current || '' };
      });
    });
    return () => { off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 订阅传输进度事件(传到本地/local_to_remote 共用),复用 wrState 进度条
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
      try { await api.request('delete', { path: p }, DELETE_TIMEOUT, 'deleted'); }
      catch (e) { errors.push(`${baseName(p)}: ${(e as Error).message}`); }
    }
    setDeleting(null);
    clearSelection();
    refresh(); // 先刷新列表(refresh->load 开头会清空 error),再显示错误,避免删除失败报错被静默吞掉
    if (errors.length) setError(errors.slice(0, 5).join('; '));
    else flash(`已删除 ${opCount} 项`);
  };
  const doCopy = () => {
    if (opCount === 0) return;
    setClipboard({ items: opPaths, op: 'copy' });
    flash(`已复制 ${opCount} 项`);
  };
  const doDownload = () => {
    if (opCount === 0) return;
    if (opCount === 1) {
      const p = opPaths[0];
      const it = entries.find((e) => entryPath(e.name) === p);
      const url = (it?.type === 'dir')
        ? `/api/downloaddir?path=${encodeURIComponent(p)}`
        : `/api/download?path=${encodeURIComponent(p)}`;
      window.open(url, '_blank');
      flash(`正在下载 ${baseName(p)}…`);
    } else {
      const qs = opPaths.map((p) => `path=${encodeURIComponent(p)}`).join('&');
      window.open(`/api/downloaddir?${qs}`, '_blank');
      flash(`正在打包下载 ${opCount} 项…`);
    }
  };

  // 传到本地当前目录(remote_to_local):先确认(同名覆盖),再发请求,进度走 transfer_progress
  const doLocalTransfer = async () => {
    if (transferring || opCount === 0 || !localCwd) return;
    const ok = await confirm({
      title: '传到本地',
      message: `将把 ${opCount} 项传到目标目录「${localCwd}」,同名文件将被覆盖。继续?`,
      confirmLabel: '传输',
      danger: true
    });
    if (!ok) return;
    setWrState(null); setError(''); setTransferring(true);
    try {
      const r = await api.request('remote_to_local', { paths: opPaths, dir: localCwd }, 600000, 'transfer_done');
      refresh();
      if (r.failed > 0) setError(`⬇ 已传 ${r.downloaded} 项,${r.failed} 项失败: ${(r.errors || []).slice(0, 5).join('; ')}`);
      else flash(`⬇ 已传到本地 ${localCwd}(共 ${r.downloaded} 项)`);
    } catch (e) { setError((e as Error).message); }
    finally { setWrState(null); setTransferring(false); }
  };

  // 复制到目标目录;目标已存在且未允许覆盖时抛出 ERR_EXISTS
  const doCopyReq = (src: string, dst: string, overwrite: boolean) => api.request('copy', { src, dst, overwrite }, 120000);

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
      let dst = (dir === '/' ? '/' : dir) + '/' + base;
      if (norm(src) === norm(dst)) { // 同目录粘贴 = 复制副本,直接换个名,不覆盖
        dst = (dir === '/' ? '/' : dir) + '/' + dupName(base);
        try { await doCopyReq(src, dst, false); ok++; continue; }
        catch { skipped++; continue; }
      }
      try {
        await doCopyReq(src, dst, false);
        ok++;
      } catch (e) {
        const msg = (e as Error).message || '';
        if (msg.includes(ERR_EXISTS)) {
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
        } else { setError(msg); return; }
      }
    }
    setMsg(`已粘贴 ${ok} 项${skipped ? `,跳过 ${skipped} 项` : ''}`);
    refresh();
  };

  // ---- 上传到当前目录 ----
  const uploadFiles = (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const fd = new FormData();
    for (const f of files) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      fd.append('files', f, rel);
    }
    setUploading(true); setProgress(0); setWrState(null); setError('');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?dir=${encodeURIComponent(path)}`);
    // 阶段1:浏览器→服务器 的 body 传输(上限 99,避免 body 传完但服务端还没开始写入时虚报 100%)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100)); };
    // 阶段2:服务端按文件回传写入进度(NDJSON 流),读到即切到写入阶段,显示真实进度
    xhr.onprogress = () => {
      const text = xhr.responseText;
      if (!text) return;
      for (const ln of text.split('\n')) {
        let m; try { m = JSON.parse(ln); } catch { continue; }
        if (m && m.type === 'progress' && m.total) setWrState({ done: m.done, total: m.total });
      }
    };
    xhr.onload = () => {
      setUploading(false);
      let r: any = null;
      const lastLn = xhr.responseText.split('\n').filter(Boolean).pop();
      if (lastLn) { try { r = JSON.parse(lastLn); } catch {} }
      if (xhr.status === 200 && r) {
        refresh(); // 先刷新列表,避免"上传成功但目录里看不到"的错觉
        if (r.failed > 0) setError(`⬆ 已上传 ${r.uploaded} 个文件,但 ${r.failed} 个失败: ${(r.errors || []).slice(0, 5).join('; ')}`);
        else flash(`⬆ 已上传 ${r.uploaded} 个文件(${fmtSize(r.bytes)})`);
      } else {
        setError(`✕ 上传失败: ${r?.error || xhr.statusText}`);
      }
    };
    xhr.onerror = () => { setUploading(false); setError('✕ 网络错误,上传失败'); };
    xhr.send(fd);
  };

  // 「上传」按钮:一个按钮同时支持选文件/选文件夹(浏览器单个 file input 只能二选一,故点击弹菜单)
  const pickUpload = (kind: 'file' | 'dir') => () => {
    setUploadMenu(false);
    if (kind === 'dir') dirInputRef.current?.click();
    else fileInputRef.current?.click();
  };

  // ---- 重命名 ----
  const startRename = (name: string) => {
    setMenu(null);
    setRenaming(name);
    setRenameDraft(name);
  };
  const commitRename = async () => {
    if (renameSubmitting.current || !renaming) return;
    const oldName = renaming;
    const newName = renameDraft.trim();
    // 名称未变化或为空:不真正重命名,直接退出编辑
    if (!newName || newName === oldName) { setRenaming(null); setRenameDraft(''); return; }
    if (newName.includes('/') || newName.includes('\\')) { setError('名称不能包含 / 或 \\'); setRenaming(null); setRenameDraft(''); return; }
    renameSubmitting.current = true;
    setRenameBusy(true); // 请求进行中:行右侧显示加载圈(复用 fm-loading)
    try {
      await api.request('rename', { src: entryPath(oldName), dst: entryPath(newName) }, 30000, 'renamed');
      refresh();
      flash(`✏️ 已重命名为 ${newName}`);
    } catch (e) { setError((e as Error).message); refresh(); }
    finally {
      renameSubmitting.current = false;
      setRenameBusy(false);
      setRenaming(null); setRenameDraft('');
    }
  };

  // 面包屑
  const crumbs = path.split('/').filter(Boolean);

  const statusText = deleting
    ? `正在删除 ${deleting.index + 1}/${deleting.total}: ${deleting.name}…已删 ${deleting.done} 项`
    : uploading ? (wrState ? `写入远程 ${wrState.done}/${wrState.total}` : `上传中 ${Math.min(progress, 99)}%`)
      : transferring ? (wrState ? `传到本地 ${wrState.done}/${wrState.total}` : '传到本地…')
        : msg ? msg
          : selection.size > 1 ? `已选 ${selection.size} 项`
            : clipboard ? (clipboard.items.length > 1 ? `已复制 ${clipboard.items.length} 项` : `已复制:${baseName(clipboard.items[0])}`) : '';

  return (
    <div className="fm">
      <div className="fm-toolbar row gap">
        {home && <button className="ghost sm" onClick={() => load(home)} data-tip={`家目录 ${home}`}>🏠</button>}
        <div className="fm-crumbs" ref={crumbsRef} data-ob-skip>
          <span className={`crumb ${path === '/' ? 'cur' : ''}`} onClick={() => load('/')}>/</span>
          {crumbs.map((c, i) => {
            const p = '/' + crumbs.slice(0, i + 1).join('/');
            return (
              <span key={p} className="crumb-wrap">
                <span className="crumb-sep">/</span>
                <span className={`crumb ${p === path ? 'cur' : ''}`} onClick={() => load(p)}>{c}</span>
              </span>
            );
          })}
        </div>
      </div>

      <div className="row gap fm-addrbar">
        <input className="grow" value={pathDraft} spellCheck={false}
          onChange={(e) => setPathDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && pathDraft.trim()) load(pathDraft.trim()); }} />
        <button disabled={!pathDraft.trim()} onClick={() => load(pathDraft.trim())}>跳转</button>
      </div>

      <div className="row gap fm-actions">
        <button className="ghost sm" onClick={up} disabled={path === '/'}>⬆ 上级</button>
        <button className="ghost sm" onClick={refresh}>↻</button>
        <div className="fm-upload">
          <button className="ghost sm" disabled={uploading}
            onClick={(e) => { e.stopPropagation(); setUploadMenu((v) => !v); }}>⬆ 上传 ▾</button>
          {uploadMenu && (
            <div className="ctxmenu fm-upload-menu" onContextMenu={(e) => e.preventDefault()}>
              <button onClick={pickUpload('file')}>📄 上传文件</button>
              <button onClick={pickUpload('dir')}>📁 上传文件夹</button>
            </div>
          )}
        </div>
        <button className="ghost sm" disabled={transferring || opCount === 0 || !localCwd}
          onClick={doLocalTransfer}
          data-tip={!localCwd ? '请先在本地面板选择一个目录' : `把选中项传到本地当前目录 ${localCwd}(同名覆盖)`}>⬇ 传到本地</button>
        {clipboard && (
          <button className="ghost sm" onClick={() => pasteHere(path)}>📋 粘贴</button>
        )}
        <span className="muted sm fm-status"
          data-tip={deleting ? `正在删除: ${deleting.current || deleting.name}` : selection.size > 1 ? `已选 ${selection.size} 项,点空白处取消` : msg || (clipboard ? `已复制:${clipboard.items.join(', ')}` : '')}>
          {statusText}
        </span>
      </div>
      {(uploading || deleting || transferring) && (
        <div className="progress">
          <div className={`progress-bar ${deleting && !uploading && !transferring ? 'indet' : ''}`}
            style={{ width: uploading
              ? (wrState ? Math.round((wrState.done / Math.max(wrState.total, 1)) * 100) : Math.min(progress, 99)) + '%'
              : transferring
                ? (wrState ? Math.round((wrState.done / Math.max(wrState.total, 1)) * 100) : 100) + '%'
                : '100%' }} />
        </div>
      )}
      {error && <div className="error" onClick={() => setError('')}>✕ {error}</div>}

      <div className="fmlist" ref={listRef} tabIndex={-1}
        onClick={(e) => { if (e.target === e.currentTarget) { clearSelection(); e.currentTarget.focus(); } }}
        onKeyDown={handleListKey}
        onContextMenu={(e) => openMenu(e, null)}>
        {/* 加载中且列表为空:在列表区明显显示加载中(避免状态文字不显眼/被挡住);进入子目录只行内转圈,不影响列表 */}
        {loading && entries.length === 0 && <div className="muted fmph">加载中…</div>}
        {!loading && entries.length === 0 && <div className="muted fmph">(空目录)</div>}
        {entries.map((e) => {
          const sel = selection.has(e.name);
          const navPath = entryPath(e.name);
          return (
            <div key={e.name} className={`fmrow ${sel ? 'selected' : ''} ${navPath === navLoading ? 'nav-loading' : ''}`}
              onClick={(ev) => handleRowClick(ev, e)}
              onDoubleClick={() => openEntry(e)}
              onContextMenu={(ev) => openMenu(ev, e)}>
              <span className={`fm-ico${renaming === e.name ? ' fm-hide' : ''}`}>{e.type === 'dir' ? '📁' : e.type === 'link' ? '🔗' : '📄'}</span>
              {/* 各列始终留在文档流(fm-hide 仅隐藏文字、保留占位),行高/行宽与普通行完全一致 */}
              <span className={`fm-name${renaming === e.name ? ' fm-hide' : ''}`} data-tip={e.name} data-tip-ellipsis data-tip-follow>{e.name}</span>
              {renaming === e.name && (
                // 重命名输入框:绝对定位覆盖整行(见 .fm-rename),进出编辑零抖动
                <input className="fm-rename" autoFocus value={renameDraft}
                  spellCheck={false}
                  onChange={(ev) => setRenameDraft(ev.target.value)}
                  onFocus={(ev) => {
                    // 默认选中不含扩展名的部分,方便直接输入新名
                    const dot = ev.target.value.lastIndexOf('.');
                    if (dot > 0) ev.target.setSelectionRange(0, dot);
                    else ev.target.select();
                  }}
                  onClick={(ev) => ev.stopPropagation()}
                  onDoubleClick={(ev) => ev.stopPropagation()}
                  onContextMenu={(ev) => ev.preventDefault()}
                  onKeyDown={(ev) => {
                    ev.stopPropagation();
                    // 中文等输入法组词中:Enter 是确认候选字,不在此提交重命名
                    if (ev.nativeEvent.isComposing) return;
                    if (ev.key === 'Enter') commitRename();
                    else if (ev.key === 'Escape') { setRenaming(null); setRenameDraft(''); }
                  }}
                  onBlur={commitRename} />
              )}
              <span className={`fm-size${renaming === e.name ? ' fm-hide' : ''}`}>{e.type === 'dir' ? '—' : fmtSize(e.size)}</span>
              <span className={`fm-time${renaming === e.name ? ' fm-hide' : ''}`}>{fmtTime(e.mtime)}</span>
              {renaming === e.name && renameBusy
                ? <span className="fm-loading" data-tip="重命名中…" />
                : navPath === navLoading && <span className="fm-loading" data-tip="加载中…" />}
            </div>
          );
        })}
      </div>

      <div className="muted sm" style={{ paddingTop: 6 }}>单击选中 · Ctrl/Shift 多选 · 双击打开 · F2 重命名 · 右键操作 · 上传到当前目录</div>

      {menu && createPortal(
        <div ref={menuRef} className="ctxmenu" style={{ left: menu.x, top: menu.y }} onContextMenu={(e) => e.preventDefault()}>
          {menu.item && selection.size === 1 && menu.item.type === 'dir' && (
            <button onClick={() => { const p = entryPath(menu.item!.name); closeMenu(); load(p, { itemPath: p }); }}>📂 打开</button>
          )}
          {menu.item && selection.size === 1 && menu.item.type !== 'dir' && (
            <button onClick={() => { closeMenu(); onOpenFile(entryPath(menu.item!.name)); }}>📄 打开</button>
          )}
          {menu.item && (
            <button onClick={() => { closeMenu(); doDownload(); }}>⬇ 下载{opCount > 1 ? `(${opCount} 项)` : ''}</button>
          )}
          {menu.item && (
            <button disabled={transferring || !localCwd} data-tip={!localCwd ? '请先在本地面板选择一个目录' : `把选中项传到本地当前目录 ${localCwd}(同名覆盖)`} onClick={() => { closeMenu(); doLocalTransfer(); }}>⬇ 传到本地{opCount > 1 ? `(${opCount} 项)` : ''}</button>
          )}
          {menu.item && (
            <button onClick={() => { closeMenu(); doCopy(); }}>📋 复制{opCount > 1 ? `(${opCount} 项)` : ''}</button>
          )}
          {menu.item && selection.size === 1 && !deleting && (
            <button onClick={() => startRename(menu.item!.name)}>✏️ 重命名</button>
          )}
          {clipboard ? (
            <button onClick={() => { closeMenu(); pasteHere(path); }}>📥 粘贴到此处</button>
          ) : (
            <button disabled data-tip="先右键复制文件/文件夹,再到这里粘贴">📥 粘贴到此处</button>
          )}
          {menu.item && (
            <>
              <div className="ctx-sep" />
              <button className="danger" disabled={!!deleting} onClick={() => { closeMenu(); doDelete(); }}>🗑 删除{opCount > 1 ? `(${opCount} 项)` : ''}</button>
            </>
          )}
        </div>,
        document.body
      )}

      <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }}
        onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }} />
      <input ref={dirInputRef} type="file" multiple style={{ display: 'none' }}
        {...({ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
        onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }} />
    </div>
  );
}