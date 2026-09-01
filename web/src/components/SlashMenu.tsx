// SlashMenu:对话输入框的 / 命令菜单(照搬 deepseek-harness 的行内命令交互)
// - 输入 / 后弹出命令候选(系统命令 + 技能)
// - 继续输入字母做即时过滤:前缀匹配最优先,其余按模糊顺序子序列评分排序(对齐 harness fuzzyCandidates)
// - ↑↓ 移动高亮、Enter 选中、Esc 关闭、Tab 补全首个候选
//
// 命令模型(对齐 harness CommandDescriptor):name(不含斜杠) + description 摘要。
// 系统命令由宿主注册;技能命令来自技能目录(模型可调用者注入,与 harness skill trigger 一致)。

export interface SlashItem {
  name: string;
  description: string;
  /** 命令种类:系统命令(compact/fork/clear 等)或技能 */
  kind: 'command' | 'skill';
  /** 选中后回调:返回 true 表示命令已消费(= harness dispatch),false 表示仅补全文本 */
  run?: (query: string) => boolean | void | Promise<boolean | void>;
}

export interface SlashMenuProps {
  /** 命令候选(打开时若为空会自动合并外部提供的技能) */
  items: SlashItem[];
  /** 当前过滤词(不含斜杠;空 = 列出全部) */
  query: string;
  /** 高亮索引(-1 = 无高亮) */
  active: number;
  /** Enter 选中 / 点击选中 */
  onPick: (item: SlashItem, query: string) => void;
  /** Esc 关闭或外部点击 */
  onClose: () => void;
  onActiveChange: (i: number) => void;
}

/** 对齐 harness fuzzyCandidates:前缀匹配优先,其后按模糊顺序子序列评分排序 */
export function rankSlashItems(items: SlashItem[], rawQuery: string): SlashItem[] {
  const q = rawQuery.toLowerCase();
  if (!q) return items;
  const score = (name: string): number | null => {
    const n = name.toLowerCase();
    if (n === q) return 1e9;                 // 完全命中
    if (n.startsWith(q)) return 1e8 - n.length; // 前缀命中(短的靠前)
    // 模糊:按顺序子序列计分(连续/靠前加分),不匹配返回 null
    let idx = 0;
    let s = 0;
    for (const ch of q) {
      const found = n.indexOf(ch, idx);
      if (found < 0) return null;
      if (found === idx) s += 8; else s += 8 - Math.min(7, found - idx);
      idx = found + 1;
    }
    return s - n.length * 0.1;
  };
  const ranked: { item: SlashItem; s: number }[] = [];
  for (const it of items) {
    const s = score(it.name);
    if (s !== null) ranked.push({ item: it, s });
  }
  return ranked.sort((a, b) => b.s - a.s).map((r) => r.item);
}

export default function SlashMenu({ items, query, active, onPick, onClose, onActiveChange }: SlashMenuProps) {
  const list = rankSlashItems(items, query);
  const shown = list.slice(0, 50); // 候选行上限,避免超长目录压垮菜单
  return (
    <div className="slash-menu" role="listbox" aria-label="命令菜单">
      {shown.length === 0 ? (
        <div className="slash-empty">没有匹配的命令或技能 · Esc 关闭</div>
      ) : shown.map((it, i) => (
        <button
          key={`${it.kind}:${it.name}`}
          type="button"
          role="option"
          aria-selected={i === active}
          className={`slash-item ${i === active ? 'on' : ''}`}
          onMouseEnter={() => onActiveChange(i)}
          onClick={() => onPick(it, query)}
        >
          <span className={`slash-badge ${it.kind}`}>/{it.name}</span>
          <span className="slash-desc">{it.description || (it.kind === 'skill' ? '技能' : '命令')}</span>
        </button>
      ))}
    </div>
  );
}