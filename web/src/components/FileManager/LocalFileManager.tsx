import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api';
import { useFeedback } from '../../context/feedback';
import { useHorizontalScroller } from '../../hooks/useHorizontalScroller';
import { useLongPress } from '../../hooks/useLongPress';
import type { DirEntry } from '../../types';
import './fm.scss';

function fmtTime(ms: number | undefined) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}
// 本地路径分隔符可能是 \ (Windows) 或 / (POSIX);"root:" = 我的电脑根视图(Windows 盘符 / POSIX 根)
const ROOT = 'root:';
// 归一化:去尾部斜杠;但 Windows 盘符根(F:)保留尾斜杠成"F:\",否则 path.resolve 会解析成该盘"当前目录"而非盘根
const norm = (p: string | null | undefined) => {
  if (!p) return ROOT;
  const s = String(p).replace(/[\\/]+$/, '');
  if (!s) return ROOT;
  return /^[A-Za-z]:$/.test(s) ? s + '\\' : s;
};
const baseName = (p: string) => (p || '').split(/[\\/]/).filter(Boolean).pop() || 'item';

// 写剪贴板:优先 Clipboard API,非安全上下文降级为隐藏 textarea + execCommand
const writeClipboard = async (text: string) => {
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  } catch {}
};
const upDir = (p: string) => {
  if (!p || p === ROOT) return ROOT;
  const t = String(p).replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(t)) return ROOT;   // Windows 盘符根 C: → 我的电脑
  const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
  return i <= 0 ? ROOT : t.slice(0, i);     // POSIX / → 我的电脑
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

// 文件列表单行:独立子组件以便在每行内调用 useLongPress(hook 不能在 map 循环中调用)。
// 长按(触屏)与 onContextMenu(桌面右键)共用 onLongPress/onMenu 打开同一个菜单函数。
interface FmRowProps {
  entry: DirEntry;
  selected: boolean;
  navLoading: boolean;
  renaming: boolean;
  renameBusy: boolean;
  renameDraft: string;
  onRenameDraft: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onRowClick: (ev: React.MouseEvent, entry: DirEntry) => void;
  onOpen: (entry: DirEntry) => void;
  onMenu: (ev: React.MouseEvent, entry: DirEntry) => void;
  onLongPress: (x: number, y: number, entry: DirEntry) => void;
}
function FmRow({ entry, selected, navLoading, renaming, renameBusy, renameDraft,
  onRenameDraft, onCommitRename, onCancelRename, onRowClick, onOpen, onMenu, onLongPress }: FmRowProps) {
  const lp = useLongPress((x, y) => onLongPress(x, y, entry));
  return (
    <div className={`fmrow ${selected ? 'selected' : ''} ${navLoading ? 'nav-loading' : ''}`}
      {...lp.bind}
      onClick={(ev) => { if (lp.wasLongPress()) return; onRowClick(ev, entry); }}
      onDoubleClick={() => onOpen(entry)}
      onContextMenu={(ev) => onMenu(ev, entry)}>
      {/* 图标在重命名时保留可见,便于分辨编辑的是文件还是文件夹 */}
      <span className="fm-ico">{entry.type === 'dir' ? '📁' : entry.type === 'link' ? '🔗' : '📄'}</span>
      {/* 名称/时间列留在文档流(fm-hide 仅隐藏文字、保留占位),行高/行宽与普通行完全一致 */}
      <span className={`fm-name${renaming ? ' fm-hide' : ''}`} data-tip={entry.name} data-tip-ellipsis data-tip-follow>{entry.name}</span>
      {renaming && (
        // 重命名输入框:绝对定位覆盖名称/时间区(图标保留可见,见 .fm-rename),进出编辑零抖动
        <input className="fm-rename" autoFocus value={renameDraft}
          spellCheck={false}
          onChange={(ev) => onRenameDraft(ev.target.value)}
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
            if (ev.key === 'Enter') onCommitRename();
            else if (ev.key === 'Escape') onCancelRename();
          }}
          onBlur={onCommitRename} />
      )}
      <span className={`fm-time${renaming ? ' fm-hide' : ''}`}>{fmtTime(entry.mtime)}</span>
      {renaming && renameBusy
        ? <span className="fm-loading" data-tip="重命名中…" />
        : navLoading && <span className="fm-loading" data-tip="加载中…" />}
    </div>
  );
}

