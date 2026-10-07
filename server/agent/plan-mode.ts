// 计划模式(逐条移植自 deepseek-harness 的 packages/plan/plan-mode):
//   /plan 命令            —— 进入/退出计划模式
//   plan:policy 提示段    —— 计划模式生效时给模型的行动指引
//   exit_plan_mode 工具   —— 模型把完成的计划交用户审阅,批准即退出计划模式
//
// 与 harness 的差异(宿主架构差异,语义不变):
// 1. teleforge 已经有一个「计划模式」权限档位(permission.ts 的 4 档预设之一,
//    写/执行类工具在 guard 里直接拒绝)。因此计划状态就是权限模式 'plan'
//    —— `/计划` 切到该档位,`/计划 off` 回到进入前的档位,只读约束继续由现有 guard 保证。
//    harness 里 plan 与 sandbox/approval 是两个正交旋钮;这里是产品已定的合并档位(用户选择)。
// 2. 提示段走 runtime_context 快照(teleforge 的 system 必须逐字节稳定以保护前缀缓存),
//    不做 system prompt 的 plan:policy section。文本内容与 harness 的配置段同义。
// 3. harness 的 plan/mode 事件是"整值替换的 log-only 状态";这里落在既有的
//    permission/mode 事件上(值 'plan'),回放/分支/压缩的恢复语义完全一致。
import type { Session } from './session.ts';
import type { ToolDef, ToolRegistry } from './registry.ts';
import { askUserQuestion } from './ask-user.ts';
import { DEFAULT_PERMISSION_MODE, foldPermissionMode, isPermissionMode, type PermissionMode } from './permission.ts';
import { getDefaultPermissionMode as storeDefault } from '../store/settings-store.ts';
import * as sessions from '../store/session-store.ts';

/** 模型侧退出工具名(harness EXIT_PLAN_MODE;非计划模式下也保持注册,工具清单不随切换抖动) */
export const EXIT_PLAN_MODE = 'exit_plan_mode';

/** 计划模式生效时追加进 runtime_context 的行动指引(harness PlanModeConfig.section 同义) */
export const PLAN_POLICY_TEXT = '当前处于计划模式:先充分调研(读文件、搜索、只读命令),'
  + '再通过 exit_plan_mode 把完整计划(以 # 标题开头的 markdown:步骤、涉及文件、风险)交给用户审阅;'
  + '写文件、修改、删除、执行命令会被拒绝,不要尝试。用户批准后计划才会被执行。';

const EXIT_DESCRIPTION
  = 'Use only in plan mode. Present your plan for the user\'s review and, on approval, leave plan mode. '
  + 'The user may approve (carry out the plan from your next step) or keep '
  + 'planning — their feedback comes back in the tool result; revise and present again.';

/** 审阅题面(harness REVIEW_ID / APPROVE_LABEL / KEEP_PLANNING_LABEL 的中文对应) */
export const PLAN_REVIEW_ID = 'plan-review';
export const PLAN_APPROVE_LABEL = '批准';
export const PLAN_KEEP_LABEL = '继续规划';

/** 折叠日志判断计划模式是否生效:最后一次 permission/mode 事件即状态(整值替换) */
export function isPlanMode(events: readonly any[], fallback: PermissionMode = 'confirm'): boolean {
  return foldPermissionMode(events as any[], fallback) === 'plan';
}

/**
 * 退出计划模式时回到哪一档:取日志中最后一次非 plan 的权限档位;
 * 日志里没有(新会话直接进计划模式)则回落全局默认。
 * 与 foldPermissionMode 同构(倒序扫描),保证 /计划 off 幂等且可回放。
 */
export function modeBeforePlan(events: readonly any[], fallback: PermissionMode = 'confirm'): PermissionMode {
  for (let i = (events || []).length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type !== 'permission/mode') continue;
    const mode = ev.data?.mode;
    if (!isPermissionMode(mode) || mode === 'plan') continue;
    return mode;
  }
  return isPermissionMode(fallback) ? fallback : 'confirm';
}

