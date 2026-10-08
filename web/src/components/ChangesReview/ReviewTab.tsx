// 右侧栏「文件变更对比」标签页:表头(文件选择器 + 增删统计 + 统一/并排 + 换行 + 打开整个文件)
// + 正文(FileDiff)。规格逐条对齐 dsh 的 ui-deliverables/ReviewTab:
//   表头高 38px、底边 0.5px、选择器按钮高 28px、工具按钮 28×28 / 图标 15px、
//   并排切换在选中时把对比图标转 90°、路径单行省略、`+N` 绿 `-M` 红。
//
// 两条链路要分清(用户明确提过):
//   - 本标签页 = **变更对比**(只读,看改动前后);
//   - 「打开整个文件」按钮 = 另一条链路,交给外层在**文件查看器/编辑器**里打开。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import FileDiff, { type DiffView } from './FileDiff';
import type { ChangesSummary, WorkspaceFileDiff } from './types';
import './ChangesReview.scss';

type Load<T> = { state: 'loading' } | { state: 'ok'; data: T } | { state: 'missing' } | { state: 'error'; message: string };

interface Props {
  /** 会话 id(变更记录按会话 + 轮归档) */
  sid: string | null;
  /** 内容身份 = 文件绝对路径(同一文件只会有一个对比标签) */
  path: string;
  /** 打开时指定的轮号;缺省则让服务端在最近若干轮里找这个文件 */
  turn?: number;
  /** 该标签此刻是否可见(不可见时暂停拉取) */
  active?: boolean;
  /** 在文件查看器里打开整个文件(另一条链路:可编辑的查看器) */
  onOpenWholeFile?: (path: string, local: boolean) => void;
  /** 关闭本标签(右栏自带的关闭按钮) */
  onClose?: () => void;
}

const VIEW_KEY = 'teleforge.changes-review.view.v1';
const WRAP_KEY = 'teleforge.changes-review.wrap.v1';

const readView = (): DiffView => {
  try { return localStorage.getItem(VIEW_KEY) === 'split' ? 'split' : 'unified'; } catch { return 'unified'; }
};
const readWrap = (): boolean => {
  try { return localStorage.getItem(WRAP_KEY) === '1'; } catch { return false; }
};

/** 只取路径最后一段(文件名),兼容 / 与 \ */
function baseName(p: string): string {
  const t = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  return i >= 0 ? t.slice(i + 1) : t;
}

/** 相对路径(在工作区内时去掉工作区前缀,便于阅读);工作区未知/不在其内则原样返回 */
export function relativize(path: string, workspace?: string | null): string {
  if (!workspace) return path;
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const p = norm(path);
  const w = norm(workspace);
  if (!w || p === w) return path;
  return p.startsWith(w + '/') ? p.slice(w.length + 1) : path;
}

