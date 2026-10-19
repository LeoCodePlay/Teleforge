// 「一轮(Turn)的收尾段」判定 —— 对齐 dsh 的 turn-tail 节点。
//
// dsh 把「已修改文件卡 / 成果物 / 计划卡 / 复制·分支按钮」挂在**该 Turn 的 turn-tail** 上,
// 而 turn-tail 只在 turn/end 时发布(`client/ui-chat/.../turn-tail.ts` 的
// `publication: match => match.event.type === 'turn/end' ? 'immediate' : 'none'`):
// **整轮只有一处收尾产物**,且一定出现在这一轮真正结束之后。
//
// 我们的对话流里一轮同样会被拆成多段,早期实现让每段各自长出收尾产物,于是同一轮里会冒出
// 好几套「N 个文件已更改 + 复制/分支」,而且紧贴在**轮内**送达的通知行(子代理结算 steer 进来,
// 说明这一轮还在跑)下面,看着像任务已经收工。两种拆段来源:
//   - 重试提示(见 utils/compactionOrder 的 applyRetryNotice):失败点把气泡分成两段;
//   - 轮内送达的通知行(server/agent/agent.ts 的 deliverNotice → steer_message):
//     服务端此刻另起一条 assistant 行承接后续步骤。
// 判定以「轮边界」为界:真实用户消息、以及**轮首送达**的通知行(dsh 的 turn-trigger)开启新轮;
// 轮内送达(inline)的通知行属于正在跑的那一轮,不是边界。
//
// 渲染层(收尾产物挂哪一段)与 turnsToMessages(文件变更按哪一轮汇总)共用这一份口径,
// 避免两处各写一份、日后只改一边。
//
// 无 DOM/React 依赖,可单测(见 test/turn-tail.test.js)。

/** 判定所需的字段(宽松形态,便于纯函数单测) */
export interface TurnRowCarrier {
  role?: string;
  /** 压缩标记行(role='user',但不是新一轮的起点) */
  compaction?: unknown;
  /** 斜杠命令卡(role='user',同上) */
  command?: unknown;
  /** 非人类消息的来源归属(form='notice' 的行渲染成通知行) */
  source?: { form?: string } | null;
  /** 轮内送达(运行中 steer 进来):它属于正在跑的那一轮,不开启新轮 */
  inline?: boolean;
}

/**
 * 是不是「新一轮的起点」行。
 *
 * 真实用户消息开启新一轮;带 form='notice' 的通知行分两种(与 TurnTriggerRow 的两种形态一一对应):
 *   - **轮首送达**(会话空闲时的子代理结算 / 自动化任务 / 目标续跑)→ 它触发了这一轮,是轮边界;
 *   - **轮内送达**(运行中 steer 进来,`inline=true`)→ 它只是替子代理说的话插进正在跑的那一轮,
 *     不是触发者,也不开启新轮 —— 收尾产物因此仍只在这一轮真正结束后出现一次。
 * 压缩标记行与斜杠命令卡的 role 同样是 'user',但同样不是轮起点(见 isRealUserRow)。
 */
export function startsNewTurn(m: TurnRowCarrier | undefined): boolean {
  if (!m || m.role !== 'user' || m.compaction || m.command) return false;
  // inline 的唯一来源就是"轮内送达"(服务端投影的 inline 标记与实时的 steer_message 事件):
  // 它必然属于正在跑的那一轮。
  if (m.inline === true) return false;
  return true;
}

/**
 * 本轮(最后一条轮边界行之后)的全部 assistant 段下标,由后往前。
 * 收尾时用它把整轮的段一起收口(对齐 dsh:turn 结束后整轮内容都不再是流式)。
 */
export function turnAssistantIndexes(msgs: TurnRowCarrier[], endIdx = msgs.length - 1): number[] {
  const out: number[] = [];
  for (let i = Math.min(endIdx, msgs.length - 1); i >= 0; i--) {
    if (startsNewTurn(msgs[i])) break;
    if (msgs[i]?.role === 'assistant') out.push(i);
  }
  return out;
}

/**
 * 本轮的**中间片段**下标:该 assistant 段之后、下一轮开始之前还有别的 assistant 段,
 * 说明它不是本轮的收尾段 —— 收尾产物(文件变更卡 / 成果物卡 / 计划卡 / 复制·分支按钮)
 * 只在收尾段出现,中间片段静默。
 *
 * 反向单趟(渲染层每帧都要用,别写成对每条 assistant 再向后扫一遍):
 * 从后往前时"同轮后面的 assistant"先被看到,于是后面已经有 assistant 的段就是中间片段。
 */
export function fragmentIndexes(msgs: TurnRowCarrier[]): Set<number> {
  const out = new Set<number>();
  let sawLater = false; // 当前这一轮里,已经见过更靠后的 assistant 段
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (startsNewTurn(msgs[i])) { sawLater = false; continue; } // 跨过轮边界:再往前属于上一轮
    if (msgs[i]?.role !== 'assistant') continue;
    if (sawLater) out.add(i);
    sawLater = true;
  }
  return out;
}

