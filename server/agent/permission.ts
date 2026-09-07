// 访问权限模式(设计参照 deepseek-harness 的 interaction/permission-presets):
// - 模式 = 用户可切换的权限预设,四个档位:
//     confirm     变更前确认(默认):写文件/编辑/删除/执行命令前弹窗请求用户批准
//     auto-edit   自动编辑:文件写入/编辑自动执行,执行命令仍需批准
//     plan        计划模式:只读研究阶段,写/执行类工具直接拒绝,模型只调研并给出计划
//     full-access 完全访问:全部操作自动执行,不再询问(高危命令拦截守卫仍然生效)
// - 模式值持久化在会话事件日志里('permission/mode' 事件,对齐 harness 的
//   permission/preset:append-only 用户意图,回放/分支自然继承,清空历史即复位默认);
//   折叠规则与 foldTodos 同构:取最后一次 mode 事件的值,无记录回落默认 confirm。
// - 执行面在工具注册表的 pre-execute guard 落地(只能拒绝不能放行):
//   只读/交互类工具永不拦截;写类与命令类工具按模式走 拒绝 / 审批 / 放行 三条路径。
//   审批复用 ask-user 通道(askUserQuestion 阻塞等待):题面经前端 AskPanel 展示,
//   作答"允许"放行、"拒绝"返回结构化错误结果,取消/超时/停止的清理路径全部复用。
import { askUserQuestion } from './ask-user.ts';
import type { Session } from './session.ts';
import type { ToolRegistry } from './registry.ts';
import { getDefaultPermissionMode } from '../store/settings-store.ts';

export type PermissionMode = 'confirm' | 'auto-edit' | 'plan' | 'full-access';

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'confirm';

export const PERMISSION_MODES: readonly PermissionMode[] = ['confirm', 'auto-edit', 'plan', 'full-access'];

/** 客户端渲染用的展示信息(与 harness PresetOption 的 name/description 对齐) */
export const PERMISSION_MODE_META: Record<PermissionMode, { name: string; description: string }> = {
  'confirm': { name: '变更前确认', description: '写文件、编辑、删除与执行命令前,先弹窗请求你批准' },
  'auto-edit': { name: '自动编辑', description: '文件的写入与编辑自动执行;执行命令前仍需你批准' },
  'plan': { name: '计划模式', description: '只读研究:AI 只调研并给出实施计划,不执行任何变更' },
  'full-access': { name: '完全访问', description: '全部操作自动执行,不再询问(高危命令拦截仍然生效)' },
};

export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v);
}

/**
 * 折叠事件日志得到当前权限模式(参照 harness effectivePermissionPreset 的倒序扫描):
 * 取最后一次 'permission/mode' 事件的值;历史里没有(旧会话/清空过)回落
 * fallback——默认传全局默认模式(settings-store,新会话与清空历史的会话都继承),
 * 无全局设置(首次启动/旧数据)才回落 DEFAULT_PERMISSION_MODE。
 */
export function foldPermissionMode(events: Array<{ type: string; data?: any }>, fallback: unknown = DEFAULT_PERMISSION_MODE): PermissionMode {
  for (let i = (events || []).length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === 'permission/mode' && isPermissionMode(ev.data?.mode)) return ev.data.mode;
  }
  return isPermissionMode(fallback) ? fallback : DEFAULT_PERMISSION_MODE;
}

// ---- 工具访问分类:guard 拦截判定的依据 ----
// meta:交互/任务清单/技能加载等宿主协调工具,任何模式都不拦
//       (ask_user_question 绝不能拦:审批弹窗本身就走这条通道,拦了会互相等待死锁)
// read:只读探测(读文件/列目录/搜索/环境信息/web 搜索),任何模式都不拦
// write:改变外部状态的文件操作(远程与 *_local 同组)
// command:命令执行(能力上无边界,单列一档:自动编辑模式下仍要审批)
const META_TOOLS = new Set(['todo_write', 'skill', 'ask_user_question']);
const WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'create_directory', 'delete_path', 'skill_copy_builtin',
  'write_local_file', 'edit_local_file', 'create_local_dir', 'delete_local_path'
]);
const COMMAND_TOOLS = new Set(['run_command', 'run_local_command']);