// 本地文件管理器:导航式浏览本地目录
// 选中:单击单选 · Ctrl/Cmd+单击 多选切换 · Shift+单击 连选 · Ctrl+A 全选 · Delete 删除
// 操作:双击打开/进入 · 右键对选区执行 打开/复制/删除/粘贴 · 「传到远程」把选区发往远程当前目录
// 固定定位的右键菜单只在"面板内容会移动"的滚动时才需要关闭:滚动元素在面板内(列表/面包屑自滚)
// 或包含面板(外层容器滚动)会让菜单与行错位;聊天流式吸底、编辑器等无关区域的滚动不打断菜单
function scrollMovesPanel(root: HTMLElement | null, e: Event): boolean {
  if (!root) return true;
  const el = e.target instanceof Document ? e.target.documentElement : e.target as Node | null;
  if (!el) return true;
  return root.contains(el) || el.contains(root);
}

export default function LocalFileManager({ workspace, home, remoteCwd, onCwdChange, onOpenLocalFile }: LocalFileManagerProps) {
  const { confirm } = useFeedback();
  const [path, setPath] = useState(() => norm(workspace || home || ROOT));
  const [pathDraft, setPathDraft] = useState(path);
  const [editingPath, setEditingPath] = useState(false); // 路径编辑模式:面包屑行变为输入框(点当前级面包屑进入)
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [navLoading, setNavLoading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false); // 多选模式:触屏无 Ctrl/Shift,进入后点按即切换选中
  const [menu, setMenu] = useState<CtxMenu | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null); // 正在重命名的条目 name
  const [renameDraft, setRenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false); // 正在真正下发重命名:行右侧显示加载圈
  const [renameRetry, setRenameRetry] = useState<{ oldName: string; newName: string } | null>(null); // 重命名失败后的重试目标:错误条「↻ 重试」一键重发
  const renameSubmitting = useRef(false); // 防 Enter 与 blur 双触发重复提交
  const [creating, setCreating] = useState<'file' | 'dir' | null>(null); // 新建输入行:file=新建文件 / dir=新建文件夹
  const [createDraft, setCreateDraft] = useState('');
  const createSubmitting = useRef(false); // 防 Enter 与 blur 双触发重复创建
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [msg, setMsg] = useState('');
  const [deleting, setDeleting] = useState<DeletingInfo | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [wrState, setWrState] = useState<WriteState | null>(null); // 传到远程进度
  const listRef = useRef<HTMLDivElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);           // 面板根节点:滚动关闭时判定菜单是否会错位
  const seqRef = useRef(0);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useHorizontalScroller(crumbsRef);

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
    setRenameRetry(null); // 目录已切换,旧的重试目标失效
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
    const start = norm(workspace || home || ROOT);
    setEditingPath(false); // 切换工作区时退出编辑,避免输入框挂着旧路径
    setPath(start); setPathDraft(start); setSelection(new Set()); setAnchor(null);
    load(start, { keepSelected: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, home]);

  const sep = sepOf(path);
  const entryPath = (name: string) => {
    if (path === ROOT) return name; // 根视图:盘符/目录名直接是完整路径
    const t = String(path).replace(/[\\/]+$/, '');
    return t ? t + sep + name : name;
  };
  const isRoot = path === ROOT;
  const refresh = () => load(path, { keepSelected: true });
  const up = () => { if (!isRoot) load(upDir(path)); };

  // ---- 路径编辑(与面包屑合一):点父级面包屑直接跳转,点当前级(cur)进入编辑 ----
  // 进入编辑以当前路径为草稿并全选;Enter 跳转后回到面包屑;Esc/失焦退出不跳转(与资源管理器一致,防误触)
  const startEditPath = () => { setPathDraft(path); setEditingPath(true); };
  const cancelEditPath = () => setEditingPath(false);
  const commitEditPath = () => {
    if (!editingPath) return;
    setEditingPath(false);
    const t = pathDraft.trim();
    if (t && norm(t) !== path) load(t); // 路径没变就只退出编辑,不重新加载
  };

  const clearSelection = () => { setSelection(new Set()); setAnchor(null); };

  // 多选模式开关:退出时清空已选(避免残留高亮却无可见操作条)
  const toggleSelectMode = () => {
    setSelectMode((m) => {
      const next = !m;
      if (!next) clearSelection();
      return next;
    });
  };

  const openEntry = (e: DirEntry) => {
    if (e.type === 'dir') load(entryPath(e.name), { itemPath: entryPath(e.name) });
    else onOpenLocalFile(entryPath(e.name));
  };

  // ---- 选择交互 ----
  const handleRowClick = (e: React.MouseEvent, entry: DirEntry) => {
    e.stopPropagation();
    listRef.current?.focus();
    // 多选模式:点按切换选中(触屏无 Ctrl/Shift 时的多选入口)
    if (selectMode) {
      setSelection((prev) => {
        const next = new Set(prev);
        if (next.has(entry.name)) next.delete(entry.name); else next.add(entry.name);
        return next;
      });
      setAnchor(entry.name);
      return;
    }
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
    } else if (e.key === 'F2' && selection.size === 1 && !renaming) {
      e.preventDefault();
      const only = selectedEntries[0];
      if (only) startRename(only.name);
    }
  };

  // ---- 选区派生 ----
  const selectedEntries = entries.filter((e) => selection.has(e.name));
  const selectedPaths = selectedEntries.map((e) => entryPath(e.name));
  const opPaths = selectedPaths.filter((p) => !selectedPaths.some((q) => p.startsWith(q + sep)));
  const opCount = opPaths.length;

  // ---- 右键菜单 ----
  // 坐标版:供 onContextMenu 与触屏长按共同调用(长按没有 DOM 事件)
  const openMenuAt = (x: number, y: number, item: DirEntry | null) => {
    if (item) {
      if (!selection.has(item.name)) {
        setSelection(new Set([item.name]));
        setAnchor(item.name);
      }
    } else {
      clearSelection();
    }
    const w = 200, h = 420;
    setMenu({
      x: Math.max(0, Math.min(x, window.innerWidth - w - 8)),
      y: Math.max(0, Math.min(y, window.innerHeight - h - 8)),
      item
    });
  };
  const openMenu = (e: React.MouseEvent, item: DirEntry | null) => {
    e.preventDefault();
    e.stopPropagation();
    openMenuAt(e.clientX, e.clientY, item);
  };
  const closeMenu = () => setMenu(null);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    // 用 pointerdown 而非 click 监听关闭:文件行的 click 被 stopPropagation 拦截(见 handleRowClick),
    // 但按下事件仍会冒泡到 window;点在菜单内部则忽略,保证菜单项的 click 能被正常触发
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current && menuRef.current.contains(t)) return;
      setMenu(null);
    };
    const onScroll = (e: Event) => { if (scrollMovesPanel(rootRef.current, e)) setMenu(null); };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
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
  // 复制选中项完整路径到系统剪贴板(多选时逐行拼接)
  const doCopyPath = async () => {
    if (opCount === 0) return;
    await writeClipboard(opPaths.join('\n'));
    flash(opCount === 1 ? `已复制路径:${opPaths[0]}` : `已复制 ${opCount} 项路径`);
  };
  // 复制选中项文件名到系统剪贴板(多选时逐行拼接,不含目录)
  const doCopyName = async () => {
    if (opCount === 0) return;
    const names = selectedEntries.map((e) => e.name).join('\n');
    await writeClipboard(names);
    flash(opCount === 1 ? `已复制文件名:${selectedEntries[0].name}` : `已复制 ${opCount} 个文件名`);
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

  // ---- 重命名 ----
  const startRename = (name: string) => {
    setMenu(null);
    setRenaming(name);
    setRenameDraft(name);
  };
  const performRename = async (oldName: string, newName: string) => {
    renameSubmitting.current = true;
    setRenameBusy(true); // 请求进行中:行右侧显示加载圈(复用 fm-loading)
    try {
      await api.request('local_rename', { src: entryPath(oldName), dst: entryPath(newName) }, 30000, 'local_renamed');
      setRenameRetry(null); // 成功:清除重试目标
      refresh();
      flash(`✏️ 已重命名为 ${newName}`);
    } catch (e) {
      // 失败(Windows 上多为目录被占用 EBUSY:资源管理器窗口/终端/编辑器停在该文件夹内)。
      // 这里绝不能 refresh():load() 开头会 setError(''),把刚设置的错误提示立刻清掉,
      // 界面就成了「输入框挂着却没有任何解释」;失败时列表本就未变,退出编辑+显示原因即可。
      const raw = (e as Error).message || String(e);
      setError(/EBUSY|EPERM|busy or locked/i.test(raw)
        ? `「${oldName}」正被其他程序占用,无法重命名(常见:资源管理器窗口停在该文件夹内、终端/编辑器以它为当前目录)。关闭占用它的程序后,点错误条上的「重试」即可`
        : raw);
      setRenameRetry({ oldName, newName }); // 记录重试目标:错误条「↻ 重试」一键重发,免去重新输入名字
    } finally {
      renameSubmitting.current = false;
      setRenameBusy(false);
      setRenaming(null); setRenameDraft(''); // 无论成败都退出编辑:失败靠错误条说明原因,绝不让输入框无提示地挂着
    }
  };
  const commitRename = async () => {
    if (renameSubmitting.current || !renaming) return;
    const oldName = renaming;
    const newName = renameDraft.trim();
    // 名称未变化或为空:不真正重命名,直接退出编辑
    if (!newName || newName === oldName) { setRenaming(null); setRenameDraft(''); return; }
    if (newName.includes('/') || newName.includes('\\')) { setError('名称不能包含 / 或 \\'); setRenaming(null); setRenameDraft(''); return; }
    // 预检重名(排除自身):与新建一致的友好提示,避免提交后被服务器以「目标已存在」打回
    if (entries.some((e) => e.name !== oldName && e.name === newName)) { setError(`已存在同名「${newName}」`); setRenaming(null); setRenameDraft(''); return; }
    await performRename(oldName, newName);
  };

  // ---- 新建文件/文件夹:在列表末尾出现一行输入,Enter 提交 / Esc 取消 / blur 提交 ----
  const startCreate = (kind: 'file' | 'dir') => {
    setMenu(null);
    setCreating(kind);
    setCreateDraft(kind === 'dir' ? '新建文件夹' : '新建文件.txt');
  };
  const cancelCreate = () => { setCreating(null); setCreateDraft(''); };
  const commitCreate = async () => {
    if (createSubmitting.current || !creating) return;
    const name = createDraft.trim();
    if (!name) { cancelCreate(); return; }
    if (name.includes('/') || name.includes('\\')) { setError('名称不能包含 / 或 \\'); cancelCreate(); return; }
    if (entries.some((e) => e.name === name)) { setError(`已存在同名「${name}」`); cancelCreate(); return; }
    createSubmitting.current = true;
    try {
      const p = entryPath(name);
      if (creating === 'dir') await api.request('create_local_dir', { path: p }, 30000, 'local_dir_created');
      else await api.request('write_local_file', { path: p, content: '' }, 30000, 'local_file_saved');
      refresh();
      flash(creating === 'dir' ? `📁 已创建文件夹 ${name}` : `📄 已创建文件 ${name}`);
    } catch (e) { setError((e as Error).message); refresh(); }
    finally { createSubmitting.current = false; cancelCreate(); }
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
  // 面包屑(按当前分隔符切分,Windows 盘符 C: 作为一级;我的电脑根视图无子级)
  const parts = path === ROOT ? [] : path.split(sep).filter(Boolean).filter((s, i, a) => !(s === '' && i > 0 && i === a.length - 1));
  const crumbAcc: string[] = [];
  const crumbs = parts.map((c) => {
    crumbAcc.push(c);
    const p = crumbAcc.join(sep) + (c.endsWith(':') ? sep : '');
    return { c, p };
  });

  const statusText = deleting
    ? `正在删除 ${deleting.index + 1}/${deleting.total}: ${deleting.name}…已删 ${deleting.done} 项`
    : transferring ? (wrState ? `传到远程 ${wrState.done}/${wrState.total}` : '正在传到远程…')
      : msg ? msg
        : selection.size > 1 ? `已选 ${selection.size} 项`
          : clipboard ? (clipboard.items.length > 1 ? `已复制 ${clipboard.items.length} 项` : `已复制:${baseName(clipboard.items[0])}`) : '';

  return (
    <div className="fm" ref={rootRef}>
      {/* 面包屑与路径编辑合一:点父级直接跳转,点当前级(cur)进入输入框编辑,回车跳转后回到面包屑 */}
      <div className="fm-toolbar row gap">
        {/* 编辑时面包屑只 display:none 隐藏而非卸载:useHorizontalScroller 只在挂载时绑定滚轮/拖拽,
            卸载重挂会让横向滚动失效 */}
        <div className="fm-crumbs" ref={crumbsRef} data-ob-skip style={editingPath ? { display: 'none' } : undefined}>
          <span className={`crumb ${isRoot ? 'cur' : ''}`} data-tip={isRoot ? '点击编辑路径' : undefined}
            onClick={() => (isRoot ? startEditPath() : load(rootPath()))}>本机</span>
          {crumbs.map(({ c, p }) => {
            const cur = p === path;
            return (
              <span key={p} className="crumb-wrap">
                <span className="crumb-sep">{sep}</span>
                <span className={`crumb ${cur ? 'cur' : ''}`} data-tip={cur ? '点击编辑路径' : undefined}
                  onClick={() => (cur ? startEditPath() : load(p))}>{c}</span>
              </span>
            );
          })}
        </div>
        {editingPath && (
          <input className="fm-path-edit grow" autoFocus value={pathDraft} spellCheck={false}
            onChange={(e) => setPathDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              // 中文等输入法组词中:Enter 是确认候选字,不在此提交跳转
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') commitEditPath();
              else if (e.key === 'Escape') cancelEditPath();
            }}
            onBlur={cancelEditPath} />
        )}
      </div>

      <div className="row gap fm-actions">
        <button className="ghost sm" onClick={up} disabled={isRoot}>⬆ 上级</button>
        <button className="ghost sm" onClick={refresh}>↻</button>
        {/* 多选模式:仅触屏设备渲染(桌面有 Ctrl/Shift 多选,不需要) */}
        <button className={`ghost sm fm-select-toggle${selectMode ? ' on' : ''}`} onClick={toggleSelectMode}>
          {selectMode ? '✕ 退出多选' : '☑ 多选模式'}
        </button>
        <button className="ghost sm" disabled={opCount === 0 || !remoteCwd || transferring}
          onClick={doTransferToRemote}
          data-tip={!remoteCwd ? '请先连接服务器并查看远程目录' : `把选中项传到远程当前目录 ${remoteCwd||''}(同名覆盖)`}>
          ⬆ 传到远程
        </button>
        {clipboard && (
          <button className="ghost sm" onClick={() => pasteHere(path)}>📋 粘贴</button>
        )}
        <span className="muted sm fm-status"
          data-tip={deleting ? `正在删除: ${deleting.current || deleting.name}` : selection.size > 1 ? `已选 ${selection.size} 项,点空白处取消` : msg || (clipboard ? `已复制:${clipboard.items.join(', ')}` : '')}>
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
      {error && (
        <div className="error" onClick={() => { setError(''); setRenameRetry(null); }}>
          {renameRetry && (
            <button className="ghost sm" style={{ marginRight: 8 }}
              onClick={(ev) => { ev.stopPropagation(); performRename(renameRetry.oldName, renameRetry.newName); }}
              data-tip="已关闭占用程序?点此用原名/新名重新尝试">↻ 重试</button>
          )}
          ✕ {error}
        </div>
      )}

      <div className="fmlist" ref={listRef} tabIndex={-1}
        onClick={(e) => { if (e.target === e.currentTarget) { clearSelection(); e.currentTarget.focus(); } }}
        onKeyDown={handleListKey}
        onContextMenu={(e) => openMenu(e, null)}>
        {loading && entries.length === 0 && <div className="muted fmph">加载中…</div>}
        {!loading && entries.length === 0 && !creating && <div className="muted fmph">(空目录)</div>}
        {entries.map((e) => (
          <FmRow
            key={e.name}
            entry={e}
            selected={selection.has(e.name)}
            navLoading={entryPath(e.name) === navLoading}
            renaming={renaming === e.name}
            renameBusy={renameBusy}
            renameDraft={renameDraft}
            onRenameDraft={setRenameDraft}
            onCommitRename={commitRename}
            onCancelRename={() => { setRenaming(null); setRenameDraft(''); }}
            onRowClick={handleRowClick}
            onOpen={openEntry}
            onMenu={openMenu}
            onLongPress={(x, y, item) => openMenuAt(x, y, item)}
          />
        ))}
        {creating && (
          <div className="fmrow">
            <span className="fm-ico">{creating === 'dir' ? '📁' : '📄'}</span>
            <span className="fm-name fm-hide" />
            <span className="fm-time fm-hide" />
            <input className="fm-rename" autoFocus value={createDraft}
              spellCheck={false}
              onChange={(ev) => setCreateDraft(ev.target.value)}
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
                if (ev.nativeEvent.isComposing) return;
                if (ev.key === 'Enter') commitCreate();
                else if (ev.key === 'Escape') cancelCreate();
              }}
              onBlur={commitCreate} />
          </div>
        )}
      </div>

      {/* 多选模式操作条:触屏批量操作入口(复制/传到远程/删除) */}
      {selectMode && selection.size > 0 && (
        <div className="fm-selbar">
          <span className="muted sm">已选 {selection.size} 项</span>
          <button className="ghost sm" onClick={doCopy}>📋 复制</button>
          <button className="ghost sm" disabled={transferring || !remoteCwd} onClick={doTransferToRemote}>⬆ 传到远程</button>
          <button className="danger sm" disabled={!!deleting} onClick={doDelete}>🗑 删除</button>
        </div>
      )}

      <div className="muted sm" style={{ paddingTop: 6 }}>单击选中 · Ctrl/Shift 多选 · 双击打开 · F2 重命名 · 右键操作 · 传到远程当前目录</div>

      {menu && createPortal(
        <div ref={menuRef} className="ctxmenu" style={{ left: menu.x, top: menu.y }} onContextMenu={(e) => e.preventDefault()}>
          {menu.item && selection.size === 1 && menu.item.type === 'dir' && (
            <button onClick={() => { const p = entryPath(menu.item!.name); closeMenu(); load(p, { itemPath: p }); }}><span className="ctx-ico">📂</span>打开</button>
          )}
          {menu.item && selection.size === 1 && menu.item.type !== 'dir' && (
            <button onClick={() => { closeMenu(); onOpenLocalFile(entryPath(menu.item!.name)); }}><span className="ctx-ico">📄</span>打开</button>
          )}
          {menu.item && (
            <button onClick={() => { closeMenu(); doTransferToRemote(); }}><span className="ctx-ico">⬆</span>传到远程当前目录{opCount > 1 ? `(${opCount} 项)` : ''}</button>
          )}
          {menu.item && (
            <button onClick={() => { closeMenu(); doCopy(); }}><span className="ctx-ico">📋</span>复制{opCount > 1 ? `(${opCount} 项)` : ''}</button>
          )}
          {menu.item && (
            <button onClick={() => { closeMenu(); doCopyPath(); }}><span className="ctx-ico">🔗</span>复制路径{opCount > 1 ? `(${opCount} 项)` : ''}</button>
          )}
          {menu.item && (
            <button onClick={() => { closeMenu(); doCopyName(); }}><span className="ctx-ico">📝</span>复制文件名{opCount > 1 ? `(${opCount} 项)` : ''}</button>
          )}
          {menu.item && selection.size === 1 && !deleting && (
            <button onClick={() => startRename(menu.item!.name)}><span className="ctx-ico">✏️</span>重命名</button>
          )}
          {clipboard ? (
            <button onClick={() => { closeMenu(); pasteHere(path); }}><span className="ctx-ico">📥</span>粘贴到此处</button>
          ) : (
            <button disabled data-tip="先右键复制文件/文件夹,再到这里粘贴"><span className="ctx-ico">📥</span>粘贴到此处</button>
          )}
          {menu.item && (
            <>
              <div className="ctx-sep" />
              <button className="danger" disabled={!!deleting} onClick={() => { closeMenu(); doDelete(); }}><span className="ctx-ico">🗑</span>删除{opCount > 1 ? `(${opCount} 项)` : ''}</button>
              <div className="ctx-sep" />
              <button onClick={() => startCreate('file')}><span className="ctx-ico">📄</span>新建文件</button>
              <button onClick={() => startCreate('dir')}><span className="ctx-ico">📁</span>新建文件夹</button>
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}