/** 本轮最后一轮边界行的下标 + 1(即本轮在消息数组里的起点);没有边界行时是 0 */
export function turnStartIndex(msgs: TurnRowCarrier[], atIdx: number): number {
  for (let i = Math.min(atIdx, msgs.length - 1); i >= 0; i--) {
    if (startsNewTurn(msgs[i])) return i + 1;
  }
  return 0;
}

// ---- 回合过程折叠行挂哪一行(对齐 dsh 的 turn-process / groupTree)----
//
// dsh 每轮**只有一个** turn-process 节点(`groupTree: 'turn'`),它锚在轮首第一条过程证据上,
// 折叠行「已完成,用时 X」因此在整轮里只出现一次;而重试节点是 `groupTree: 'process'`,
// 属于"过程"这棵树 —— 折叠闭合时它跟着工具行一起收进去,不出现在最终输出里。
//
// 我们的对话流里一轮会被重试提示/轮内通知拆成好几段 assistant 行,早期实现让**每段**各自
// 渲染一个折叠行(每段都带着同一个 turnElapsedMs),于是界面上每段下面都冒出一句
// 「已完成,用时 15分41秒」,重试行还平铺在正文之间。这里按轮算一次:折叠行只挂宿主那一段,
// 轮内的重试行标记成"过程内容",由渲染层在折叠闭合时收起。

/** 折叠判定所需的行形态(比 TurnRowCarrier 多出分段与流式标记,仍是纯数据、可单测) */
export interface FoldRowCarrier extends TurnRowCarrier {
  /** 该段还在流式:轮没结束就不折(要能看着它干活) */
  streaming?: boolean;
  /** 重试状态行(role='notice' 且带 retry) */
  retry?: unknown;
  /** 消息分段:正文 / 思考 / 工具 */
  segments?: ReadonlyArray<{ kind?: string }>;
}

/** 一行(消息)在本轮折叠里的角色。同一轮的所有行共用同一个 owner / foldable。 */
export interface TurnFoldRow {
  /** 本轮折叠行的宿主行下标(本轮第一段 assistant);没有可折叠的轮时为 -1 */
  readonly owner: number;
  /** 整轮能不能折:轮已结束(没有段在流式)且轮内确有工具/思考过程 */
  readonly foldable: boolean;
  /** 轮内是否真有过程内容(折叠行据此决定能不能点开) */
  readonly hasProcess: boolean;
  /** 折叠闭合时这一整行要收起(重试提示行就是这种"过程内容") */
  readonly hideWhenFolded: boolean;
}

const NO_FOLD: TurnFoldRow = { owner: -1, foldable: false, hasProcess: false, hideWhenFolded: false };

/** 这一段会不会形成过程组(判据与 utils/processGroups 的 planGroups 一致:思考段 / 工具段) */
function hasProcessSegments(m: FoldRowCarrier | undefined): boolean {
  return (m?.segments || []).some((s) => s.kind === 'reasoning' || s.kind === 'tools');
}

/**
 * 按轮算出每一行的折叠角色(渲染层与单测共用这一份口径)。
 *
 * 规则:
 *   - 折叠行的宿主 = 本轮**第一段** assistant(轮首那一段),整轮只此一处;
 *   - 折叠与否看**整轮**:任何一段还在流式就不折,轮内没有任何工具/思考也不折(纯文本回复);
 *   - 重试提示行(命中失败点拆段的那种)是过程内容:折叠闭合时整行收起,
 *     展开后仍留在它发生的位置上;非重试的 notice 行(⚠ 中断原因等)不收起。
 */
export function planTurnFold(msgs: readonly FoldRowCarrier[]): TurnFoldRow[] {
  const out: TurnFoldRow[] = msgs.map(() => NO_FOLD);
  const settle = (from: number, to: number) => {
    if (from > to) return;
    let owner = -1;
    let hasProcess = false;
    let live = false;
    for (let k = from; k <= to; k++) {
      const m = msgs[k];
      if (!m || m.role !== 'assistant') continue;
      if (owner < 0) owner = k;
      if (m.streaming === true) live = true;
      if (hasProcessSegments(m)) hasProcess = true;
    }
    const foldable = owner >= 0 && !live && hasProcess;
    for (let k = from; k <= to; k++) {
      const m = msgs[k];
      out[k] = {
        owner,
        foldable,
        hasProcess,
        hideWhenFolded: foldable && m?.retry !== undefined && m?.retry !== null,
      };
    }
  };
  let start = 0;
  for (let i = 0; i <= msgs.length; i++) {
    if (i === msgs.length || startsNewTurn(msgs[i])) {
      settle(start, i - 1);
      start = i + 1;
    }
  }
  return out;
}
