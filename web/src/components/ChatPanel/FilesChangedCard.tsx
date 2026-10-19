// AI 回复下方的「N 个文件已更改」长条卡片:
// 折叠态 = 一行胶囊(左图标 + 「N 个文件已更改」+ 右侧箭头),点击展开文件列表;
// 每行 = 文件名(左)· 相对路径(中,省略截断)· 变更类型标签 · 变更行数(右,+新增/-删除)。
// 行内两个点击区职责不同:**文件名** = 打开文件(远程走 onOpenFile、本机走 onOpenLocalFile,
// 复用文件标签页的查看方式,与在文件管理器里点开文件一致);**路径** = 复制完整路径
// (与文件管理器「复制路径」同口径,复制后原地短暂显示「已复制」)。
// 已删除的文件已不在磁盘上,文件名灰显、不可打开,但路径仍可复制。
// 数据来自当前回复中 write/edit/delete 工具调用(远程/本地)的 card='diff' meta,
// 由 ChatPanel.collectFileChanges 聚合挂到消息的 filesChanged 字段。

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { FileChangeItem } from '../../types';
import { IconChevronDownOutline14, IconEditOutline16 } from '../icons/icons';
import { relativizeToCwd } from '../../utils/toolRowModel';
import { writeClipboard } from '../../dsh/ui-primitives/clipboard.ts';
import './FilesChangedCard.scss';

const KIND_LABELS: Record<FileChangeItem['kind'], string> = {
  create: '新建',
  write: '覆盖',
  edit: '修改',
  delete: '删除',
};

/** 「已复制」提示的停留时长(ms):够看清,又不至于让路径一直不可读 */
const COPY_FEEDBACK_MS = 1200;

// 只取路径最后一段(文件名),兼容 / 与 \ 分隔;根路径原样返回
function baseName(p: string): string {
  const t = p.replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  return i >= 0 ? t.slice(i + 1) : t;
}

// 变更行数片段:+X -Y(为 0 或未知时省略对应侧;两侧都没有显示 -)
function LineDelta({ item }: { item: FileChangeItem }) {
  const parts: React.ReactNode[] = [];
  if (item.addLines > 0) parts.push(<span key="a" className="fcc-delta add">+{item.addLines}</span>);
  if (item.delLines != null && item.delLines > 0) parts.push(<span key="d" className="fcc-delta del">-{item.delLines}</span>);
  if (parts.length === 0) return <span className="fcc-delta none">-</span>;
  return <>{parts}</>;
}

