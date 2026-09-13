// @ 引用候选:ref_candidates —— 供聊天输入框的 @ 文件/文件夹菜单使用。
// 远程只平铺"当前目录一层"(只列直属条目,不递归):此前递归深度 2 需串行发起上千次
// SFTP readdir(每次一拍网络往返),远超前端 15s 超时,导致菜单迟迟不出现且结果为空;
// 改为一层后单次 listDir 即可返回,子目录本身作为可选项 @ 选中。本地保留轻量递归(层序)。
// 条目带 source 前缀标记(remote:/ 与 local:),发送给 AI 时据此区分用哪套工具读取。
import { sshManager as ssh } from '../../core/ssh-manager.ts';
import { localFs } from '../../core/local-fs.ts';
import type { FsEntry } from '../../core/local-fs.ts';
import { TREE_EXCLUDE, TREE_DEPTH, TREE_PER_DIR } from '../../agent/tools.ts';
import type { RpcModule } from './router.ts';

export interface RefCandidate {
  name: string;            // 显示名(文件名/文件夹名),模糊匹配与高亮用
  path: string;            // 完整路径(发送给 AI 时 @source:path 的 path)
  type: 'dir' | 'file' | 'link';
  source: 'remote' | 'local';
}

// 本地候选总上限独立于环境快照的 TREE_MAX_LINES(160):快照那点预算只够铺一个中等目录,
// 第一个子目录一多就把配额吃光,当前目录其余文件夹/文件全部进不了 @ 菜单。
const LOCAL_CAP = 300;
const REMOTE_CAP = 300;             // 远程一层平铺的单目录条目上限(菜单可过滤,放宽比 160 更好用)

function dirFirst<T extends { name: string; type: string }>(entries: T[]): T[] {
  const dirs = entries.filter((e) => e.type === 'dir').sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter((e) => e.type !== 'dir').sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}

// 路径拼接:远程 POSIX 根 / 不加重复分隔符;本地盘符根 C:\ 尾带分隔符时不再追加
function joinLocalPath(root: string, name: string): string {
  if (root === '/' || root === '') return `/${name}`;
  return root.endsWith('\\') || root.endsWith('/') ? `${root}${name}` : `${root}${root.includes('\\') ? '\\' : '/'}${name}`;
}

// 远程工作区一层平铺:仅列当前目录直属条目(排除噪声目录),不递归进子目录。
// 一次 listDir 即完成,响应快且不怕超大目录塞爆菜单(按条目数截断)。
async function walkRemote(root: string, acc: RefCandidate[]): Promise<void> {
  let entries: FsEntry[] = [];
  try { entries = await ssh.listDir(root); } catch { return; }
  const shown = dirFirst(
    entries.filter((e) => !TREE_EXCLUDE.has(e.name))
      .map((e) => ({ name: e.name, type: e.type }))
  );
  for (const e of shown) {
    if (acc.length >= REMOTE_CAP) return;
    const p = root === '/' ? `/${e.name}` : `${root}/${e.name}`;
    acc.push({ name: e.name, path: p, type: e.type, source: 'remote' });
  }
}

// 本地工作区层序遍历(广度优先):先把「当前目录」整层铺进候选,再逐层下钻。
// 原实现是深度优先的"push 一项就立刻递归进它"——第一个子目录只要条目够多(实测一个
// 149 项的目录)就会先耗尽总配额,菜单里剩下的全是这个文件夹的内容,当前目录其它
// 文件夹与文件一个都不出现。层序保证同层条目一定先于更深层出现,用户第一眼看到的就是
// "当前目录里有什么",子目录内容只在其后补充。
async function walkLocal(root: string, acc: RefCandidate[]): Promise<void> {
  let level: string[] = [root];
  for (let depth = 0; depth <= TREE_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (acc.length >= LOCAL_CAP) return;
      let entries: FsEntry[] = [];
      try { entries = await localFs.listDir(dir); } catch { continue; }
      const shown = dirFirst(
        entries.filter((e) => !TREE_EXCLUDE.has(e.name))
          .map((e) => ({ name: e.name, type: e.type }))
      ).slice(0, TREE_PER_DIR);
      for (const e of shown) {
        if (acc.length >= LOCAL_CAP) return;
        const p = joinLocalPath(dir, e.name);
        acc.push({ name: e.name, path: p, type: e.type, source: 'local' });
        if (e.type === 'dir' && depth < TREE_DEPTH) next.push(p);
      }
    }
    level = next;
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
