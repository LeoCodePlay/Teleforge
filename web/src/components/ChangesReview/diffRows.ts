// 变更对比的**行模型**(纯函数,无 DOM、无框架):
// 把服务端给的 hunk(每行带 '+'/'-'/' ' 前缀,与 dsh 同构)摊成两种视图需要的行,
// 并施加单次渲染的行数预算。
//
// 为什么单独一个纯模块:编号规则(旧/新双侧行号)与并排配对规则最容易出错,而它们与 React
// 完全无关 —— 放这里可以穷举单测(见 test/changes-diff-rows.test.js),组件里只做绘制。
// 算法逐条对齐 deepseek-harness 的 ui-deliverables/src/client/FileDiff.tsx(hunkRows/splitRows)。

import type { DiffHunk } from './types';

export type { DiffHunk };

/** 单次对比最多渲染多少行:超出即截断(与 dsh 的 MAX_RENDERED_LINES 一致) */
export const MAX_RENDERED_LINES = 5000;

/** 统一视图的一行:带旧/新两侧行号(另一侧为 undefined) */
export interface DiffRow {
  kind: 'add' | 'del' | 'context';
  old: number | undefined;
  new: number | undefined;
  text: string;
}

/** 并排视图的一行:左(旧)/右(新)各一格,可能只有一侧 */
export interface SplitRow {
  left?: { no: number; text: string; kind: 'del' | 'context' };
  right?: { no: number; text: string; kind: 'add' | 'context' };
}

/**
 * 给 hunk 的每行编号:上下文两侧都算,删除只算旧侧,新增只算新侧。
 * @param hunk 服务端 hunk
 * @returns 顺序不变的行数组
 */
export function hunkRows(hunk: DiffHunk): DiffRow[] {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  return hunk.lines.map((line) => {
    const text = line.slice(1);
    switch (line[0]) {
      case '+': return { kind: 'add', old: undefined, new: newNo++, text };
      case '-': return { kind: 'del', old: oldNo++, new: undefined, text };
      default: return { kind: 'context', old: oldNo++, new: newNo++, text };
    }
  });
}

/**
 * 并排视图配对:一段连续的删除与紧随其后的一段新增**逐行对齐**,上下文两侧同排。
 * 删多增少(或反之)时短的一侧留空,表现为「空侧底色」。
 * @param hunk 服务端 hunk
 * @returns 并排行数组
 */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: NonNullable<SplitRow['left']>[] = [];
  let adds: NonNullable<SplitRow['right']>[] = [];
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ left: dels[i], right: adds[i] });
    dels = [];
    adds = [];
  };
  for (const line of hunk.lines) {
    const text = line.slice(1);
    const ch = line[0];
    if (ch === '-') { dels.push({ no: oldNo++, text, kind: 'del' }); continue; }
    if (ch === '+') { adds.push({ no: newNo++, text, kind: 'add' }); continue; }
    // 上下文行:先把挂起的删除/新增配对落下来,再两侧同排
    flush();
    rows.push({ left: { no: oldNo++, text, kind: 'context' }, right: { no: newNo++, text, kind: 'context' } });
  }
  flush();
  return rows;
}

/** 行数预算结果 */
export interface RenderPlan {
  /** 实际要渲染的 hunk(可能最后一个被截断) */
  hunks: DiffHunk[];
  /** 是否发生截断 */
  truncated: boolean;
  /** 被省略的行数(未截断为 0) */
  omitted: number;
}

/**
 * 施加总行数预算(head + tail 各留一半,与 dsh「头尾都留」的取向一致):
 * 超长对比只渲染开头与结尾,中间省略并在界面提示。
 * @param hunks 全部 hunk
 * @param max 行数上限
 */
export function renderPlan(hunks: DiffHunk[], max: number = MAX_RENDERED_LINES): RenderPlan {
  const total = hunks.reduce((n, h) => n + h.lines.length, 0);
  if (total <= max) return { hunks, truncated: false, omitted: 0 };
  const headBudget = Math.ceil(max / 2);
  const tailBudget = max - headBudget;
  const head: DiffHunk[] = [];
  const tail: DiffHunk[] = [];
  let used = 0;
  for (const h of hunks) {
    if (used + h.lines.length <= headBudget) { head.push(h); used += h.lines.length; continue; }
    const room = headBudget - used;
    if (room > 0) { head.push({ ...h, lines: h.lines.slice(0, room) }); used += room; }
    break;
  }
  used = 0;
  for (let i = hunks.length - 1; i >= 0; i--) {
    const h = hunks[i];
    if (used + h.lines.length <= tailBudget) { tail.unshift(h); used += h.lines.length; continue; }
    const room = tailBudget - used;
    if (room > 0) tail.unshift({ ...h, lines: h.lines.slice(h.lines.length - room) });
    break;
  }
  const kept = head.reduce((n, h) => n + h.lines.length, 0) + tail.reduce((n, h) => n + h.lines.length, 0);
  return { hunks: [...head, ...tail], truncated: true, omitted: Math.max(0, total - kept) };
}

/** hunk 头文案:与统一 diff 的 @@ 行同形 */
export function hunkHeader(h: DiffHunk): string {
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
}

/** 单个对比的增删行数(从 hunk 前缀统计,供文件选择器与表头用) */
export function diffCounts(hunks: DiffHunk[]): { added: number; deleted: number } {
  let added = 0, deleted = 0;
  for (const h of hunks) for (const l of h.lines) {
    if (l[0] === '+') added++;
    else if (l[0] === '-') deleted++;
  }
  return { added, deleted };
}