export type ToolAccess = 'meta' | 'read' | 'write' | 'command';

export function toolAccess(name: string): ToolAccess {
  if (META_TOOLS.has(name)) return 'meta';
  if (COMMAND_TOOLS.has(name)) return 'command';
  if (WRITE_TOOLS.has(name)) return 'write';
  return 'read'; // 未登记的只读工具(含未来新增)默认放行;mutating 未登记工具本就该登记
}

// 审批题面的参数摘要:提取各写类工具的关键参数,让用户一眼看到"要动什么"
function argSummary(name: string, args: any): string {
  const s = (v: unknown) => String(v ?? '');
  switch (name) {
    case 'write_file': case 'write_local_file':
      return `写入 ${s(args?.path)}(${s(args?.content).length} 字符)`;
    case 'edit_file': case 'edit_local_file':
      return `编辑 ${s(args?.path)}`;
    case 'create_directory': case 'create_local_dir':
      return `创建目录 ${s(args?.path)}`;
    case 'delete_path': case 'delete_local_path':
      return `删除 ${s(args?.path)}`;
    case 'run_command': case 'run_local_command':
      return `执行命令 \`${s(args?.command).slice(0, 160)}\``;
    case 'skill_copy_builtin':
      return `复制内置技能到本机技能目录(${s(args?.name)})`;
    default:
      return '';
  }
}

/**
 * 权限守卫(注册到 ToolRegistry 的 pre-execute guard):
 * 只在工具执行链路里调用(需要 ctx.session/ctx.sid/ctx.signal/ctx.emit),
 * 返回拒绝理由或 undefined(放行)。异步:审批会阻塞到用户作答。
 */
export async function permissionGuard(name: string, args: any, ctx?: any): Promise<string | undefined> {
  const access = toolAccess(name);
  if (access === 'meta' || access === 'read') return undefined; // 只读/协调工具永不拦
  const session: Session | undefined = ctx?.session;
  if (!session) return undefined; // 无会话上下文(理论不发生):fail-open 交由其它守卫兜底
  const mode = foldPermissionMode(session.events, getDefaultPermissionMode());

  if (mode === 'full-access') return undefined;
  if (mode === 'plan') {
    const what = access === 'command' ? '执行命令' : '写入/修改文件';
    return `计划模式下禁止${what}:当前处于只读的计划模式,请只做调研(读文件/搜索/执行只读命令之外的操作会被拒绝),`
      + '把完整的实施计划(步骤/涉及文件/风险)用文字或 todo_write 呈现给用户,等用户切换出计划模式后再执行。';
  }
  // confirm:写 + 命令都要审批;auto-edit:只有命令要审批
  const needApproval = mode === 'confirm' || (mode === 'auto-edit' && access === 'command');
  if (!needApproval) return undefined;

  const summary = argSummary(name, args) || `调用工具 ${name}`;
  const opName = access === 'command' ? '执行命令' : '变更文件';
  try {
    const answers = await askUserQuestion({
      sid: ctx.sid,
      signal: ctx.signal,
      emit: ctx.emit,
      questions: [{
        id: 'permission',
        header: `${opName}确认`,
        question: `AI 请求${opName}:${summary}${mode === 'auto-edit' ? '(自动编辑模式:文件编辑已放行,命令仍需确认)' : ''}`,
        options: [
          { label: '允许', description: '批准本次操作,继续执行' },
          { label: '拒绝', description: '本次操作不执行,AI 将收到拒绝结果并调整方案' }
        ]
      }]
    });
    const picked = answers?.[0]?.selected?.[0];
    if (picked === '允许') return undefined;
    return `用户拒绝了本次${opName}(工具未执行)。请尊重用户决定:不要换参数重试同一操作,调整方案或向用户说明影响后再继续。`;
  } catch (e: any) {
    // 用户取消/超时/停止:与"拒绝"同语义,工具不执行
    return `用户未批准本次${opName}(${e?.message || '已取消'}),工具未执行`;
  }
}

/** 把权限守卫挂到注册表(由 registerTools 在内置守卫之后调用,顺序在高危拦截之后) */
export function registerPermissionGuard(registry: ToolRegistry): void {
  registry.guard(async (name: string, args: any, ctx?: any) => permissionGuard(name, args, ctx));
}
