// @ts-nocheck
// 本地↔远程传输消息:local_to_remote / remote_to_local
import { localToRemote, remoteToLocal } from '../transfer.ts';

export function registerTransfer(rpc) {
  rpc.register('local_to_remote', async (msg, { reply, send }) => {
    // 原 ws.js local_to_remote case(354-362)逐字复制
    const { reqId } = msg;
    const paths = (Array.isArray(msg.paths) ? msg.paths : [msg.paths]).filter(Boolean);
    if (!paths.length) throw new Error('缺少本地路径');
    const r = await localToRemote(paths, msg.dir, {
      onProgress: (p) => send({ type: 'transfer_progress', reqId, ...p })
    });
    reply({ type: 'transfer_done', ...r });
  });

  rpc.register('remote_to_local', async (msg, { reply, send }) => {
    // 原 ws.js remote_to_local case(363-371)逐字复制
    const { reqId } = msg;
    const paths = (Array.isArray(msg.paths) ? msg.paths : [msg.paths]).filter(Boolean);
    if (!paths.length) throw new Error('缺少远程路径');
    const r = await remoteToLocal(paths, msg.dir, {
      onProgress: (p) => send({ type: 'transfer_progress', reqId, ...p })
    });
    reply({ type: 'transfer_done', ...r });
  });
}
