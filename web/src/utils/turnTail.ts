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
//
// **过程范围不止工具与思考**:dsh 的 processMember 把「定稿答案之前的一切」都算过程,
// 包括模型在两次工具调用之间说的那些过程叙述("我换个思路…")。收起时它们必须跟着一起收,
// 否则会出现"工具收起来了、过程中的话还留在外面"的割裂观感(用户报的现象),
// 以及"过程叙述紧贴总结、两段看起来像一段"的混淆。边界判定见下面的 finalAnswerOf。

/** 折叠判定所需的行形态(比 TurnRowCarrier 多出分段与流式标记,仍是纯数据、可单测) */
export interface FoldRowCarrier extends TurnRowCarrier {
  /** 该段还在流式:轮没结束就不折(要能看着它干活) */
  streaming?: boolean;
  /** 重试状态行(role='notice' 且带 retry) */
  retry?: unknown;
  /** 消息分段:正文 / 思考 / 工具 */
  segments?: ReadonlyArray<{ kind?: string; text?: string; tools?: ReadonlyArray<unknown> }>;
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
  /** 本轮**最终答案**所在行(在过程范围之外,收起时仍留在外面);-1 = 本轮没有定稿答案 */
  readonly answerRow: number;
  /** 最终答案在该行的 segments 下标;answerRow < 0 时为 -1 */
  readonly answerSegment: number;
}

const NO_FOLD: TurnFoldRow = {
  owner: -1, foldable: false, hasProcess: false, hideWhenFolded: false, answerRow: -1, answerSegment: -1
};

/** 这一段会不会形成过程组(判据与 utils/processGroups 的 planGroups 一致:思考段 / 工具段) */
function hasProcessSegments(m: FoldRowCarrier | undefined): boolean {
  return (m?.segments || []).some((s) => s.kind === 'reasoning' || s.kind === 'tools');
}

// ---- 最终答案边界(对齐 dsh 的 turn-process latestAnswer / processSpec)----
//
// dsh 把一轮拆成「过程范围」与「定稿答案」两半:`processStartSeq` 到 `answerAnchorSeq`
// 之间的一切(思考、工具调用、**以及答话之前的中间叙述**)都是过程,整轮折叠时全部收起;
// 只有 `answerAnchorSeq` 那条定稿回复不受影响(ChatNodeSeat 的 processMember 判定)。
// 答案的判据同样来自 dsh:取该轮**最后一个 step** 的助手产出,它必须有正文,
// 且**不含工具调用**;最后一步还在调工具(或被停止在工具执行中)时,这一轮就没有答案,
// 整轮内容都属于过程(`answerAnchorSeq === null`)。
//
// 我们的 segments 是按到达顺序铺平的 [正文 / 思考 / 工具组 …],一次 step 的产出顺序是
// 思考 → 正文 → 工具组,所以「最后一个 step 不含工具调用」等价于:**本条消息的最后一个
// 实质段是正文**。最后一个实质段是工具组(还在干活)或只有思考时,这一轮没有答案。

/** 段是不是"实质内容":空白正文、空思考、空工具组都不算(dsh 的 blockIsVisible 同口径) */
function substantiveSegment(seg: { kind?: string; text?: string; tools?: ReadonlyArray<unknown> }): boolean {
  if (seg.kind === 'tools') return (seg.tools?.length ?? 0) > 0;
  if (seg.kind === 'text' || seg.kind === 'reasoning') return String(seg.text ?? '').trim() !== '';
  return false; // 未知段型:既不渲染、也不构成"最后一步"
}

/** 该行最后一个实质段(下标 + 类型);没有实质段(空气泡)时返回 null */
function lastSubstantiveSegment(m: FoldRowCarrier | undefined): { index: number; kind: string } | null {
  const segs = m?.segments || [];
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    if (seg && substantiveSegment(seg)) return { index: i, kind: String(seg.kind || '') };
  }
  return null;
}

