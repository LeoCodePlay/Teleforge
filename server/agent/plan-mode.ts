// 计划模式(逐条移植自 deepseek-harness 的 packages/plan/plan-mode)。
//
//   1. /plan 命令            —— 进入/退出计划模式(逐字对齐 dsh 的回执文案)
//   2. plan:policy 提示段    —— 计划模式生效时给模型的行动指引
//   3. exit_plan_mode 工具   —— 模型把完成的计划交用户审阅,批准即退出计划模式
//   4. plan/mode 事件        —— "整值替换的 log-only 状态"(回放/分支/压缩后照样恢复)
//
// 与 dsh 一致的关键语义(**不要**改回"权限档位"那套):
// - **计划模式不改变工具目录**:dsh 的原话是 "guidance and enforcement are separate axes"
//   (tests: 'keeps the full toolset in plan mode'、'runs every call in plan mode untouched')。
//   计划模式只注入提示段,不拦任何工具 —— 只读约束属于 sandbox/审批旋钮,与它正交。
//   `permission.ts` 里那条"plan 档位硬拒写/命令"已随之删除。
// - 用户选择先成为 **pending**,到下一个被接受的 step 边界才落 `plan/mode`
//   (dsh PlanModeController.set / onBoundary):回合开着 = queued,回合空闲 = 当场 committed。
// - 每个模型请求前记下"这一轮请求头部描述的模式"(activeAtLastHeader):与用户新选的模式
//   不同时补一条 plan-mode 通知("The user switched this session to plan mode.")——
//   否则界面切了模式、模型却以为自己还在原来的模式里。
import type { Session } from './session.ts';
import type { ToolDef } from './registry.ts';
import { askUserQuestion } from './ask-user.ts';
/** 日志事件类型(harness SessionEventMap 的 'plan/mode'):整值替换,最后一条生效 */
export const PLAN_MODE_EVENT = 'plan/mode';

/** 模型侧退出工具名(harness EXIT_PLAN_MODE)。非计划模式下也保持注册:工具清单不随模式抖动 */
export const EXIT_PLAN_MODE = 'exit_plan_mode';

/** 审阅题面的 id 与两个选项标签(harness REVIEW_ID / APPROVE_LABEL / KEEP_PLANNING_LABEL) */
export const PLAN_REVIEW_ID = 'plan-review';
export const PLAN_APPROVE_LABEL = 'Approve';
export const PLAN_KEEP_PLANNING_LABEL = 'Keep planning';

/** 工具描述(harness EXIT_DESCRIPTION 逐字) */
export const EXIT_DESCRIPTION
  = 'Use only in plan mode. Present your plan for the user\'s review and, on approval, leave plan mode. '
  + 'The user may approve (carry out the plan from your next step) or keep '
  + 'planning — their feedback comes back in the tool result; revise and present again.';

/** 参数描述(harness 工具 schema 逐字) */
export const EXIT_PARAM_DESCRIPTION = 'The complete plan, as markdown, starting with a # heading that names it.';

/**
 * 计划模式生效时追加进 runtime_context 的行动指引。
 *
 * dsh 里这段是**部署自己的配置**(PlanModeConfig.section,插件装载时由部署传入):仓库里只有
 * 测试用的占位文本,线上值不在源码中 —— 所以这里沿用本工具原有的中文指引(语义同源:
 * 先调研,再用 exit_plan_mode 交审阅,批准后才执行)。计划模式已不硬拒工具,指引里也不再声称会被拒绝。
 */
export const PLAN_POLICY_TEXT = '当前处于计划模式(plan mode):先充分调研(读文件、搜索、只读命令),'
  + '再通过 exit_plan_mode 把完整计划(以 # 标题开头的 markdown:步骤、涉及文件、风险)交给用户审阅。'
  + '用户批准后计划才会被执行:批准前不要开始改代码或执行有副作用的命令。';

