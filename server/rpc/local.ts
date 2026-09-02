// @ts-nocheck
// 本地文件操作消息:list_local_dir / read_local_file / write_local_file / create_local_dir /
//                  local_delete / local_copy / set_local_workspace
import { localFs } from '../local-fs.ts';
import { clearLocalEnvInfo } from '../agent/tools.ts';

export function registerLocal(rpc) {
  rpc.register('list_local_dir', async (msg, { reply }) => {
    // 原 ws.js list_local_dir case(314-321)逐字复制
    // 空串/root: = "我的电脑"根视图(Windows 盘符 / POSIX 根);其余为真实路径
    const raw = String(msg.path || '').trim();
    const isRoot = raw === '' || raw === 'root:';
    const entries = await localFs.listDir(isRoot ? '' : raw);
    reply({ type: 'local_dir_list', path: isRoot ? 'root:' : raw, entries });
  });

  rpc.register('read_local_file', async (msg, { reply }) => {
    // 原 ws.js read_local_file case(322-327)逐字复制
    const { buffer, size, truncated } = await localFs.readFileChunk(msg.path, { maxBytes: msg.maxBytes });
    if (localFs.isProbablyBinary(buffer)) reply({ type: 'local_file_content', path: msg.path, binary: true, size, truncated });
    else reply({ type: 'local_file_content', path: msg.path, content: buffer.toString('utf8'), size, truncated });
  });

  rpc.register('write_local_file', async (msg, { reply }) => {
    // 原 ws.js write_local_file case(328-332)逐字复制
    const bytes = await localFs.writeFile(msg.path, msg.content);
    reply({ type: 'local_file_saved', path: msg.path, size: bytes });
  });

  rpc.register('create_local_dir', async (msg, { reply }) => {
    // 原 ws.js create_local_dir case(333-337)逐字复制
    await localFs.mkdirp(msg.path);
    reply({ type: 'local_dir_created', path: msg.path });
  });

  rpc.register('local_delete', async (msg, { reply, send }) => {
    // 原 ws.js local_delete case(338-347)逐字复制
    const { reqId } = msg;
    const type = await localFs.atype(msg.path);
    if (!type) throw new Error(`路径不存在: ${msg.path}`);
    let done = 0, lastEmit = 0;
    const onProgress = (p) => { done++; const now = Date.now(); if (now - lastEmit >= 120) { lastEmit = now; send({ type: 'local_delete_progress', reqId, path: msg.path, done, current: p }); } };
    await localFs.rmdirRecursive(msg.path, onProgress);
    send({ type: 'local_delete_progress', reqId, path: msg.path, done, final: true, current: msg.path });
    reply({ type: 'local_deleted', path: msg.path });
  });

  rpc.register('local_copy', async (msg, { reply }) => {
    // 原 ws.js local_copy case(348-353)逐字复制
    if (!msg.src || !msg.dst) throw new Error('缺少 src 或 dst');
    const r = await localFs.copyPath(msg.src, msg.dst, { overwrite: msg.overwrite });
    reply({ type: 'local_copied', ...r });
  });

  rpc.register('set_local_workspace', async (msg, { reply, emitStatus }) => {
    // 原 ws.js set_local_workspace case(372-381)逐字复制
    const st = await localFs.stat(msg.path);
    if (!st) throw new Error(`目录不存在: ${msg.path}`);
    if (!st.isDirectory()) throw new Error(`不是目录: ${msg.path}`);
    localFs.workspace = msg.path;
    clearLocalEnvInfo(); // 本地工作区变化,旧本地环境快照失效
    reply({ type: 'local_workspace', path: msg.path });
    emitStatus();
  });
}
