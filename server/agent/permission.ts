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
import { DEFAULT_TOOL_ACCESS, type ToolAccess, type ToolDef, type ToolRegistry } from './registry.ts';
import { getDefaultPermissionMode } from '../store/settings-store.ts';

export type PermissionMode = 'confirm' | 'auto-edit' | 'plan' | 'full-access';

/** 工具访问类别(定义与语义见 registry.ts;此处再导出供既有调用方沿用原导入路径) */
export type { ToolAccess };

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
// 权威来源是**工具自身的 `access` 声明**(ToolDef.access,见 registry.ts)。
// 下面两张名单只作为兜底:工具没声明 access 时按名字查表,查不到再 fail-closed 按
// 'write' 处理——新增写类工具若漏声明,结果是"多要一次审批",而不是"静默放行"。
//
// 历史教训:此前 toolAccess() 的兜底分支是 `return 'read'`(fail-open),意味着任何
// 未登记的新工具(含写类/命令类)都自动免审批,且在 plan 模式下也照样执行。
//
// meta:交互/任务清单/技能加载等宿主协调工具,任何模式都不拦
//       (ask_user_question 绝不能拦:审批弹窗本身就走这条通道,拦了会互相等待死锁)
// read:只读探测(读文件/列目录/搜索/环境信息/web 搜索),任何模式都不拦
// write:改变外部状态的文件操作(远程与 *_local 同组)
// command:命令执行(能力上无边界,单列一档:自动编辑模式下仍要审批)
const META_TOOLS = new Set(['todo_write', 'skill', 'ask_user_question']);
const WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'create_directory', 'delete_path', 'skill_copy_builtin',
  'write_local_file', 'edit_local_file', 'create_local_dir', 'delete_local_path',
  // 浏览器工具:会改变页面/浏览器状态,plan 模式下不应执行
  'browser_open', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll',
  'browser_eval', 'browser_close'
]);
const COMMAND_TOOLS = new Set(['run_command', 'run_local_command']);
/** 已知只读工具:仅在调用方未提供工具定义(纯名字判定)时用于保持放行语义 */
const READ_TOOLS = new Set([
  'list_directory', 'read_file', 'search_code', 'get_workspace_info', 'web_search',
  'list_local_dir', 'read_local_file', 'search_local_code', 'get_local_info',
  'browser_snapshot'
]);

/**
 * 判定一次工具调用的访问类别。
 * 优先取工具定义上的 `access` 声明;未声明(或未提供定义)时按名字查兜底名单,
 * 都不命中则返回 DEFAULT_TOOL_ACCESS('write')——fail-closed。
 * @param name - 工具名
 * @param def - 该工具的注册定义(省略时退化为纯名字判定)
 */
export function toolAccess(name: string, def?: Pick<ToolDef, 'access'> | null): ToolAccess {
  if (def && def.access) return def.access;
  if (META_TOOLS.has(name)) return 'meta';
  if (COMMAND_TOOLS.has(name)) return 'command';
  if (WRITE_TOOLS.has(name)) return 'write';
  if (READ_TOOLS.has(name)) return 'read';
  // 名单未命中(含未声明 access 的新工具):不假定只读,按最需要审批的一档处理
  return DEFAULT_TOOL_ACCESS;
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
 * @param name - 工具名
 * @param args - 已解析的工具参数
 * @param ctx - 执行上下文(含 session)
 * @param def - 该工具的注册定义;访问类别优先取自它的 `access` 声明
 */
export async function permissionGuard(name: string, args: any, ctx?: any, def?: Pick<ToolDef, 'access'> | null): Promise<string | undefined> {
  const access = toolAccess(name, def);
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

/** 把权限守卫挂到注册表(由 registerTools 在内置守卫之后调用,顺序在高危拦截之后)。
 *  守卫从注册表取回工具定义,以便按工具**自己声明**的 access 判定访问类别(fail-closed)。 */
export function registerPermissionGuard(registry: ToolRegistry): void {
  registry.guard(async (name: string, args: any, ctx?: any) => permissionGuard(name, args, ctx, registry.get(name)));
}