/**
 * 本轮最终答案的位置;没有定稿答案时返回 null。
 *
 * 只看本轮**最后一条有实质内容的** assistant 行(空气泡不算:流式没流出内容、或重试分界
 * 留下的空行,在 dsh 里根本不会被投影成节点),而该行的最后一个实质段必须是正文。
 */
function finalAnswerOf(
  msgs: readonly FoldRowCarrier[], from: number, to: number
): { row: number; segment: number } | null {
  for (let k = to; k >= from; k--) {
    const m = msgs[k];
    if (!m || m.role !== 'assistant') continue;
    const last = lastSubstantiveSegment(m);
    if (!last) continue; // 空气泡:跳过,答案仍可能在前一行
    if (last.kind !== 'text') return null; // 最后一步是工具/思考 → 本轮没有定稿答案
    return { row: k, segment: last.index };
  }
  return null;
}

/**
 * 收起状态下,这一条正文段要不要跟着过程一起收起来。
 *
 * dsh 的 ChatNodeSeat:`processHidden = foldable && processMember && !processOpen`,
 * 而"过程成员"包括定稿答案之前的所有正文行。所以收起后留在外面的只有最终答案那一段,
 * 过程里的中间叙述("我换个思路…")跟着工具行一起收进去。
 * @param fold - 该行所属轮的折叠角色(planTurnFold 的结果)
 * @param row - 该正文段所在行下标
 * @param segment - 该正文段在行内的 segments 下标
 * @param open - 整轮过程是否处于展开状态
 * @returns 是否隐藏这一段正文
 */
export function foldedTextHidden(fold: TurnFoldRow, row: number, segment: number, open: boolean): boolean {
  if (!fold.foldable || open) return false;
  return !(fold.answerRow === row && fold.answerSegment === segment);
}

/**
 * 「下条消息时收起」口径下,哪一轮算**最新一轮**(它的过程默认敞着)。
 *
 * dsh 的 collapseTiming = next-input 时,`turnProcessOpen(..., defaultOpen)` 的 defaultOpen
 * 由"该节点是否位于对话底部"给出:最新一轮保持展开,收到下一条输入后与更早的轮一起收起。
 * 我们的对话流里等价判定是:从末尾往前第一条 assistant 段所属轮的折叠宿主;
 * 若它**之后**已经出现新一轮的输入(用户消息 / 轮首通知行),说明新一轮已开始,
 * 上一轮不再"最新" —— 返回 -1,全部按收起处理,直到新一轮的 assistant 段出现。
 * @param msgs - 渲染消息数组
 * @param plan - planTurnFold(msgs) 的结果
 * @returns 最新一轮的折叠宿主下标;没有符合条件的轮时为 -1
 */
export function latestFoldOwner(
  msgs: readonly FoldRowCarrier[], plan: readonly TurnFoldRow[]
): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m) continue;
    if (m.role === 'assistant') return plan[i]?.owner ?? -1;
    if (startsNewTurn(m)) return -1;
  }
  return -1;
}

/**
 * 按轮算出每一行的折叠角色(渲染层与单测共用这一份口径)。
 *
 * 规则:
 *   - 折叠行的宿主 = 本轮**第一段** assistant(轮首那一段),整轮只此一处;
 *   - 折叠与否看**整轮**:任何一段还在流式就不折,轮内没有任何工具/思考也不折(纯文本回复);
 *   - 重试提示行(命中失败点拆段的那种)是过程内容:折叠闭合时整行收起,
 *     展开后仍留在它发生的位置上;非重试的 notice 行(⚠ 中断原因等)不收起;
 *   - 最终答案边界(answerRow/answerSegment):收起时只有它留在外面,过程正文一并收起。
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
    const answer = finalAnswerOf(msgs, from, to);
    for (let k = from; k <= to; k++) {
      const m = msgs[k];
      out[k] = {
        owner,
        foldable,
        hasProcess,
        hideWhenFolded: foldable && m?.retry !== undefined && m?.retry !== null,
        answerRow: answer?.row ?? -1,
        answerSegment: answer?.segment ?? -1,
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
