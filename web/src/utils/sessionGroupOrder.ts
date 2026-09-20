// 任务列表「工作区分组」的排序 —— 纯函数,便于单测(组件里不再散着比较器)。
//
// 口径:会话行的活跃排序由服务端按「用户最后发消息的时间」(Session.lastUserAt)排好后下发,
// 组内顺序直接沿用;这里只决定「工作区分组之间」谁在前:
//   1. 用户拖拽过的分区(orderMap 有记录)→ 按手动顺序,新出现的工作区接在已记录分组之后;
//   2. 没拖过的分区 → 按组内「用户最近发消息时间」倒序,刚聊过的工作区浮到最前;
//      活跃度相同(如都没发过消息)时按工作区路径字典序,保证顺序稳定;
//   3. 「未指定工作区」固定最后。
// 关键点:排序键必须是 lastUserAt(用户发消息时间),不能用 updatedAt(AI 回复也会推进),
// 否则 AI 每回复一轮工作区分组就重排一次。
import type { Session } from '../types';

/** 会话活跃排序键:用户最后发消息时间优先,旧数据/空会话回退最后一次事件时间 */
export function sessionActiveAt(s: Session): number {
  const t = s.lastUserAt ?? s.updatedAt ?? 0;
  return typeof t === 'number' ? t : (Date.parse(String(t)) || 0);
}

/** 该分组内最近一次「用户发消息」的时间(= 组内会话活跃键的最大值) */
export function groupActiveAt(list: Session[]): number {
  let max = 0;
  for (const s of list) {
    const t = sessionActiveAt(s);
    if (t > max) max = t;
  }
  return max;
}

export interface GroupOrderOptions {
  /** 分区 id(远程按服务器、本地固定 'l'):拖拽顺序按分区分别记录 */
  sectionId: string;
  /** 用户拖拽结果:分区 id -> 该分区内分组 key 的完整顺序 */
  orderMap: Record<string, string[]>;
  /** 分组绑定的工作区路径(活跃度相同时按它做稳定排序) */
  wsOf: (s: Session) => string | null | undefined;
  /** 「未指定工作区」分组键后缀哨兵(固定最后) */
  ungrouped: string;
}

export function orderGroups(
  groups: [string, Session[]][],
  { sectionId, orderMap, wsOf, ungrouped }: GroupOrderOptions
): [string, Session[]][] {
  const rank = new Map((orderMap[sectionId] || []).map((k, i) => [k, i]));
  return [...groups].sort((a, b) => {
    const ra = rank.get(a[0]);
    const rb = rank.get(b[0]);
    // 拖拽过的分区:手动顺序优先;没被拖到的新分组排在已记录分组之后
    if (ra !== undefined || rb !== undefined) {
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      return ra - rb;
    }
    const ua = a[0].endsWith(`:${ungrouped}`);
    const ub = b[0].endsWith(`:${ungrouped}`);
    if (ua !== ub) return ua ? 1 : -1;
    const ta = groupActiveAt(a[1]);
    const tb = groupActiveAt(b[1]);
    if (ta !== tb) return tb - ta;
    return String(wsOf(a[1][0]) || '').localeCompare(String(wsOf(b[1][0]) || ''), 'zh-Hans-CN', { numeric: true });
  });
}
