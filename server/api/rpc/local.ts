// 本地文件操作消息:list_local_dir / read_local_file / write_local_file / create_local_dir /
//                  local_delete / local_copy / local_rename / set_local_workspace / local_reveal
import path from 'node:path';
import { spawn } from 'node:child_process';
import { localFs } from '../../core/local-fs.ts';
import { NO_WORKSPACE } from '../../config.ts';
import { clearLocalEnvInfo } from '../../agent/tools.ts';
import { agent } from '../../agent/agent.ts';
import type { RpcModule } from './router.ts';

/**
 * 用系统文件管理器打开本地路径(Windows 资源管理器 / macOS 访达 / Linux 文件管理器)。
 * explorer.exe 打开成功也会返回非 0 退出码,所以只按「能否 spawn」判定成败,不看退出码;
 * detached + unref:文件管理器是独立窗口,不该跟着本服务一起退出。
 */
function revealInFileManager(target: string): Promise<void> {
  const cmd = process.platform === 'win32' ? 'explorer.exe'
    : process.platform === 'darwin' ? 'open'
      : 'xdg-open';
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [target], { detached: true, stdio: 'ignore' });
    child.once('error', (e) => reject(new Error(`调用 ${cmd} 失败: ${e.message}`)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export function registerLocal(rpc: RpcModule) {
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
    const onProgress = (p: string) => { done++; const now = Date.now(); if (now - lastEmit >= 120) { lastEmit = now; send({ type: 'local_delete_progress', reqId, path: msg.path, done, current: p }); } };
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

  rpc.register('local_rename', async (msg, { reply }) => {
    if (!msg.src || !msg.dst) throw new Error('缺少 src 或 dst');
    try {
      const r = await localFs.renamePath(msg.src, msg.dst);
      reply({ type: 'local_renamed', ...r });
    } catch (e: any) {
      // Windows 下目录被占用(终端/资源管理器停在其中)rename 会报 EBUSY/EPERM,翻成人话并给出解除建议;
      // 若占用者可能就是本应用自己的本地终端(启动 cwd 在该目录内),给专项提示
      if (e && (e.code === 'EBUSY' || e.code === 'EPERM')) {
        const name = path.basename(String(msg.src));
        const norm = (p: string) => String(p).toLowerCase().replace(/[\\/]+$/, '');
        const dir = norm(msg.src);
        const termInside = [...localFs.localTermCwds].some((t) => {
          const nt = norm(t);
          return nt === dir || nt.startsWith(dir + '\\') || nt.startsWith(dir + '/');
        });
        throw new Error(termInside
          ? `「${name}」正被本应用的本地终端占用(终端当前停在该文件夹内)。在终端里 cd 到其他目录、或点终端面板的「重启终端」后,点错误条上的「重试」即可`
          : `「${name}」正被其他程序占用,无法重命名(常见:资源管理器窗口停在该文件夹内、其他终端/编辑器以它为当前目录)。关闭占用它的程序后,点错误条上的「重试」即可`);
      }
      throw e;
    }
  });

  // 在资源管理器里打开一个本地目录(任务列表分组菜单「在资源管理器打开」)。
  // 远程工作区在本地没有对应目录,前端对这类分组已把入口置灰,不会发到这里
  rpc.register('local_reveal', async (msg, { reply }) => {
    const target = String(msg.path || '').trim();
    if (!target) throw new Error('缺少路径');
    const st = await localFs.stat(target);
    if (!st) throw new Error(`目录不存在: ${target}`);
    await revealInFileManager(target);
    reply({ type: 'ok' });
  });

  rpc.register('set_local_workspace', async (msg, { reply, emitStatus }) => {
    // 原 ws.js set_local_workspace case(372-381)逐字复制
    // path 为哨兵 NO_WORKSPACE = 「不在工作区对话」:不校验目录,边界放宽到整台电脑
    const whole = msg.path === NO_WORKSPACE;
    if (!whole) {
      const st = await localFs.stat(msg.path);
      if (!st) throw new Error(`目录不存在: ${msg.path}`);
      if (!st.isDirectory()) throw new Error(`不是目录: ${msg.path}`);
    }
    const sid = typeof msg.sid === 'string' && msg.sid ? msg.sid : null;
    // 先校验锁定(本地模式会话开始对话后本地工作区不可改),再改状态
    agent.assertLocalWorkspaceChangeable(sid);
    if (whole) localFs.noWorkspace = true; else localFs.workspace = msg.path;
    clearLocalEnvInfo(); // 本地工作区变化,旧本地环境快照失效
    // 绑定到当前会话(草稿态 sid 为空则不绑定任何会话;会话创建时捕获当时工作区)
    agent.updateSessionLocalWorkspace(sid, whole ? NO_WORKSPACE : msg.path);
    reply({ type: 'local_workspace', path: whole ? null : msg.path, noWorkspace: whole });
    emitStatus();
  });
}
