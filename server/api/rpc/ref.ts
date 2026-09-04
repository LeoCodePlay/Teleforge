// @ 引用候选:ref_candidates —— 供聊天输入框的 @ 文件/文件夹菜单使用。
// 复用环境快照的"有界深度扁平化"策略(排除噪声目录 + 深度 2 + 单目录条目上限),
// 一次返回远程与本地两个工作区的扁平候选条目;条目带 source 前缀标记
// (remote:/ 与 local:),发送给 AI 时据此区分用哪套工具读取。
import { sshManager as ssh } from '../../core/ssh-manager.ts';
import { localFs } from '../../core/local-fs.ts';
import type { FsEntry } from '../../core/local-fs.ts';
import { TREE_EXCLUDE, TREE_DEPTH, TREE_MAX_LINES, TREE_PER_DIR } from '../../agent/tools.ts';
import type { RpcModule } from './router.ts';

export interface RefCandidate {
  name: string;            // 显示名(文件名/文件夹名),模糊匹配与高亮用
  path: string;            // 完整路径(发送给 AI 时 @source:path 的 path)
  type: 'dir' | 'file' | 'link';
  source: 'remote' | 'local';
}

const TOTAL_CAP = TREE_MAX_LINES;   // 单工作区候选总上限(与环境快照一致,避免菜单被撑爆)

function dirFirst<T extends { name: string; type: string }>(entries: T[]): T[] {
  const dirs = entries.filter((e) => e.type === 'dir').sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter((e) => e.type !== 'dir').sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}

// 远程工作区扁平化遍历:与 treeLines 同策略(排除噪声目录、限深度、单目录条目上限、总上限),
// 但产出带完整路径的扁平候选。遍历途中每层截断,不足继续向下层补——与"骨架"视角一致。
async function walkRemote(root: string, acc: RefCandidate[], depth = 0): Promise<void> {
  if (depth > TREE_DEPTH || acc.length >= TOTAL_CAP) return;
  let entries: FsEntry[] = [];
  try { entries = await ssh.listDir(root); } catch { return; }
  const shown = dirFirst(
    entries.filter((e) => !TREE_EXCLUDE.has(e.name))
      .map((e) => ({ name: e.name, type: e.type }))
  ).slice(0, TREE_PER_DIR);
  for (const e of shown) {
    if (acc.length >= TOTAL_CAP) return;
    const p = root === '/' ? `/${e.name}` : `${root}/${e.name}`;
    acc.push({ name: e.name, path: p, type: e.type, source: 'remote' });
    if (e.type === 'dir') await walkRemote(p, acc, depth + 1);
  }
}

// 本地工作区扁平化遍历(与 walkRemote 同构,异步 fs 直读,Windows 盘符路径原样保留)
async function walkLocal(root: string, acc: RefCandidate[], depth = 0): Promise<void> {
  if (depth > TREE_DEPTH || acc.length >= TOTAL_CAP) return;
  let entries: FsEntry[] = [];
  try { entries = await localFs.listDir(root); } catch { return; }
  const shown = dirFirst(
    entries.filter((e) => !TREE_EXCLUDE.has(e.name))
      .map((e) => ({ name: e.name, type: e.type }))
  ).slice(0, TREE_PER_DIR);
  for (const e of shown) {
    if (acc.length >= TOTAL_CAP) return;
    // 路径拼接:远程 POSIX 根 / 不加重复分隔符;本地盘符根 C:\ 尾带分隔符时不再追加
    let p: string;
    if (root === '/' || root === '') p = `/${e.name}`;
    else p = root.endsWith('\\') || root.endsWith('/') ? `${root}${e.name}` : `${root}${root.includes('\\') ? '\\' : '/'}${e.name}`;
    acc.push({ name: e.name, path: p, type: e.type, source: 'local' });
    if (e.type === 'dir') await walkLocal(p, acc, depth + 1);
  }
}

export function registerRef(rpc: RpcModule) {
  rpc.register('ref_candidates', async (msg, { reply }) => {
    const entries: RefCandidate[] = [];
    // 遍历根 = 前端文件管理器当前打开的目录(remoteRoot/localRoot),让 @ 菜单跟随
    // 用户正在浏览的位置而不是固定工作区根;未传或为空时回落到对应工作区。
    // 本地文件面板无工作区时也在浏览(默认家目录),localRoot 可直接使用。
    const remoteRoot = (msg.remoteRoot || '').trim() || ssh.workspace || '';
    const localRoot = (msg.localRoot || '').trim() || localFs.workspace || '';
    // 无远程工作区(或未连接)时只返回本地候选;两端都无则返回空表提示前端
    if (remoteRoot && ssh.connected) await walkRemote(remoteRoot, entries);
    if (localRoot) await walkLocal(localRoot, entries);
    reply({ type: 'ref_candidates', entries });
  });
}
