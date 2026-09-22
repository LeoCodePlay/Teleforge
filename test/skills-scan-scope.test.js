// 回归测试:技能目录扫描的「作用域」与「硬超时」+ 压缩期间排队消息的派发。
//
// 线上现象(已定位):用户在本地会话里点了 /compact,压缩期间发的消息进了待执行队列;压缩成功后
// 前端队列面板清空(看起来"发出去了"),但 agent 一直显示「运行中」、迟迟没有任何输出。
// 两个成因:
//   1) 轮次开始处的技能目录刷新(在 turn/start 落盘与模型请求之前)会去扫**活动服务器**的远程
//      技能目录:未绑定连接的会话轮次里 ssh.connected 回落到连接级 _status,于是本地会话跑到
//      远端工作区/家目录上逐个技能读 SFTP(逐条 await,一次 3~4 个往返),开场就卡住几分钟。
//      修复:只认当前作用域内**实际绑定**的连接(ssh.active),并给扫描加硬超时。
//   2) 压缩结束时的派发只看 rt.pending:用户点「立即执行」会把消息先移进 rt.inbox,于是漏派发;
//      另外驱动 promise 已 settle 但清空回调(微任务)未跑时,新派发会被直接吞掉。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-skills-scope-'));

const { sshManager: ssh, runWithWorkspaceBinding } = await import('../server/core/ssh-manager.ts');
const { localFs } = await import('../server/core/local-fs.ts');
const { refreshSkillsCatalog, getSkillsCatalog } = await import('../server/agent/tools.ts');
const { Agent } = await import('../server/agent/agent.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---- 1: 未绑定连接的轮次绝不碰远程技能目录;绑定连接的轮次照常扫 ----
{
  const fakeConn = { status: 'connected', workspace: '/srv/app', home: '/root', isProbablyBinary: () => false };
  ssh.conns.set('fake:22:u', fakeConn);
  ssh._activeId = 'fake:22:u';
  // 生产现场:app 连着服务器时,连接级回落字段(_status/_workspace/_home)就是这台服务器的值。
  // 未绑定连接的会话轮次里,旧实现读到的 ssh.connected/workspace/home 全部回落到它们,
  // 于是把活动服务器当成"可扫远程技能"的连接(这正是开场卡住几分钟的根因)。
  ssh.status = 'connected';
  ssh.workspace = '/srv/app';
  ssh.home = '/root';
  localFs.workspace = process.cwd();

  const origListDir = ssh.listDir.bind(ssh);
  let listed = 0;
  ssh.listDir = async () => { listed++; return []; };

  listed = 0;
  const unbound = await ssh.runWithConn(null, () => runWithWorkspaceBinding(null, async () => refreshSkillsCatalog()));
  check('未绑定连接的轮次不访问远程技能目录', listed === 0, `listDir=${listed}`);
  check('该轮次仍能拿到内置/本机技能', unbound.length > 0, `skills=${unbound.length}`);

  listed = 0;
  const bound = await ssh.runWithConn(fakeConn, () => runWithWorkspaceBinding('/srv/app', async () => refreshSkillsCatalog()));
  check('绑定连接的轮次照常扫远程技能目录(工作区 + 家目录)', listed >= 2, `listDir=${listed}`);
  check('绑定连接的轮次目录同样非空', bound.length > 0, `skills=${bound.length}`);

  ssh.listDir = origListDir;
  ssh.conns.delete('fake:22:u');
  ssh._activeId = null;
  ssh._resetFallbacks?.();
}

// ---- 2: 远程目录卡住时,扫描必须在硬超时内返回上一次目录,不拖住整轮 ----
{
  const fakeConn = { status: 'connected', workspace: '/srv/app', home: '/root', isProbablyBinary: () => false };
  ssh.conns.set('fake:22:u', fakeConn);
  ssh._activeId = 'fake:22:u';
  ssh.status = 'connected';
  ssh.workspace = '/srv/app';
  ssh.home = '/root';
  localFs.workspace = process.cwd();

  const warm = await ssh.runWithConn(fakeConn, () => runWithWorkspaceBinding('/srv/app', async () => refreshSkillsCatalog()));
  check('前置:目录已预热', warm.length > 0, `skills=${warm.length}`);

  const origListDir = ssh.listDir.bind(ssh);
  ssh.listDir = () => new Promise(() => {}); // 永不返回:模拟半死 SFTP
  const t0 = Date.now();
  const after = await ssh.runWithConn(fakeConn, () => runWithWorkspaceBinding('/srv/app', async () => refreshSkillsCatalog()));
  const ms = Date.now() - t0;
  ssh.listDir = origListDir;
  check('扫描超时后返回(≤7s,含硬超时 5s)', ms <= 7000, `${ms}ms`);
  check('超时沿用上一次目录(技能列表不丢)', after.length === warm.length, `${after.length} vs ${warm.length}`);

  ssh.conns.delete('fake:22:u');
  ssh._activeId = null;
  ssh._resetFallbacks?.();
}

// ---- 3: 压缩期间「立即执行」把消息移进 inbox,压缩结束后必须被派发 ----
{
  const events = [];
  const a = new Agent({ emit: (e, p) => events.push([e, p]) });
  a._systemPrompt = () => 'sys';
  a.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake-1', contextWindow: 8000 });
  let release;
  const gate = new Promise((res) => { release = res; });
  let calls = 0;
  a.llm = {
    isMock: false, contextWindow: 8000, maxTokens: 1024,
    async chat() {
      calls += 1;
      if (calls === 1) { await gate; return { content: '【摘要】目标:压缩;已完成:读改写;待办:验证。', toolCalls: [], reasoning: '' }; }
      return { content: '对排队消息的回答', toolCalls: [], reasoning: '' };
    }
  };
  a.llmConfigured = true;

  const sid = a.createSession('压缩期间立即执行').id;
  const rt = a._runtimes.get(sid);
  for (let g = 0; g < 3; g++) {
    const turn = g + 1;
    rt.session.append('turn/start', { turn });
    rt.session.append('user/message', { content: `问题${g}:` + '请分析这个模块的实现细节并给出改造方案。'.repeat(60), source: 'user' });
    rt.session.append('assistant/message', { turn, step: 1, message: { role: 'assistant', content: `回答${g}:` + '这里是一大段实现说明与代码走读结论。'.repeat(60) } });
    rt.session.append('turn/end', { turn, reason: { kind: 'completed' } });
  }
  a.switchSession(sid);

  const p = a.compactNow(sid);
  await tick(10);
  check('前置:压缩进行中', rt.compacting === true);

  a.submit(sid, '排队消息');
  const item = a.queueSnapshot(sid)[0];
  check('前置:消息进入待执行队列', !!item);
  a.steerQueueItem(item.id, sid);
  check('立即执行后队列已清空(消息已移入 inbox)', a.queueSnapshot(sid).length === 0, JSON.stringify(a.queueSnapshot(sid)));

  release();
  const r = await p;
  check('compactNow 报告压缩成功', r.compacted === true, JSON.stringify(r));
  await tick(80);

  const hist = a.getHistory(sid);
  const answered = hist.some((t) => t.role === 'assistant' && String(t.content || '').includes('对排队消息的回答'));
  check('压缩结束后 inbox 里的排队消息被派发执行(不再滞留)', answered, `calls=${calls} turns=${hist.length}`);
  check('派发后会话回到空闲(界面不会一直"运行中")', a.busyIds().length === 0, JSON.stringify(a.busyIds()));
  check('队列已排空', a.queueSnapshot(sid).length === 0);
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
