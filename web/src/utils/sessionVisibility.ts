// 任务列表的会话可见性规则(用户上报的现场):
//   一个只有一条消息的任务对话,点「回到本轮对话发起前」后会话被截断成空,内容回到输入框;
//   一切换会话,这个会话就从任务列表里消失了 —— 草稿还在(按会话 id 存的),却再也点不回去继续发。
//
// 「空会话不占任务列表位」本身是有意的:新建会话尚未发送首条消息、服务端自动创建的空会话
// 都不该占位。但**曾经发过消息、后来被回退/删除清空**的会话是另一回事:它是用户自己建的
// 任务,回退只是把内容还给了输入框,会话本身必须留在列表里。
//
// 区分两者的是服务端持久化的 lastUserAt(「最后一次用户发消息的时间」):
// 回退/删除只减少 msgCount(msgCount=0),不会把它清回 0,所以它是"曾经有过对话"的可靠标记;
// 而新建的空会话(以及删光会话后自动补位的那条)根本没有这个字段。
import type { Session } from '../types';

/** 该会话是否出现在任务列表里(当前激活的与运行中的永远显示) */
export function showsInTaskList(s: Session, ctx: { activeId?: string | null; busyIds?: string[] }): boolean {
  if (ctx.activeId != null && s.id === ctx.activeId) return true; // 正在看的会话必须可见(否则切进去就没法定位自己)
  if ((ctx.busyIds || []).includes(s.id)) return true;            // 后台运行中的会话要能点进去看进度
  if ((s.msgCount ?? 0) > 0) return true;                         // 有对话内容(用户消息 / 压缩检查点)
  return (s.lastUserAt ?? 0) > 0;                                 // 被回退/删除清空:保留,草稿还能回去继续发
}
