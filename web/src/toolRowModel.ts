// 工具行纯派生模型(照搬 deepseek-harness ui-tool/models/tool-call-model):
// 从工具名 + 参数 + 结果派生 variant/标题/单行摘要/展开体/输出/状态。
// 前端唯一分类依据,无任何后端依赖。

import type { ToolCallInfo } from './types';

/** 工具行视觉变体(当前工具集 = 远程 + 本地两套) */
export type ToolRowVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'todo' | 'ask' | 'others';

/** 行状态语义 */
export type ToolRowState = 'running' | 'ok' | 'error' | 'stopped';

/** 变体标题(harness figma 字面量) */
export const VARIANT_TITLES: Record<ToolRowVariant, string> = {
  search: 'Search', read: 'Read', bash: 'Bash',
  write: 'Write', edit: 'Edit', code: 'Code',
  todo: 'Todo', ask: 'Ask', others: 'Tool call',
};

/** 工具名 -> 变体映射(harness TOOL_VARIANTS 表,适配本项目工具集) */
const TOOL_VARIANTS: Record<string, ToolRowVariant> = {
  run_command: 'bash', run_local_command: 'bash',
  read_file: 'read', read_local_file: 'read',
  list_directory: 'read', list_local_dir: 'read',
  get_workspace_info: 'read', get_local_info: 'read',
  create_directory: 'others', create_local_dir: 'others',
  delete_path: 'others', delete_local_path: 'others',
  write_file: 'write', write_local_file: 'write',
  edit_file: 'edit', edit_local_file: 'edit',
  search_code: 'search', search_local_code: 'search',
  todo_write: 'todo', ask_user_question: 'ask',
  skill: 'others', available_skills: 'others',
};

/** 工具归属标题(细化变体行) */
const TOOL_TITLES: Record<string, string> = {
  run_command: '运行命令', run_local_command: '本机命令',
  read_file: '读取文件', read_local_file: '读取本机文件',
  list_directory: '列出目录', list_local_dir: '列出本机目录',
  write_file: '写入文件', write_local_file: '写入本机文件',
  edit_file: '编辑文件', edit_local_file: '编辑本机文件',
  search_code: '搜索代码', search_local_code: '搜索本机代码',
  todo_write: '任务计划', ask_user_question: '提问',
  get_workspace_info: '环境信息', get_local_info: '本机环境',
  create_directory: '创建目录', create_local_dir: '创建本机目录',
  delete_path: '删除', delete_local_path: '删除本机',
  skill: '加载技能', available_skills: '技能目录', skill_copy_builtin: '复制内置技能',
  transfer_to_local: '下载到本机', transfer_to_remote: '上传到远程',
};

export function classifyTool(toolName: string): ToolRowVariant {
  return TOOL_VARIANTS[toolName] ?? 'others';
}

function parseArgs(argsRaw?: string | null): Record<string, unknown> | undefined {
  if (!argsRaw) return undefined;
  try {
    const v = JSON.parse(argsRaw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return nl === -1 ? text : text.slice(0, nl);
}

function pickString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/** 摘要偏好键(按变体) */
const SUMMARY_KEYS: Record<ToolRowVariant, string[]> = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  search: ['pattern', 'query', 'path'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  todo: [],
  ask: ['question'],
  others: [],
};

const FILE_PATH_KEYS = ['path', 'file_path'] as const;
const FILE_PATH_VARIANTS: ReadonlySet<ToolRowVariant> = new Set(['read', 'write', 'edit']);

function deriveSummary(variant: ToolRowVariant, argsRaw?: string | null): string {
  const args = parseArgs(argsRaw);
  if (!args) return firstLine(argsRaw || '');
  const picked = pickString(args, SUMMARY_KEYS[variant]);
  if (picked !== undefined) return firstLine(picked);
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v !== '') return firstLine(v);
  }
  return firstLine(argsRaw || '');
}

function deriveFilePath(variant: ToolRowVariant, argsRaw?: string | null): string | undefined {
  if (!FILE_PATH_VARIANTS.has(variant)) return undefined;
  const args = parseArgs(argsRaw);
  if (!args) return undefined;
  return pickString(args, [...FILE_PATH_KEYS]);
}

function deriveBody(variant: ToolRowVariant, argsRaw?: string | null): string | null {
  if (!argsRaw) return null;
  const args = parseArgs(argsRaw);
  if (!args) return argsRaw;
  // 编辑类:展开体直接呈现 old→new 文本对,替代 JSON 信封
  if (variant === 'edit') {
    const oldS = String(args.old_string ?? '');
    const newS = String(args.new_string ?? '');
    if (oldS || newS) return `- ${oldS}\n+ ${newS}`;
  }
  return JSON.stringify(args, null, 2);
}

/** 扁平化结果文本(当前 result 是单字符串) */
function resultText(call: ToolCallInfo): string {
  return String(call.result ?? '');
}

/** 状态推导:ok===undefined=运行中;ok===false=失败(当前无中断态数据源,统一按 error) */
function deriveState(call: ToolCallInfo): ToolRowState {
  if (call.ok === undefined) return 'running';
  return call.ok ? 'ok' : 'error';
}

export interface ToolRowModel {
  variant: ToolRowVariant;
  title: string;
  summary: string;
  filePath: string | undefined;
  body: string | null;
  output: string | null;
  errorSummary: string | null;
  state: ToolRowState;
}

export function toolRowModel(call: ToolCallInfo, toolName?: string): ToolRowModel {
  const name = toolName ?? call.tool;
  const variant = classifyTool(name);
  const state = deriveState(call);
  const argsRaw = call.args ?? '';
  const base = argsRaw === '' ? (call.id ?? name) : deriveSummary(variant, argsRaw);
  const toolTitle = TOOL_TITLES[name];
  const summary = variant === 'others' && toolTitle === undefined ? `${name} · ${base}` : base;
  const output = call.result != null && call.ok !== undefined ? resultText(call) || null : null;
  const errorSummary = state === 'error' && output !== null ? firstLine(output) : null;
  return {
    variant,
    title: toolTitle ?? VARIANT_TITLES[variant],
    summary,
    filePath: deriveFilePath(variant, argsRaw),
    body: deriveBody(variant, argsRaw),
    output,
    errorSummary,
    state,
  };
}

/** 相对化工作区前缀(仅显示;当前前端持有 workspace prop,调用方传入) */
export function relativizeToCwd(text: string, cwd?: string): string {
  if (!cwd || !text) return text;
  const root = cwd.replace(/[/\\]+$/, '');
  if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1);
  return text;
}