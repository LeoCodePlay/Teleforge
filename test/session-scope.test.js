// 会话作用域测试:会话按服务器(user@host:port)/本地模式('local')隔离,
// setConnKey 切换作用域时自动把活跃会话收敛到新作用域;migrateLegacy 把无归属旧会话归到首个服务器。
// 归类规则(需求):会话归属作用域按"是否选了远程工作区"决定——选了归服务器作用域;
// 未选(即使已连接 SSH)归本地作用域,仅本地工作区对话。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-scope-'));
const { Agent } = await import('../server/agent/agent.ts');
const sessions = await import('../server/store/session-store.ts');
const sshMod = await import('../server/core/ssh-manager.ts');
const ssh = sshMod.sshManager;
const localFsMod = await import('../server/core/local-fs.ts');
const localFs = localFsMod.localFs;

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

const agent = new Agent({ emit: () => {} });
const A = 'user@a.com:22';
const B = 'user@b.com:22';

// 初始:本地模式,未选工作区,自动有一个本地会话
let mine = agent.listSessions();
check('初始为本地作用域且自动建会话', mine.length === 1 && mine[0].connKey === 'local', JSON.stringify(mine));

// 连接服务器 A 且选了远程工作区:自动新建 A 作用域会话,本地会话不在列表
ssh.workspace = '/srv/a';
localFs.workspace = 'C:/local/a';
agent.setConnKey(A);
mine = agent.listSessions();
check('切服务器 A(选远程工作区)后只列 A 会话', mine.length === 1 && mine[0].connKey === A, JSON.stringify(mine));
check('本地(未连接)会话在 A 作用域不可见', sessions.list('local').length === 1);
agent.createSession('A-2');
mine = agent.listSessions();
check('A 作用域新建会话后共 2 个', mine.length === 2 && mine.every((s) => s.connKey === A), JSON.stringify(mine));

// 切服务器 B(选远程工作区):自动新建 B 会话,A 会话不可见
ssh.workspace = '/srv/b';
agent.setConnKey(B);
mine = agent.listSessions();
check('切服务器 B 后只列 B 会话(自动新建)', mine.length === 1 && mine[0].connKey === B, JSON.stringify(mine));
check('A 会话在 B 作用域不可见', sessions.list(A).length === 2);

// 切回 A:恢复 A 会话列表
ssh.workspace = '/srv/a';
agent.setConnKey(A);
mine = agent.listSessions();
check('切回 A 恢复 A 会话列表', mine.length === 2 && mine.every((s) => s.connKey === A), JSON.stringify(mine));

// 断开回本地模式(未选远程工作区)
ssh.workspace = null;
agent.setConnKey('local');
mine = agent.listSessions();
check('断开后回到本地作用域会话', mine.length === 1 && mine[0].connKey === 'local', JSON.stringify(mine));

// 需求:连接服务器但未选远程工作区 → 会话归本地作用域(仅本地工作区对话)
ssh.workspace = null;
localFs.workspace = 'C:/local/d';
const D = 'user@d.com:22';
agent.setConnKey(D); // D 无会话:自动收敛的会话也按"未选远程工作区"归本地(D 作用域没有任何会话)
const settledD = agent.getSessionId();
check('连接未选远程工作区:收敛的会话归本地作用域',
  sessions.list(D).length === 0 && sessions.list('local').some((s) => s.id === settledD),
  JSON.stringify({ d: sessions.list(D).length, settled: settledD }));
const localOnly = agent.createSession('未选远程工作区的会话');
check('连接未选远程工作区:新建会话归本地作用域', localOnly.connKey === 'local' && localOnly.workspace == null && localOnly.localWorkspace === 'C:/local/d',
  JSON.stringify({ c: localOnly.connKey, w: localOnly.workspace, l: localOnly.localWorkspace }));

// 旧会话迁移:无归属(connKey 缺失)会话归属到首次连接的服务器;本地模式不迁移
const legacy = sessions.create('旧会话', null);
check('无归属会话不算进本地列表', sessions.list('local').length === 3);
const n1 = sessions.migrateLegacy(A);
check('迁移旧会话到服务器 A', n1 === 1 && sessions.list().find((s) => s.id === legacy.id)?.connKey === A);
check('本地模式不触发迁移', sessions.migrateLegacy('local') === 0);
check('无旧会话后迁移为 0', sessions.migrateLegacy(B) === 0);

// list() 无参返回全部(旧调用兼容)
check('list() 无参返回全部会话', sessions.list().length === 3 + 2 + 1 + 1);

// 「不在工作区对话」(全盘模式):连接级选了全盘后新建的会话,绑定记为哨兵而非 null,
// 并且按"有远程侧工作区"归当前服务器作用域(它是在整台服务器上工作,不是仅本地)
const { NO_WORKSPACE } = await import('../server/config.ts');
ssh.noWorkspace = true;
check('全盘模式:连接级工作区被清空且置标记', ssh.workspace === null && ssh.noWorkspace === true,
  JSON.stringify({ w: ssh.workspace, nw: ssh.noWorkspace }));
const wholeSession = agent.createSession('整台服务器');
check('全盘模式:会话绑定记为哨兵', wholeSession.workspace === NO_WORKSPACE, JSON.stringify(wholeSession.workspace));
check('全盘模式:会话归服务器作用域', wholeSession.connKey === D, JSON.stringify(wholeSession.connKey));
ssh.workspace = '/srv/d';
check('选回具体目录后自动退出全盘模式', ssh.noWorkspace === false && ssh.workspace === '/srv/d');
localFs.noWorkspace = true;
check('本地全盘:清空本地工作区并置标记', localFs.workspace === null && localFs.noWorkspace === true);

// 边界(回归):断开连接后,连接期写入的"回落字段"必须复位——否则 active 为 null 时
// getter 回落读到残留的远程工作区,导致断开后新建会话错误继承远程绑定(归远程任务列表)。
// 用真实 SshConnection 走 manager.disconnect 的完整断开路径(生产时序),而非仅 mock 赋值。
{
  const T = 'user@t.com:22';
  const conn = new sshMod.SshConnection();
  conn.status = 'connected';
  conn.hostInfo = { host: 't.com', port: 22, username: 'user' };
  ssh.conns.set(T, conn);
  ssh._hook(T, conn);
  ssh._activeId = T;
  ssh.workspace = '/srv/t'; // 连接期选远程工作区(setter 会同时写入回落字段)
  check('连接期工作区生效', ssh.workspace === '/srv/t' && ssh.active?.workspace === '/srv/t',
    JSON.stringify({ w: ssh.workspace, a: ssh.active?.workspace }));
  await ssh.disconnect(T);
  check('断开后回落字段复位(无残留工作区)', ssh.workspace === null && ssh.noWorkspace === false && ssh.active === null,
    JSON.stringify({ w: ssh.workspace, nw: ssh.noWorkspace }));
  const afterDisconnect = agent.createSession('断开后新建');
  check('断开后新建会话归本地且无远程绑定', afterDisconnect.connKey === 'local' && afterDisconnect.workspace == null,
    JSON.stringify({ c: afterDisconnect.connKey, w: afterDisconnect.workspace }));
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
