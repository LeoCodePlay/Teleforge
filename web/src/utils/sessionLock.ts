// 工作区锁定规则 —— 纯函数,便于单测,并与服务端的裁决保持**同一条口径**。
//
// 服务端是最终裁决(server/agent/agent.ts):
//   · assertRemoteWorkspaceChangeable:任何「已开始对话」的会话都不能再改远程工作区;
//   · assertLocalWorkspaceChangeable:只有**本地会话**开始对话后才锁本地工作区。
//     这里的「本地会话」= 没占用「具体远程工作区目录」的会话(server 的 usesRemoteWorkspace):
//       - 没选远程工作区(workspace 为 null)—— 只在本地干活的那批;
//       - 选了「不使用远程工作区(整台服务器)」(workspace = NO_WORKSPACE 哨兵)—— 全盘边界,
//         同样没占用服务器上的任何目录,会话也归「本地工作区」分组。
//     远程会话(绑定了具体远程目录)的本地工作区只是**辅助**工作区,始终可改。
//
// 前端必须与这条规则一致:不一致时 chip 不置灰、点开还能选,用户以为能改,
// 提交却被服务端拒(报「该本地会话已开始对话,本地工作区已锁定」)。
// 历史上这里误按「会话自己有没有 localWorkspace」来判断,于是正常的本地工作区会话
// (localWorkspace 非空)反而判成未锁定 —— 就是用户上报的"工作区 A 没被锁"。
import { NO_WORKSPACE } from '../types/index.ts';
import type { Session } from '../types/index.ts';

/** 会话是否占用了「具体的远程工作区目录」(= 远程会话)。与服务端 usesRemoteWorkspace 同一规则 */
export function usesRemoteWorkspace(s: { workspace?: string | null } | null | undefined): boolean {
  const ws = s?.workspace;
  return !!ws && ws !== NO_WORKSPACE;
}

/** 远程工作区是否锁定:会话已开始对话即锁定(草稿/尚未创建会话不锁) */
export function remoteWorkspaceLocked(session: Session | null | undefined, started: boolean): boolean {
  return !!session && !!started;
}

/** 本地工作区是否锁定:本地会话(没占用具体远程目录)开始对话后锁定;远程会话的本地是辅助,不锁 */
export function localWorkspaceLocked(session: Session | null | undefined, started: boolean): boolean {
  return !!session && !!started && !usesRemoteWorkspace(session);
}
