// 变更对比的前端类型:与服务端 server/changes/store.ts 的返回**逐字段对齐**(改一处两处都要改)。
// 之所以手写而不是自动生成:这套结构同时被 dsh 与 Teleforge 用,保持字面对齐才能在两侧互相参照。

/** 服务端下发的 hunk:每行保留 '+'/'-'/' ' 前缀(与 dsh 的 WorkspaceDiffHunk 同构) */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** 单个文件的对比结果:三态(文本 / 二进制 / 超大) */
export type WorkspaceFileDiff =
  | { kind: 'text'; path: string; display: string; before: boolean; after: boolean; hunks: DiffHunk[]; coarse: boolean }
  | { kind: 'binary' }
  | { kind: 'oversized' };

/** 本轮某个文件的概要(文件选择器与表头用它,不必先拉 diff) */
export interface ChangeFileBrief {
  index: number;
  path: string;
  kind: 'create' | 'write' | 'edit' | 'delete';
  added: number;
  deleted: number;
  binary: boolean;
  oversized: boolean;
}

/** 本轮变了哪些文件 */
export interface ChangesSummary {
  turn: number;
  files: ChangeFileBrief[];
  added: number;
  deleted: number;
  total: number;
}