export default function ReviewTab({ sid, path, turn, active = true, onOpenWholeFile, onClose }: Props) {
  const [summary, setSummary] = useState<Load<{ summary: ChangesSummary; index: number }>>({ state: 'loading' });
  const [index, setIndex] = useState<number>(0);
  const [diff, setDiff] = useState<Load<WorkspaceFileDiff>>({ state: 'loading' });
  const [view, setView] = useState<DiffView>(readView);
  const [wrap, setWrap] = useState<boolean>(readWrap);
  const [pickOpen, setPickOpen] = useState(false);
  const pickRef = useRef<HTMLDivElement | null>(null);

  const setViewPersist = (v: DiffView) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* 隐私模式:不持久化 */ } };
  const setWrapPersist = (v: boolean) => { setWrap(v); try { localStorage.setItem(WRAP_KEY, v ? '1' : '0'); } catch { /* 同上 */ } };

  // 拉本轮清单:优先按 (sid, turn);没有 turn(从变更卡直接点进来但 meta 缺轮号)时让服务端回找 ——
  // 缺 turn 只可能出现在旧会话上,回找失败就显示「已不可用」,而不是留一片空白
  const loadSummary = useCallback(async () => {
    if (!sid) { setSummary({ state: 'error', message: '没有关联会话' }); return; }
    setSummary({ state: 'loading' });
    try {
      const r = await api.request('changes_find', { sid, path, turn }, 20000, 'changes_find');
      if (!r?.found || !r.summary) { setSummary({ state: 'missing' }); return; }
      setSummary({ state: 'ok', data: { summary: r.summary as ChangesSummary, index: Number(r.index) || 0 } });
      setIndex(Number(r.index) || 0);
    } catch (e) {
      setSummary({ state: 'error', message: (e as Error)?.message || '拉取变更清单失败' });
    }
  }, [sid, path, turn]);

  useEffect(() => { if (active) void loadSummary(); }, [active, loadSummary]);

  // 拉单文件对比:index / 会话 / 轮变化时重拉
  useEffect(() => {
    if (!active || summary.state !== 'ok') return;
    let alive = true;
    setDiff({ state: 'loading' });
    api.request('changes_diff', { sid, turn: summary.data.summary.turn, index }, 20000, 'changes_diff')
      .then((r) => { if (!alive) return; setDiff(r?.diff ? { state: 'ok', data: r.diff as WorkspaceFileDiff } : { state: 'missing' }); })
      .catch((e) => { if (alive) setDiff({ state: 'error', message: (e as Error)?.message || '拉取对比失败' }); });
    return () => { alive = false; };
  }, [active, sid, index, summary]);

  // 文件选择器:点击外部 / Esc 关闭
  useEffect(() => {
    if (!pickOpen) return;
    const onDown = (e: PointerEvent) => { if (!pickRef.current?.contains(e.target as Node)) setPickOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickOpen(false); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey); };
  }, [pickOpen]);

  const files = summary.state === 'ok' ? summary.data.summary.files : [];
  const cur = files.find((f) => f.index === index);
  // 相对路径:服务端给的是绝对路径,能推断工作区前缀就去掉(仅展示用)
  const display = useMemo(() => (cur ? relativize(cur.path, guessWorkspace(cur.path, files)) : baseName(path)), [cur, files, path]);
  const local = useMemo(() => /^[A-Za-z]:[\\/]/.test(cur?.path || path), [cur, path]);

  return (
    <div className="cr-root">
      <div className="cr-head">
        <div className="cr-selector" ref={pickRef}>
          <button type="button" className="cr-selector-btn" aria-haspopup="listbox" aria-expanded={pickOpen}
            data-tip={cur?.path || path}
            onClick={() => setPickOpen((v) => !v)}>
            <span className="cr-selector-label">{display}</span>
            {cur && <span className="cr-counts">
              {cur.added > 0 && <span className="cr-added">+{cur.added}</span>}
              {cur.deleted > 0 && <span className="cr-deleted">-{cur.deleted}</span>}
              {cur.added === 0 && cur.deleted === 0 && <span className="cr-kind">{KIND_LABEL[cur.kind]}</span>}
            </span>}
            <span className="cr-caret" aria-hidden>▾</span>
          </button>
          {pickOpen && files.length > 0 && (
            <ul className="cr-pick" role="listbox">
              {files.map((f) => (
                <li key={f.index}>
                  <button type="button" role="option" aria-selected={f.index === index}
                    className={`cr-pick-item${f.index === index ? ' on' : ''}`}
                    onClick={() => { setIndex(f.index); setPickOpen(false); }}>
                    <span className="cr-pick-path">{relativize(f.path, guessWorkspace(f.path, files))}</span>
                    <span className="cr-counts">
                      {f.added > 0 && <span className="cr-added">+{f.added}</span>}
                      {f.deleted > 0 && <span className="cr-deleted">-{f.deleted}</span>}
                      <span className="cr-kind">{KIND_LABEL[f.kind]}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="cr-tools">
          <button type="button" className="cr-tool" aria-pressed={view === 'split'}
            data-tip={view === 'split' ? '改为统一视图' : '改为并排对比'}
            aria-label={view === 'split' ? '改为统一视图' : '改为并排对比'}
            onClick={() => setViewPersist(view === 'split' ? 'unified' : 'split')}>
            <IconCompare size={15} />
          </button>
          <button type="button" className="cr-tool" aria-pressed={wrap}
            data-tip={wrap ? '取消自动换行' : '自动换行'}
            aria-label={wrap ? '取消自动换行' : '自动换行'}
            onClick={() => setWrapPersist(!wrap)}>
            <IconWrap size={15} />
          </button>
          {onOpenWholeFile && (
            <button type="button" className="cr-tool" data-open-whole
              data-tip="在文件查看器里打开整个文件" aria-label="在文件查看器里打开整个文件"
              onClick={() => onOpenWholeFile(cur?.path || path, local)}>
              <IconExternal size={15} />
            </button>
          )}
          {onClose && (
            <button type="button" className="cr-tool" aria-label="关闭对比" onClick={onClose}>
              <span aria-hidden>✕</span>
            </button>
          )}
        </div>
      </div>

      <div className="cr-main">
        {summary.state === 'loading' && <p className="cr-status">正在读取本轮变更…</p>}
        {summary.state === 'error' && (
          <div className="cr-status cr-status-error">
            <p>{summary.message}</p>
            <button type="button" className="cr-retry" onClick={() => void loadSummary()}>重试</button>
          </div>
        )}
        {summary.state === 'missing' && (
          <p className="cr-status">这一轮没有可对比的改动记录(旧会话不记录改动前内容,或记录已被清理)</p>
        )}
        {summary.state === 'ok' && (
          <>
            {diff.state === 'loading' && <p className="cr-status">正在计算对比…</p>}
            {diff.state === 'error' && (
              <div className="cr-status cr-status-error">
                <p>{diff.message}</p>
                <button type="button" className="cr-retry" onClick={() => setIndex((i) => i)}>重试</button>
              </div>
            )}
            {diff.state === 'missing' && <p className="cr-status">该文件的对比已不可用(记录已被清理)</p>}
            {diff.state === 'ok' && (
              diff.data.kind === 'text'
                ? <FileDiff diff={diff.data} view={view} wrap={wrap} />
                : <p className="cr-status">{diff.data.kind === 'binary' ? '二进制文件,不展示逐行对比' : '文件超过 2MB,不展示逐行对比'}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { create: '新建', write: '覆盖', edit: '修改', delete: '删除' };

/**
 * 猜工作区前缀,只为**展示**相对路径:
 * 本轮多个文件都在同一个前缀下时,把这个公共前缀当成工作区;只有单个文件时不做裁剪
 * (宁可为空,也不要截错给别人看的路径)。
 */
function guessWorkspace(path: string, all: { path: string }[]): string | null {
  if (all.length < 2) return null;
  const sep = (p: string) => (p.includes('\\') ? '\\' : '/');
  const prefix = (p: string) => { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i > 0 ? p.slice(0, i) : ''; };
  let pre = prefix(path);
  for (const f of all) {
    while (pre && !f.path.startsWith(pre)) pre = prefix(pre);
    if (!pre) return null;
  }
  return pre ? pre + sep(path) : null;
}

/* ---- 图标(15px,与 dsh 的工具按钮尺寸一致;不引外部图标库,内联 SVG) ---- */
function IconCompare({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="cr-ico-compare">
      <rect x="1.5" y="2.5" width="5" height="11" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="9.5" y="2.5" width="5" height="11" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
function IconWrap({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M1.5 4h9a2.5 2.5 0 0 1 0 5H5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M7 7.2 5 9l2 1.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M1.5 12h13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function IconExternal({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M6 3.5H3.5v9h9V10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M9 3.5h3.5V7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 3.5 8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
