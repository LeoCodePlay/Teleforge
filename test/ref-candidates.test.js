// ref_candidates(@ 文件/文件夹菜单)回归测试:
// 本地候选必须是「层序」——当前目录整层先铺满,再逐层下钻。
// 深度优先实现下,第一个条目很多的子目录会先耗尽总配额,菜单里只剩它的内容,
// 当前目录其它文件夹与文件全部缺失(用户报的"只列出了第一个文件夹里面的内容")。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerRef } from '../server/api/rpc/ref.ts';
import { sshManager as ssh } from '../server/core/ssh-manager.ts';
import { localFs } from '../server/core/local-fs.ts';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

const handlers = new Map();
registerRef({ register: (t, h) => { handlers.set(t, h); } });
const handler = handlers.get('ref_candidates');
check('ref_candidates 已注册', typeof handler === 'function');

const call = async (msg) => {
  let out = null;
  await handler(msg, { reply: (m) => { out = m; } });
  return out?.entries ?? [];
};

// fixture:根目录 3 个直属项(两个目录 + 一个文件);第一个目录塞 50 个文件,
// 远超单目录上限 TREE_PER_DIR(40)、足以在旧的深度优先实现下吃光总配额
const root = mkdtempSync(path.join(tmpdir(), 'sshai-ref-'));
const big = path.join(root, 'aaa-big');
const small = path.join(root, 'bbb-small');
mkdirSync(path.join(big, 'deep'), { recursive: true });
mkdirSync(small, { recursive: true });
for (let i = 0; i < 50; i++) writeFileSync(path.join(big, `f${String(i).padStart(2, '0')}.txt`), 'x');
writeFileSync(path.join(small, 'inner.txt'), 'x');
writeFileSync(path.join(root, 'zz.txt'), 'x');
// 噪声目录:与环境快照一致,不进候选
mkdirSync(path.join(root, 'node_modules'), { recursive: true });
writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'x');

const entries = await call({ localRoot: root, remoteRoot: '' });
const names = entries.map((e) => e.name);
const rel = (p) => p.slice(root.length).replace(/^[\\/]+/, '');
const topLevel = entries.filter((e) => !rel(e.path).includes('\\') && !rel(e.path).includes('/'));

check('候选非空', entries.length > 0, `n=${entries.length}`);
check('顶层条目全部入选(aaa-big/bbb-small/zz.txt)', ['aaa-big', 'bbb-small', 'zz.txt'].every((n) => names.includes(n)), names.slice(0, 6).join(','));
check('前若干项都是当前目录条目(层序,不被第一个子目录抢占)',
  topLevel.length >= 3 && entries.slice(0, topLevel.length).every((e) => !rel(e.path).includes(path.sep) && !rel(e.path).includes('/')),
  entries.slice(0, 5).map((e) => rel(e.path)).join(' | '));
check('当前目录条目全部排在子目录内容之前(zz.txt 位置)',
  names.indexOf('zz.txt') < names.findIndex((n) => n.startsWith('f') && n.endsWith('.txt')),
  `zz.txt@${names.indexOf('zz.txt')}, first-child@${names.findIndex((n) => n.startsWith('f'))}`);
check('子目录内容仍被收录(递归保留)', names.includes('inner.txt') && names.includes('deep'));
check('排除噪声目录 node_modules/dep.js', !names.includes('dep.js'));
check('条目来源标记为 local 且路径为绝对路径', entries.every((e) => e.source === 'local') && entries.every((e) => path.isAbsolute(e.path)), `connected=${ssh.connected}`);
check('候选总数不超过上限 300', entries.length <= 300, `n=${entries.length}`);

// 未传 localRoot 且两边都没有工作区时返回空表(前端据此显示"暂无可用文件")
const savedWs = localFs.workspace;
if (!savedWs) {
  const empty = await call({ localRoot: '', remoteRoot: '' });
  check('无工作区时返回空候选', empty.length === 0, `n=${empty.length}`);
}

try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows 偶发占用,忽略 */ }

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