/** 退出计划模式的宿主回调(由 agent.ts 注入:写"回到进入前档位"的权限事件并广播) */
export type LeavePlanMode = (ctx: { session: Session; sid?: string | null; emit?: (event: string, payload: any) => void }) => void;

/**
 * 退出计划模式:追加一条 `permission/mode` 事件回到进入前的档位,立即落盘并广播。
 * 只依赖工具调用上下文里的 session/sid/emit —— 计划模式是**会话状态**,
 * 任何 Agent 实例(含测试里的独立实例)拿到的会话都能正确退出,不需要回指全局单例。
 */
export function leavePlanMode(ctx: { session: Session; sid?: string | null; emit?: (event: string, payload: any) => void }): PermissionMode {
  const { session, sid, emit } = ctx;
  const stored = storeDefault();
  const fallback: PermissionMode = isPermissionMode(stored) ? stored : DEFAULT_PERMISSION_MODE;
  const target = modeBeforePlan(session.events, fallback);
  const mode: PermissionMode = target === 'plan' ? DEFAULT_PERMISSION_MODE : target;
  session.append('permission/mode', { mode });
  if (sid) {
    try { sessions.saveEvents(sid, session.events); } catch { /* 落盘失败不阻塞退出 */ }
  }
  emit?.('agent', { event: 'permission_changed', mode, sid });
  return mode;
}

/**
 * exit_plan_mode 工具定义(harness plan-mode 的退出工具):
 * 校验 → 请用户审阅 → 批准则退出计划模式,选择继续规划则把反馈作为错误结果回给模型。
 */
export function exitPlanModeTool(): ToolDef {
  return {
    name: EXIT_PLAN_MODE,
    description: EXIT_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description: 'The complete plan, as markdown, starting with a # heading that names it.'
        }
      },
      required: ['plan']
    },
    // 交互类工具:不写文件、不执行命令,plan 模式的只读 guard 不拦它(否则计划永远出不去)
    access: 'meta',
    mutating: true,
    async run({ plan }: any, ctx: any = {}) {
      const { session, signal, emit } = ctx;
      if (!session) throw new Error('exit_plan_mode 需要所属会话(缺少调用上下文)');
      if (!isPlanMode(session.events)) throw new Error('exit_plan_mode 只能在计划模式下使用');
      const text = String(plan ?? '').trim();
      if (!/^#\s+\S/.test(text)) {
        throw new Error('exit_plan_mode 需要一份以 # 标题开头的完整 markdown 计划');
      }
      const answers = await askUserQuestion({
        sid: ctx.sid,
        signal,
        emit,
        questions: [{
          id: PLAN_REVIEW_ID,
          header: '计划审阅',
          question: '批准这份计划并退出计划模式?',
          // 计划正文随题面下发:AskPanel 以等宽正文渲染(harness 的 review detail)
          detail: text,
          options: [
            { label: PLAN_APPROVE_LABEL, description: '退出计划模式;从下一步开始按这份计划执行。' },
            { label: PLAN_KEEP_LABEL, description: '留在计划模式;反馈会回到模型,修改后再次呈现。' }
          ]
        }]
      });
      const item = (answers || []).find((a: any) => a && a.id === PLAN_REVIEW_ID);
      const picked = Array.isArray(item?.selected) ? item.selected[0] : undefined;
      const feedback = typeof item?.custom === 'string' ? item.custom.trim() : '';
      if (picked === PLAN_APPROVE_LABEL && feedback === '') {
        leavePlanMode(ctx);
        return '计划已批准 —— 已退出计划模式;从下一步开始执行该计划。';
      }
      throw new Error(feedback === ''
        ? `用户选择继续规划;请修改计划后再次调用 ${EXIT_PLAN_MODE} 呈现。`
        : `用户选择继续规划;用户反馈:${feedback}`);
    }
  };
}