// memo:items 数组引用未变时跳过重渲染(展开/收起为组件内部状态,不受影响),
// 历史消息的「N 个文件已更改」卡不在每次流式/输入重渲染中重复构建
export const FilesChangedCard = memo(function FilesChangedCard({ items, workspace, onOpenFile, onOpenLocalFile, onOpenFileAside, onOpenLocalFileAside, onOpenChanges }: {
  items: FileChangeItem[];
  workspace?: string;
  /** 打开远程文件(由 App 传入:文件标签页 + 远程读取通道) */
  onOpenFile?: (path: string) => void;
  /** 打开本机文件(由 App 传入:文件标签页 + local: 本机读取通道) */
  onOpenLocalFile?: (path: string) => void;
  /** 在**右侧栏**打开远程文件(对照阅读用;未提供则该入口不出现) */
  onOpenFileAside?: (path: string) => void;
  /** 在**右侧栏**打开本机文件 */
  onOpenLocalFileAside?: (path: string) => void;
  /** 查看该文件的**改动对比**(右侧栏 changes-review;与上面「打开文件」是两条链路) */
  onOpenChanges?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // 「已复制」只标在刚点过的那一行:记录行 key,复制成功后才亮,过一会儿自动熄灭
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);
  const copyPath = useCallback((key: string, path: string) => {
    void writeClipboard(path).then((ok) => {
      if (!ok) return;
      setCopiedKey(key);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => {
        setCopiedKey(null);
        copyTimer.current = null;
      }, COPY_FEEDBACK_MS);
    });
  }, []);
  // 组件卸载(如切换会话)时清掉计时器,避免迟到的 setState
  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);
  if (!items || items.length === 0) return null;
  return (
    <div className={`fcc${open ? ' open' : ''}`}>
      <button
        type="button"
        className="fcc-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? '收起文件列表' : '展开文件列表'}
      >
        <span className="fcc-icon"><IconEditOutline16 size={16} /></span>
        <span className="fcc-title">{items.length} 个文件已更改</span>
        <IconChevronDownOutline14 size={14} className={`fcc-chevron${open ? ' flip' : ''}`} />
      </button>
      {open && (
        <ul className="fcc-list">
          {items.map((it) => {
            const rel = relativizeToCwd(it.path, workspace);
            const key = `${it.local ? 'local' : 'remote'}:${it.path}`;
            const handler = it.local ? onOpenLocalFile : onOpenFile;
            // 删除后的文件点开只会读到「文件不存在」,灰显为不可打开;
            // 调用方未提供打开通道时(独立复用组件)同样退化为纯展示
            const canOpen = it.kind !== 'delete' && handler !== undefined;
            // 「在侧栏打开」是**次要**入口:文件名主点击仍是打开到主区域(保持既有习惯不变),
            // 侧栏用于对照阅读(边看对话边看这个文件)。删除后的文件两个入口都不可用。
            const asideHandler = it.local ? onOpenLocalFileAside : onOpenFileAside;
            const canAside = it.kind !== 'delete' && asideHandler !== undefined;
            // 「对比」是新增的主入口之一:看的是**改动前后**(只读 diff),而不是文件当前内容。
            // 删除的文件也允许对比(整段删除同样是有效信息)。
            const canCompare = onOpenChanges !== undefined;
            const copied = copiedKey === key;
            return (
              <li
                key={key}
                className={`fcc-item${canOpen ? ' openable' : ''}${it.kind === 'delete' ? ' deleted' : ''}${canAside ? ' has-aside' : ''}${canCompare ? ' has-compare' : ''}`}
              >
                <div className="fcc-row">
                  {canOpen ? (
                    <button
                      type="button"
                      className="fcc-name fcc-open"
                      data-open-file={it.path}
                      data-tip={`点击打开 ${it.path}`}
                      aria-label={`打开 ${it.path}`}
                      onClick={() => { if (handler) handler(it.path); }}
                    >
                      {baseName(it.path)}
                    </button>
                  ) : (
                    <span
                      className="fcc-name"
                      data-tip={it.kind === 'delete' ? `${it.path}(已删除)` : it.path}
                    >
                      {baseName(it.path)}
                    </span>
                  )}
                  <button
                    type="button"
                    className={`fcc-path${copied ? ' copied' : ''}`}
                    data-copy-path={it.path}
                    data-tip={copied ? '已复制到剪贴板' : `点击复制路径:${it.path}`}
                    aria-label={`复制路径 ${it.path}`}
                    onClick={() => copyPath(key, it.path)}
                  >
                    {copied ? '已复制' : rel}
                  </button>
                  <span className={`fcc-kind kind-${it.kind}`}>{KIND_LABELS[it.kind]}</span>
                  <LineDelta item={it} />
                </div>
                {canCompare && (
                  <button type="button" className="fcc-aside fcc-compare" data-open-diff={it.path}
                    data-tip={`查看 ${it.path} 的改动对比`}
                    aria-label={`查看 ${it.path} 的改动对比`}
                    onClick={() => { if (onOpenChanges) onOpenChanges(it.path); }}>对比</button>
                )}
                {canAside && (
                  <button type="button" className="fcc-aside" data-open-aside={it.path}
                    data-tip={`在右侧栏打开 ${it.path}(对照阅读)`}
                    aria-label={`在右侧栏打开 ${it.path}`}
                    onClick={() => { if (asideHandler) asideHandler(it.path); }}>侧栏</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});
