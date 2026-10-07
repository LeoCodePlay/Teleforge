// @deepseek-ai/dsh-api-workspace-files/types 的适配(类型面)。
// 目录列举与文件变更监听的条目结构。本项目的 list_dir / list_local_dir 返回同构数据,
// 接线时在这里做一次字段映射即可(远端 FsEntry → WorkspaceDirectoryEntry)。
export interface WorkspaceDirectoryEntry {
  readonly name: string;
  readonly path: string;
  /** dsh 用 type(不是 kind):orderEntries 判的是 entry.type === 'directory' */
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
  readonly size?: number;
  readonly modifiedAt?: number;
}
export interface WorkspaceFileWatchFrame {
  /** face.ts 用 value.kind 区分「就绪」与「有变更」 */
  readonly kind: 'ready' | 'change';
  readonly paths?: readonly string[];
}