/** 会话日志里的计划状态:最后一条 plan/mode 决定;没有就是未开启 */
export function foldPlanActive(events: readonly any[] | null | undefined): boolean {
  let active = false;
  for (const ev of events || []) {
    if (ev?.type !== PLAN_MODE_EVENT) continue;
    active = ev.data?.active === true;
  }
  return active;
}

/** 计划正文的首个 markdown 标题(任意级别),没有则 undefined —— harness firstHeading */
export function planFirstHeading(plan: string): string | undefined {
  for (const line of String(plan ?? '').split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/** 回合是否开着:turn/start 与 turn/end 未配平(harness turnBoundary 投影的等价物) */
export function hasOpenTurn(events: readonly any[] | null | undefined): boolean {
  let open = 0;
  for (const ev of events || []) {
    if (ev?.type === 'turn/start') open += 1;
    else if (ev?.type === 'turn/end') open -= 1;
  }
  return open > 0;
}

/** set() 的结果(harness PlanModeController.set 的返回联合) */
export type PlanSetOutcome = 'committed' | 'queued' | 'cancelled' | 'noop';

/** 每会话的计划模式进程内状态(pending / 请求头部模式) */
interface PlanSessionState {
  pending: boolean;
  /** pending 的目标(仅 pending=true 时有意义) */
  wanted: boolean;
  /** 上一次模型请求头部描述的模式(进程内;重启后未知 = 不补通知) */
  activeAtLastHeader?: boolean;
  /** 下一次落盘要不要**静默**(批准退出 = 静默:模型自己知道的模式变化,不补用户切换通知) */
  silent: boolean;
}

/**
 * 进程内状态表。pending 与 activeAtLastHeader 都不落盘:harness 的 pendingIntents 同样是
 * 进程内 Map,activeAtLastHeader 来自请求头部投影 —— 重启后未知,因此不会凭空补切换通知。
 */
const states = new WeakMap<Session, PlanSessionState>();

function stateOf(session: Session): PlanSessionState {
  let s = states.get(session);
  if (!s) { s = { pending: false, wanted: false, silent: false }; states.set(session, s); }
  return s;
}

/** 丢弃某会话的进程内状态(新建 / 清空历史时调用) */
export function resetPlanModeState(session: Session | null | undefined): void {
  if (session) states.delete(session);
}

/** 宿主回调(agent.ts 注入):落盘 + 广播 + 补通知 + 批准后退出 */
export interface PlanModeHost {
  /** 一条 plan/mode 写进日志后:落盘并广播给前端 */
  changed(session: Session, sid: string | null | undefined, active: boolean): void;
  /** 补一条"用户切换了模式"的通知(harness narration,source.form='notice') */
  narrate(session: Session, sid: string | null | undefined, active: boolean): void;
  /** 批准后退出计划模式:与用户 /plan off 同一条路径(静默、不补通知) */
  leave(session: Session, sid: string | null | undefined): void;
}

/** 当前状态(harness PlanModeController.get):logged 的 active + 可选 pending */
export function planModeView(session: Session): { active: boolean; pending?: boolean } {
  const s = stateOf(session);
  const active = foldPlanActive(session.events);
  return s.pending ? { active, pending: s.wanted } : { active };
}

/** 计划模式此刻是否生效(模型请求据此决定是否注入 plan:policy 段) */
export function planModeActive(session: Session): boolean {
  return foldPlanActive(session.events);
}

/**
 * 选择是否开启计划模式(harness PlanModeController.set)。
 *
 * 回合开着 → pending,返回 queued(反向选择把已 pending 的相反意图清掉,返回 cancelled);
 * 回合空闲 → 当场 append plan/mode,返回 committed;重复选当前(或已 pending 的同一)状态 → noop。
 */
export function setPlanMode(
  session: Session, sid: string | null | undefined, active: boolean, host: PlanModeHost
): PlanSetOutcome {
  const s = stateOf(session);
  const logged = foldPlanActive(session.events);
  const target = s.pending ? s.wanted : logged;
  if (active === target) return 'noop';
  if (hasOpenTurn(session.events)) {
    s.pending = true;
    s.wanted = active;
    s.silent = false; // 用户选的一定要通知(批准退出会显式静默)
    return logged === active ? 'cancelled' : 'queued';
  }
  if (active === logged) {
    // 反向的 pending 被撤销,logged 状态本来就等于目标
    s.pending = false;
    s.wanted = active;
    s.silent = false;
    return 'cancelled';
  }
  session.append(PLAN_MODE_EVENT, { active });
  s.pending = false;
  s.wanted = active;
  const narrate = takeNarration(s, active);
  host.changed(session, sid, active);
  if (narrate) host.narrate(session, sid, active);
  return 'committed';
}

/**
 * 下一个被接受的 step 边界:把 pending 落成事件(harness onBoundary)。
 * 由 agent 在**发请求之前**调用 —— 所以这一轮请求拿到的是刚落下的模式。
 */
export function applyPlanBoundary(session: Session, sid: string | null | undefined, host: PlanModeHost): void {
  const s = stateOf(session);
  if (!s.pending) return;
  const target = s.wanted;
  const logged = foldPlanActive(session.events);
  if (target === logged) {
    s.pending = false;
    s.silent = false;
    return;
  }
  session.append(PLAN_MODE_EVENT, { active: target });
  s.pending = false;
  const narrate = takeNarration(s, target);
  host.changed(session, sid, target);
  if (narrate) host.narrate(session, sid, target);
}

/**
 * 静默退出计划模式(批准 exit_plan_mode 的路径,harness 的 `{ active:false, narrate:false }`):
 * 与 setPlanMode(false) 同语义,但**不补**"用户切换了模式"的通知 ——
 * 那是模型自己发起、自己知道的变化。
 */
export function leavePlanModeSilent(
  session: Session, sid: string | null | undefined, host: PlanModeHost
): PlanSetOutcome {
  const s = stateOf(session);
  const outcome = setPlanMode(session, sid, false, host);
  s.silent = true;   // 供紧随其后的边界落盘消费(若已 committed 则本次已无通知可补)
  return outcome;
}

/** 记下请求头部的模式(harness activeAtLastHeader);返回是否发生变化 */
export function recordPlanHeader(session: Session, active: boolean): boolean {
  const s = stateOf(session);
  const prev = s.activeAtLastHeader;
  s.activeAtLastHeader = active;
  return prev !== active;
}

/** 请求头部描述的模式(undefined = 本进程还没发过请求) */
export function planActiveAtLastHeader(session: Session): boolean | undefined {
  return stateOf(session).activeAtLastHeader;
}

/** 用户切换通知的判据(harness narration):最后一次请求说的模式与现在不同才通知 */
export function shouldNarrateSwitch(session: Session, target: boolean): boolean {
  const told = planActiveAtLastHeader(session);
  return told !== undefined && told !== target;
}

/**
 * 消费一次"该补切换通知"的机会,返回是否要通知。
 *
 * 判据与 dsh 同构:只有"模型上一次请求被告知的模式 ≠ 刚落下的模式"才通知 ——
 * 进程内没有请求头部记录(本进程还没发过请求)= 模型什么都没被告知 = 不通知。
 * 批准退出走静默(silent):那是模型自己发起、自己知道的变化,不该冒充"用户切换了模式"。
 *
 * 取标志必须在调用宿主的 changed() **之前**:changed 会广播,而 narrate 落成一条 user 消息 ——
 * 顺序反了就会"先看到模式变了、再看到通知"。
 */
function takeNarration(s: PlanSessionState, next: boolean): boolean {
  const silent = s.silent;
  s.silent = false;
  if (silent) return false;
  const told = s.activeAtLastHeader;
  return told !== undefined && told !== next;
}

/** 计划模式生效时注入运行时的提示段(harness 的 plan:policy section);未生效返回空串 */
export function planPolicySection(events: readonly any[] | null | undefined): string {
  return foldPlanActive(events) ? PLAN_POLICY_TEXT : '';
}

/**
 * exit_plan_mode 工具(harness plan-mode 的退出工具,文案逐字):
 * 校验 → 请用户审阅 → 批准则退出计划模式;继续规划把反馈当错误结果回给模型;
 * 用户关掉审阅去说话(dismiss)时给 dsh 的专用提示,而不是通用取消文案。
 */
export function exitPlanModeTool(host: PlanModeHost): ToolDef {
  return {
    name: EXIT_PLAN_MODE,
    description: EXIT_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: { plan: { type: 'string', description: EXIT_PARAM_DESCRIPTION } },
      required: ['plan']
    },
    // 交互类工具:不写文件、不执行命令。计划模式本身不拦工具(与 dsh 一致),
    // 这里声明 meta 只是不让审批卡把它当写操作。
    access: 'meta',
    mutating: true,
    async run({ plan }: any, ctx: any = {}) {
      const { session, signal, emit } = ctx;
      if (!session) throw new Error(`${EXIT_PLAN_MODE} requires a calling agent (no session to switch)`);
      if (!foldPlanActive(session.events)) throw new Error(`${EXIT_PLAN_MODE} is only available in plan mode`);
      const text = String(plan ?? '').trim();
      if (!/^#\s+\S/.test(text)) {
        throw new Error(`${EXIT_PLAN_MODE} requires a non-empty markdown plan starting with a # heading`);
      }
      const answers = await askUserQuestion({
        sid: ctx.sid,
        signal,
        emit,
        questions: [{
          id: PLAN_REVIEW_ID,
          header: 'Plan review',
          question: 'Approve this plan and leave plan mode?',
          detail: text,
          options: [
            { label: PLAN_APPROVE_LABEL, description: 'Leave plan mode; the plan is carried out from the next step.' },
            { label: PLAN_KEEP_PLANNING_LABEL, description: 'Stay in plan mode; feedback goes back to the model.' }
          ],
          // 呈现层语义:前端据此渲染成"计划审阅"(自动打开计划预览、记住待审阅的计划)
          intent: { kind: PLAN_REVIEW_ID, approve: PLAN_APPROVE_LABEL, callId: ctx.callId }
        }]
      }).catch((cause: unknown) => {
        // 用户关掉审阅去说话了:这不是"提问失败"。dsh 的原话如此(通用文案会误报成模型调用了
        // ask_user_question)。本轮被中止(停止/连接断开)保留自己的原因,不走这条。
        const message = cause instanceof Error ? cause.message : String(cause);
        if (/取消|已停止|cancel/i.test(message)) {
          throw new Error('The user dismissed the plan review to speak instead; '
            + 'stay in plan mode, stop here, and wait for their message.');
        }
        throw cause;
      });
      const item = (answers || []).find((a: any) => a && a.id === PLAN_REVIEW_ID);
      const selected: string[] = Array.isArray(item?.selected) ? item.selected : [];
      const feedback = typeof item?.custom === 'string' ? item.custom : '';
      // 只有"恰好选中 Approve 且没有自定义回答"才算批准(harness 同判据)
      if (selected.length !== 1 || selected[0] !== PLAN_APPROVE_LABEL || feedback !== '') {
        throw new Error(feedback === ''
          ? 'The user chose to keep planning; revise the plan and present it again.'
          : `The user chose to keep planning; their feedback: ${feedback}`);
      }
      // 批准:静默退出(不补"用户切换了模式"的通知)。与 dsh 一样,这条选择在下一个 step 边界
      // 才落成 plan/mode —— 本轮剩下的工具批次仍然看到计划指引。
      host.leave(session, ctx.sid);
      // 返回呈现文本:harness 给这个工具声明了 output.render —— 模型看到的是
      // 'Plan approved — plan mode exited; carry out the plan starting with your next step.'
      return 'Plan approved — plan mode exited; carry out the plan starting with your next step.';
    }
    // 计划卡片标题(取计划首个 # 标题,harness presentCall: firstHeading(args.plan) ?? 'Plan')
    // 由前端从 tool/call 的 arguments 里解析 —— ToolDef 没有 presentCall 这个字段,
    // 计划正文本来就在日志的 tool/call 里,不需要额外事件。
  };
}
