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

// 「不在工作区对话」(全盘模式)与本地任务列表同一份(需求核心):
// 全盘边界没有占用服务器上任何工作区目录 → 这类会话归本地作用域(local),连接前后都留在
// 同一份本地任务列表里;只有"选了某个具体远程目录"的会话才归那台服务器(远程任务列表)。
// 必须用真实 SshConnection 造出活动连接:远程绑定只在确实连着服务器时才记录。
const { NO_WORKSPACE } = await import('../server/config.ts');
const W = 'user@w.com:22';
const localIdsBefore = new Set(sessions.list('local').map((x) => x.id));
{
  const conn = new sshMod.SshConnection();
  conn.status = 'connected';
  conn.hostInfo = { host: 'w.com', port: 22, username: 'user' };
  ssh.conns.set(W, conn);
  ssh._hook(W, conn);
  ssh._activeId = W;
  agent.setConnKey(W);
  ssh.noWorkspace = true;
  check('全盘模式:连接级工作区被清空且置标记', ssh.workspace === null && ssh.noWorkspace === true,
    JSON.stringify({ w: ssh.workspace, nw: ssh.noWorkspace }));
  const wholeSession = agent.createSession('整台服务器');
  check('全盘模式:会话绑定记为哨兵', wholeSession.workspace === NO_WORKSPACE, JSON.stringify(wholeSession.workspace));
  check('全盘模式:没占用服务器工作区 → 归本地作用域', wholeSession.connKey === 'local',
    JSON.stringify(wholeSession.connKey));
  check('全盘会话在已连接时的本地任务列表里可见',
    agent.listVisible().some((x) => x.id === wholeSession.id));
  ssh.workspace = '/srv/w';
  check('选回具体目录后自动退出全盘模式', ssh.noWorkspace === false && ssh.workspace === '/srv/w');
  const dirSession = agent.createSession('占用远程目录');
  check('占用具体远程目录 → 归该服务器作用域(远程任务列表)',
    dirSession.connKey === W && dirSession.workspace === '/srv/w',
    JSON.stringify({ c: dirSession.connKey, w: dirSession.workspace }));
  await ssh.disconnect(W);
  agent.setConnKey('local'); // 等价于 ws 层 syncAgentScope:断开回到本地作用域
  const visible = new Set(agent.listVisible().map((x) => x.id));
  check('断开后本地任务列表与连接前同一份(一个本地会话都不少)',
    [...localIdsBefore].every((id) => visible.has(id)),
    JSON.stringify({ before: localIdsBefore.size, visible: visible.size }));
  check('断开后全盘会话仍在本地任务列表(不因断线消失)', visible.has(wholeSession.id));
  check('远程工作区会话不混进本地任务列表', !visible.has(dirSession.id));
}
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

// ---- 本轮连接绑定规则(_bindTurnConn)----
// 需求:local 作用域不是一台服务器,它永远是这台电脑本身——没连服务器时的 local 与连着
// 服务器时的 local 同一个意思。所以本地作用域的会话绝不能因为"服务器未连接"被拒绝执行
// (旧实现把带远程绑定的本地会话打成"该会话属于服务器 local,它当前未连接:本轮未执行")。
{
  ssh.conns.clear();
  ssh._activeId = null;
  const mkRt = (connKey, workspace) => ({ connKey, workspace });

  const r1 = agent._bindTurnConn(mkRt('local', NO_WORKSPACE));
  check('本地作用域+全盘边界:未连接也照常执行(不再有"服务器 local 未连接")',
    r1.error === null && r1.boundConn === null && r1.remoteWs === NO_WORKSPACE,
    JSON.stringify({ e: r1.error, w: r1.remoteWs }));

  const r2 = agent._bindTurnConn(mkRt('local', '/srv/leftover'));
  check('本地作用域+残留远程目录:不拒绝,且该目录不生效(不会打到别的服务器)',
    r2.error === null && r2.boundConn === null && r2.remoteWs === null,
    JSON.stringify({ e: r2.error, w: r2.remoteWs }));

  const r3 = agent._bindTurnConn(mkRt(null, '/srv/legacy'));
  check('无归属旧会话+远程目录:未连接时不拒绝,按本机继续',
    r3.error === null && r3.boundConn === null, JSON.stringify({ e: r3.error }));

  const r4 = agent._bindTurnConn(mkRt('user@a.com:22', '/srv/a'));
  check('服务器作用域+具体目录:那台服务器没连上时拒绝执行(不借用别的服务器)',
    r4.error !== null && r4.boundConn === null && /user@a\.com:22/.test(r4.error || ''),
    JSON.stringify({ e: r4.error }));
}
{
  const W2 = 'user@w2.com:22';
  const conn = new sshMod.SshConnection();
  conn.status = 'connected';
  conn.hostInfo = { host: 'w2.com', port: 22, username: 'user' };
  ssh.conns.set(W2, conn);
  ssh._hook(W2, conn);
  ssh._activeId = W2;
  const r5 = agent._bindTurnConn({ connKey: 'local', workspace: NO_WORKSPACE });
  check('本地作用域+全盘边界+已连服务器:顺着用当前活动连接(远程全盘仍可用)',
    r5.error === null && r5.boundConn === conn, JSON.stringify({ e: r5.error }));
  const r6 = agent._bindTurnConn({ connKey: W2, workspace: '/srv/w2' });
  check('服务器作用域:按自己的键解析到那台连接',
    r6.error === null && r6.boundConn === conn && r6.remoteWs === '/srv/w2');
  await ssh.disconnect(W2);
}

// ---- 端到端(用户上报的原始现场)----
// 会话归本地作用域、却带着断线前留下的远程全盘边界,且此刻没有任何 SSH 连接:
// 旧实现这一轮直接被拒("该会话属于服务器 local,它当前未连接:本轮未执行"),
// 现在必须照常在本机跑完(mock 模型,只验证绑定/执行门槛)。
{
  const { LlmClient } = await import('../server/agent/llm.ts');
  agent.llm = new LlmClient({ baseUrl: 'http://mock', apiKey: '', model: 'mock' });
  ssh.conns.clear();
  ssh._activeId = null;
  const broken = agent.createSession('断线残留远程边界的本机会话');
  agent.updateSessionWorkspace(broken.id, NO_WORKSPACE); // 生产路径:local 作用域 + 全盘边界
  const errors = [];
  const prevEmit = agent.emit;
  agent.emit = (ev, payload) => {
    if (ev === 'agent' && payload?.event === 'error') errors.push(payload.message);
    prevEmit(ev, payload);
  };
  await agent.submit(broken.id, '你好');
  agent.emit = prevEmit;
  const events = sessions.loadEvents(broken.id);
  check('断线时 local 会话照常跑完一轮(不再报"服务器 local 未连接")',
    errors.length === 0 && events.some((e) => e.type === 'turn/end'),
    JSON.stringify({ errors, tail: events.map((e) => e.type).slice(-3) }));
  const meta = sessions.list().find((x) => x.id === broken.id);
  check('该会话仍归本地作用域(不会被这次对话改判成服务器作用域)',
    meta?.connKey === 'local' && meta?.workspace === NO_WORKSPACE,
    JSON.stringify({ c: meta?.connKey, w: meta?.workspace }));
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
