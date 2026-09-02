// 远程文件操作消息:list_dir / read_file / write_file / create_dir / delete / copy / set_workspace
import { sshManager as ssh } from '../../core/ssh-manager.ts';
import { clearEnvInfo } from '../../agent/tools.ts';
import type { RpcModule } from './router.ts';

export function registerRemote(rpc: RpcModule) {
  rpc.register('list_dir', async (msg, { reply }) => {
    // 原 ws.js list_dir case(383-387)逐字复制
    const entries = await ssh.listDir(msg.path || '/');
    reply({ type: 'dir_list', path: msg.path || '/', entries });
  });

  rpc.register('read_file', async (msg, { reply }) => {
    // 原 ws.js read_file case(388-396)逐字复制
    const { buffer, size, truncated } = await ssh.readFileChunk(msg.path, { maxBytes: msg.maxBytes });
    if (ssh.isProbablyBinary(buffer)) {
      reply({ type: 'file_content', path: msg.path, binary: true, size, truncated });
    } else {
      reply({ type: 'file_content', path: msg.path, content: buffer.toString('utf8'), size, truncated });
    }
  });

  rpc.register('write_file', async (msg, { reply }) => {
    // 原 ws.js write_file case(397-401)逐字复制
    const bytes = await ssh.writeRemoteFile(msg.path, msg.content);
    reply({ type: 'file_saved', path: msg.path, size: bytes });
  });

  rpc.register('create_dir', async (msg, { reply }) => {
    // 原 ws.js create_dir case(402-406)逐字复制
    await ssh.mkdirp(msg.path);
    reply({ type: 'dir_created', path: msg.path });
  });

  rpc.register('delete', async (msg, { reply, send }) => {
    // 原 ws.js delete case(407-427)逐字复制
    const { reqId } = msg;
    const type = await ssh.atype(msg.path);
    if (!type) throw new Error(`路径不存在: ${msg.path}`);
    let done = 0;
    let lastEmit = 0;
    // 每删一项回调一次;节流到至少 120ms 一条,避免小目录也刷屏
    const onProgress = (p: string) => {
      done++;
      const now = Date.now();
      if (now - lastEmit >= 120) {
        lastEmit = now;
        send({ type: 'delete_progress', reqId, path: msg.path, done, current: p });
      }
    };
    if (type === 'dir') await ssh.rmdirRecursive(msg.path, onProgress);
    else { await new Promise<void>((res, rej) => ssh.sftp!.unlink(msg.path, (e: any) => (e ? rej(e) : res()))); onProgress(msg.path); }
    // 收尾一条 final,保证前端一定能看到"删完"(节流可能吞掉最后一条)
    send({ type: 'delete_progress', reqId, path: msg.path, done, final: true, current: msg.path });
    reply({ type: 'deleted', path: msg.path });
  });

  rpc.register('copy', async (msg, { reply }) => {
    // 原 ws.js copy case(428-433)逐字复制
    if (!msg.src || !msg.dst) throw new Error('缺少 src 或 dst');
    const r = await ssh.copyPath(msg.src, msg.dst, { overwrite: msg.overwrite });
    reply({ type: 'copied', ...r });
  });

  rpc.register('set_workspace', async (msg, { reply, emitStatus }) => {
    // 原 ws.js set_workspace case(434-443)逐字复制
    const st = await ssh.stat(msg.path);
    if (!st) throw new Error(`目录不存在: ${msg.path}`);
    if (!st.isDirectory()) throw new Error(`不是目录: ${msg.path}`);
    ssh.workspace = msg.path;
    clearEnvInfo(); // 工作区变化,旧环境快照失效
    reply({ type: 'workspace', path: msg.path });
    emitStatus();
  });
}
