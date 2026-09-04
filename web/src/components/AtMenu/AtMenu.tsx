// AtMenu:对话输入框的 @ 文件/文件夹引用菜单(与 / 命令菜单并行的行内交互)
// - 输入 @ 后弹出候选(远程 + 本地工作区,有界扁平化遍历,见 server ref_candidates)
// - 继续输入字母做即时过滤:复用 / 菜单同款名称排序(前缀优先 + 模糊子序列评分)
// - ↑↓ 移动高亮、Enter/Tab 选中、Esc 关闭
// 选中条目在输入框显示为 @文件名/文件夹名;发送时由 ChatPanel 替换为 @source:完整路径。
import { rankByName } from '../SlashMenu/SlashMenu';
import './AtMenu.scss';

export interface AtCandidate {
  name: string;            // 显示名(文件名/文件夹名)
  path: string;            // 完整路径(发送给 AI 时 @source:path 的 path)
  type: 'dir' | 'file' | 'link';
  source: 'remote' | 'local';
}

export interface AtMenuProps {
  /** 候选(打开时为空说明尚未拉取;远程/本地都未选择工作区时为空列表) */
  items: AtCandidate[];
  /** 候选是否仍在拉取中(首次 @ 时异步加载) */
  loading?: boolean;
  /** 当前过滤词(不含 @;空 = 列出全部) */
  query: string;
  /** 高亮索引(-1 = 无高亮) */
  active: number;
  onPick: (item: AtCandidate, query: string) => void;
  onClose: () => void;
  onActiveChange: (i: number) => void;
}

const MAX_SHOWN = 60; // 候选行上限,避免超长目录压垮菜单

export default function AtMenu({ items, query, active, loading = false, onPick, onClose, onActiveChange }: AtMenuProps) {
  const list = rankByName(items, query);
  const shown = list.slice(0, MAX_SHOWN);
  return (
    <div className="at-menu" role="listbox" aria-label="文件引用菜单">
      {loading ? (
        <div className="at-empty">正在列出目录文件…</div>
      ) : items.length === 0 ? (
        <div className="at-empty">暂无可用文件 —— 请在左侧文件面板打开一个目录 · Esc 关闭</div>
      ) : shown.length === 0 ? (
        <div className="at-empty">没有匹配的文件或文件夹 · Esc 关闭</div>
      ) : shown.map((it, i) => (
        <button
          key={`${it.source}:${it.path}`}
          type="button"
          role="option"
          aria-selected={i === active}
          className={`at-item ${i === active ? 'on' : ''}`}
          onMouseEnter={() => onActiveChange(i)}
          onClick={() => onPick(it, query)}
        >
          <span className={`at-badge ${it.source}`}>{it.source === 'remote' ? '远程' : '本地'}</span>
          <span className="at-name">{it.name}{it.type === 'dir' ? '/' : ''}</span>
          <span className="at-path">{it.path}</span>
        </button>
      ))}
    </div>
  );
}
