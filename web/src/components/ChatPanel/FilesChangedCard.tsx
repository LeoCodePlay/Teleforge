// AI 回复下方的「N 个文件已更改」长条卡片:
// 折叠态 = 一行胶囊(左图标 + 「N 个文件已更改」+ 右侧箭头),点击展开文件列表;
// 每行 = 文件名(左)· 相对路径(中,省略截断)· 变更类型标签 · 变更行数(右,+新增/-删除)。
// 数据来自当前回复中 write/edit/delete 工具调用(远程/本地)的 card='diff' meta,
// 由 ChatPanel.collectFileChanges 聚合挂到消息的 filesChanged 字段。

import React, { memo, useState } from 'react';
import type { FileChangeItem } from '../../types';
import { IconChevronDownOutline14, IconEditOutline16 } from '../icons/icons';
import { relativizeToCwd } from '../../utils/toolRowModel';
import './FilesChangedCard.scss';

const KIND_LABELS: Record<FileChangeItem['kind'], string> = {
  create: '新建',
  write: '覆盖',
  edit: '修改',
  delete: '删除',
};

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
export const FilesChangedCard = memo(function FilesChangedCard({ items, workspace }: { items: FileChangeItem[]; workspace?: string }) {
  const [open, setOpen] = useState(false);
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
            return (
              <li key={it.path} className="fcc-item" title={it.path}>
                <span className="fcc-name">{baseName(it.path)}</span>
                <span className="fcc-path">{rel}</span>
                <span className={`fcc-kind kind-${it.kind}`}>{KIND_LABELS[it.kind]}</span>
                <LineDelta item={it} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});