// 文件对比的渲染本体(统一视图 / 左右并排),样式规格逐条对齐 dsh 的 ui-deliverables/FileDiff:
//   - 行高 22px、行号槽 3.5em、统一视图 4 列(旧行号/新行号/符号/正文);
//   - 并排:B 两列各 3.5em + 正文,中间 0.5px 竖线,左右**同步横向滚动**;
//   - hunk 头 `@@ -a,b +c,d @@`、块间距 8px、正文左右 padding 16px;
//   - 新增/删除行:整行底色 + 行号槽更深底色 + 首行号槽左侧 3px 标记色(inset box-shadow);
//   - 高亮用 shiki 双主题(见 utils/shiki.ts),暗色由 CSS 的 --shiki-dark 覆盖,切主题不重算。
// 注意:这里**只读**。文件列表打开的代码编辑器是另一条链路(FileViewer,可编辑),
// 两者不要混用 —— 变更对比要的是「改动前后并看」,不是「编辑当前内容」。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { highlightLines, langForPath, type HighlightSpan } from '../../utils/shiki';
import { diffCounts, hunkHeader, hunkRows, renderPlan, splitRows } from './diffRows';
import type { DiffHunk, WorkspaceFileDiff } from './types';

export type DiffView = 'unified' | 'split';

/** 双侧行号 → 高亮片段的映射(行号在文件内唯一,所以一个 Map 就够) */
type SpanMap = Map<number, HighlightSpan[]>;

interface Props {
  diff: Extract<WorkspaceFileDiff, { kind: 'text' }>;
  view: DiffView;
  wrap: boolean;
}

/** 统一视图里某一行的底色类名 */
const rowClass = (kind: 'add' | 'del' | 'context') => `cr-line cr-${kind}`;

export default function FileDiff({ diff, view, wrap }: Props) {
  const plan = useMemo(() => renderPlan(diff.hunks), [diff.hunks]);
  const [spans, setSpans] = useState<{ old: SpanMap; new: SpanMap }>({ old: new Map(), new: new Map() });
  const lang = useMemo(() => langForPath(diff.display || diff.path), [diff.display, diff.path]);

  // 两侧各自拼成代码块交给 shiki(与 dsh 同一手法:按行号回填,天然对齐)。
  // 只在 diff/语言变化时重算;高亮是异步的,期间先渲染纯文本。
  useEffect(() => {
    let alive = true;
    const oldSource: { no: number; text: string }[] = [];
    const newSource: { no: number; text: string }[] = [];
    for (const h of plan.hunks) {
      for (const row of hunkRows(h)) {
        if (row.old !== undefined) oldSource.push({ no: row.old, text: row.text });
        if (row.new !== undefined) newSource.push({ no: row.new, text: row.text });
      }
    }
    setSpans({ old: new Map(), new: new Map() });
    (async () => {
      const [oldLines, newLines] = await Promise.all([
        highlightLines(oldSource.map((l) => l.text).join('\n'), lang),
        highlightLines(newSource.map((l) => l.text).join('\n'), lang)
      ]);
      if (!alive) return;
      const toMap = (src: { no: number; text: string }[], hl: HighlightSpan[][] | null): SpanMap => {
        const m: SpanMap = new Map();
        if (!hl) return m;
        src.forEach((line, i) => {
          // shiki 对末尾空行可能少一行:缺的按空片段处理,保证行号不错位
          const got = hl[i] ?? [{ text: line.text }];
          m.set(line.no, got.length === 1 && got[0].text === '' ? [] : got);
        });
        return m;
      };
      setSpans({ old: toMap(oldSource, oldLines), new: toMap(newSource, newLines) });
    })();
    return () => { alive = false; };
  }, [diff, lang, plan]);

  const counts = useMemo(() => diffCounts(diff.hunks), [diff.hunks]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // 并排两列同步横向滚动:同步时不回写触发方(否则会互相打架);换行模式下横向没有滚动,无需同步
  const splitRef = useRef<HTMLDivElement | null>(null);
  const onSplitScroll = (from: HTMLElement) => {
    const root = splitRef.current;
    if (!root || wrap) return;
    const cols = root.querySelectorAll<HTMLElement>('[data-cr-col]');
    cols.forEach((c) => { if (c !== from) c.scrollLeft = from.scrollLeft; });
  };

  const note = diff.hunks.length === 0
    ? '内容未变化'
    : diff.coarse
      ? '文件较大或行比较超时:已退化为「整段删除 + 整段新增」的粗粒度对比'
      : null;

  const renderSpans = (list: HighlightSpan[] | undefined, fallback: string) => {
    if (!list || list.length === 0) return <span className="cr-text">{fallback}</span>;
    return (
      <span className="cr-text">
        {list.map((s, i) => <span key={i} style={s.style}>{s.text}</span>)}
      </span>
    );
  };

  return (
    <div className="cr-diff" data-view={view} data-wrap={wrap ? '1' : undefined}>
      {note && <p className="cr-note">{note}</p>}
      <div className="cr-body" ref={bodyRef}>
        {plan.hunks.map((h: DiffHunk, hi: number) => (
          <section className="cr-hunk" key={hi}>
            <div className="cr-hunk-head">{hunkHeader(h)}</div>
            {view === 'split' ? (
              <div className="cr-split" ref={hi === 0 ? splitRef : undefined}>
                {splitRows(h).map((row, i) => (
                  <div className="cr-split-line" key={i}>
                    {(['left', 'right'] as const).map((side) => {
                      const cell = row[side];
                      const gutter = side === 'left' ? 'del' : 'add';
                      return (
                        <div key={side} data-cr-col
                          className={`cr-cell${cell ? ' cr-' + cell.kind : ' cr-empty'}`}
                          onScroll={(e) => onSplitScroll(e.currentTarget)}>
                          <span className={`cr-no cr-no-${gutter}`}>{cell?.no ?? ''}</span>
                          {cell ? renderSpans(spans[side === 'left' ? 'old' : 'new'].get(cell.no), cell.text) : <span className="cr-text" />}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            ) : (
              hunkRows(h).map((row, i) => (
                <div className={rowClass(row.kind)} key={i}>
                  <span className={`cr-no cr-no-${row.kind === 'add' ? 'add' : row.kind === 'del' ? 'del' : 'ctx'}`}>{row.old ?? ''}</span>
                  <span className={`cr-no cr-no-${row.kind === 'add' ? 'add' : row.kind === 'del' ? 'del' : 'ctx'}`}>{row.new ?? ''}</span>
                  <span className="cr-sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}</span>
                  {renderSpans((row.kind === 'add' ? spans.new : spans.old).get((row.kind === 'add' ? row.new : row.old) ?? -1), row.text)}
                </div>
              ))
            )}
          </section>
        ))}
      </div>
      {plan.truncated && (
        <p className="cr-note">对比过长,已省略中间 {plan.omitted} 行(单次最多渲染 5000 行)</p>
      )}
      <span className="cr-visually-hidden">新增 {counts.added} 行,删除 {counts.deleted} 行</span>
    </div>
  );
}
