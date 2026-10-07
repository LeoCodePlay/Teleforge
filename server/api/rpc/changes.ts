// 文件变更对比的读取面:
//   changes_find    —— 落点查询:给我这个文件的对比(该文件最近一次变更在哪轮、序号几)
//   changes_summary —— 本轮改了哪些文件
//   changes_diff    —— 某个文件的 hunk 级对比
// 数据由文件写工具在写盘前后喂给 server/changes/store.ts(见那里的三条硬约束),
// 这里只做「查」。前端主要用 find + diff 两次调用就能把对比面板画全。
import { changesSummary, changeFileDiff, findChange } from '../../changes/store.ts';
import type { RpcModule } from './router.ts';

export function registerChanges(rpc: RpcModule) {
  // 从对话里的变更卡点进来:只带路径(可能还带轮号),由服务端定位
  rpc.register('changes_find', async (msg: any, { reply }: any) => {
    const found = findChange(msg?.sid, msg?.path, msg?.turn);
    const summary = found ? changesSummary(msg?.sid, found.turn) : null;
    reply({
      type: 'changes_find',
      found: !!(found && summary),
      summary,
      index: found?.index ?? 0
    });
  });

  rpc.register('changes_summary', async (msg: any, { reply }: any) => {
    reply({
      type: 'changes_summary',
      summary: changesSummary(msg?.sid, msg?.turn)
    });
  });

  rpc.register('changes_diff', async (msg: any, { reply }: any) => {
    reply({
      type: 'changes_diff',
      diff: changeFileDiff(msg?.sid, msg?.turn, msg?.index)
    });
  });
}
