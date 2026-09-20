// 分支(forkSession)不得误报「上一轮对话没有正常结束」。
//
// 回归的线上故障:点任意一条消息的「在新对话中分支」,新建的分支会话里立刻多出一条
// ⚠ 上一轮对话没有正常结束:服务进程在生成中途退出或被重启……
// 根因:forkSession 按"消息面下标"截断(cutAtTurn 返回该消息事件的下标 +1),
// 而它后面还有本轮的结构收尾(step/end、turn/end)。切片因此停在 turn/start 之后、
// turn/end 之前;Session 构造时的自愈 _healOpenTurn 把这种"尾部未闭合"一律当成
// "进程生成中途被杀",于是补了一条崩溃披露——分支是用户主动选的切点,不是异常退出。
// 修法:1) 截断点之后若只剩本轮收尾结构(step/end、turn/end),直接纳入切片(分支日志
//          与源会话在该轮边界上一致,收尾原因保持真实);
//       2) 切片尾部仍未闭合时,构造 Session 带 forkCut:自愈只静默补 turn/end
//          (reason = aborted/fork),不写崩溃披露。
// 同时守住反向边界:磁盘上真正的"崩溃遗留未闭合轮次"仍必须给出披露,不能被一起吞掉。
// 注意:本测试写会话历史,需在临时 DATA_DIR 里隔离运行。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-fork-heal-'));

const { Agent, messageFaceIndexes } = await import('../server/agent/agent.ts');
const { sshManager: ssh } = await import('../server/core/ssh-manager.ts');
const sessions = await import('../server/store/session-store.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const finish = () => { console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`); if (fail) process.exit(1); };

ssh.status = 'connected';
ssh.platform = 'posix';
ssh.workspace = '/home';
ssh.hostInfo = { host: 'h', port: 22, username: 'u' };

function makeFakeLlm() {
  let calls = 0;
  return {
    isMock: false, model: 'fake', contextWindow: 0, maxTokens: 100, apiKey: 'k', baseUrl: 'http://x',
    async chat() { calls += 1; return { content: `第 ${calls} 次回答`, toolCalls: [] }; }
  };
}

function makeAgent() {
  const agent = new Agent({ emit: () => {} });
  agent.llm = makeFakeLlm();
  agent.llmConfigured = true;
  return agent;
}

/** 日志尾部是否还有未闭合的轮次(turn/start 之后没有配对 turn/end) */
function hasOpenTurn(events) {
  let open = false;
  for (const ev of events) {
    if (ev.type === 'turn/start') open = true;
    else if (ev.type === 'turn/end') open = false;
  }
  return open;
}

const kindOf = (turns) => turns.map((x) => x.kind || x.role).join(',');

async function main() {
  // ---- 场景 1:点"第一条 AI 回复"的分支按钮(已完成轮)——最常见的线上路径 ----
  console.log('\n[场景 1] 分支到第一条 AI 回复:不出现崩溃披露,且日志是源会话的忠实前缀');
  const agent = makeAgent();
  await agent.run('第一个问题');
  await agent.run('第二个问题');
  const srcId = agent.getSessionId();
  const srcTurns = agent.getHistory(srcId);
  const srcEvents = agent.session.events;
  const srcTypes = srcEvents.map((e) => e.type);
  const faces = messageFaceIndexes(srcEvents);
  const firstAi = faces.findIndex((i) => srcEvents[i].type === 'assistant/message');
  check('前置:源会话是两轮已正常收尾的对话',
    srcTypes.join(',') === 'turn/start,step/start,user/message,user/message,assistant/message,step/end,turn/end,turn/start,step/start,user/message,assistant/message,step/end,turn/end',
    srcTypes.join(','));

  const forked = agent.forkSession(firstAi);
  const turns = agent.getHistory(forked.id);
  check('分支会话不出现「上一轮对话没有正常结束」', !turns.some((x) => x.kind === 'unclean-shutdown'), kindOf(turns));
  check('分支内容 = 源会话截断到该条消息(后续轮次已去掉)',
    turns.length === firstAi + 1 && turns[turns.length - 1].role === 'assistant', `turns=${kindOf(turns)}`);

  const disk = sessions.loadEvents(forked.id);
  check('分支日志已闭合(没有未配对的 turn/start)', !hasOpenTurn(disk), disk.map((e) => e.type).join(','));
  check('分支日志 = 源会话前缀(收尾结构一并纳入,不靠自愈补)',
    disk.map((e) => e.type).join(',') === srcTypes.slice(0, disk.length).join(','),
    `${disk.map((e) => e.type).join(',')} vs ${srcTypes.slice(0, disk.length).join(',')}`);
  check('该轮收尾原因保持真实(completed,而不是被改写成分支中止)',
    disk.some((e) => e.type === 'turn/end' && e.data?.reason?.kind === 'completed'),
    JSON.stringify(disk.filter((e) => e.type === 'turn/end').map((e) => e.data.reason)));

  const fresh = new Agent({ emit: () => {} }); // 新实例 = 重启/切走再切回
  check('重启后载入分支会话仍不出现崩溃披露',
    !fresh.getHistory(forked.id).some((x) => x.kind === 'unclean-shutdown'),
    kindOf(fresh.getHistory(forked.id)));

  // ---- 场景 2:点"用户消息"的分支按钮(截断点落在轮中间,源日志里后面还有回复) ----
  console.log('\n[场景 2] 分支到用户消息(切点落在轮中间):静默收尾,不误报崩溃');
  const atUser = faces.findIndex((i) => srcEvents[i].type === 'user/message' && srcEvents[i].data?.source === 'user');
  const midFork = agent.forkSession(atUser);
  const midTurns = agent.getHistory(midFork.id);
  check('分支会话不出现「上一轮对话没有正常结束」', !midTurns.some((x) => x.kind === 'unclean-shutdown'), kindOf(midTurns));
  const midDisk = sessions.loadEvents(midFork.id);
  check('分支日志已闭合(自愈静默补了 turn/end)', !hasOpenTurn(midDisk), midDisk.map((e) => e.type).join(','));
  check('收尾原因标为分支中止(cause=fork),不冒充 unclean-shutdown',
    midDisk.some((e) => e.type === 'turn/end' && e.data?.reason?.kind === 'aborted' && e.data.reason.cause === 'fork'),
    JSON.stringify(midDisk.filter((e) => e.type === 'turn/end').map((e) => e.data.reason)));
  const fresh2 = new Agent({ emit: () => {} });
  check('重启后载入仍不出现崩溃披露',
    !fresh2.getHistory(midFork.id).some((x) => x.kind === 'unclean-shutdown'),
    kindOf(fresh2.getHistory(midFork.id)));

  // ---- 场景 3:尾部分支(/fork,-1)行为不变 ----
  console.log('\n[场景 3] 尾部分支(-1):整份克隆,行为不变');
  agent.switchSession(srcId); // 场景 2 已把活跃会话切到分支上,这里切回源会话再尾部分支
  const tail = agent.forkSession(-1);
  const tailTurns = agent.getHistory(tail.id);
  check('尾部分支 turns 与源会话一致', tailTurns.length === srcTurns.length, kindOf(tailTurns));
  check('尾部分支不出现崩溃披露', !tailTurns.some((x) => x.kind === 'unclean-shutdown'), kindOf(tailTurns));
  check('尾部分支日志完整(与源会话事件序列一致)',
    sessions.loadEvents(tail.id).map((e) => e.type).join(',') === srcTypes.join(','));

  // ---- 场景 4:反向边界——磁盘上真正的崩溃遗留仍必须披露 ----
  console.log('\n[场景 4] 真正的崩溃遗留(磁盘上未闭合轮次):披露照旧');
  const meta = sessions.create('崩溃遗留', 'local', {});
  const now = Date.now();
  sessions.saveEvents(meta.id, [
    { seq: 0, time: now, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: now, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, time: now, type: 'user/message', data: { content: '崩溃前我发的问题', source: 'user' } }
  ]);
  const crashed = new Agent({ emit: () => {} }).getHistory(meta.id);
  check('崩溃遗留仍给出「上一轮对话没有正常结束」披露',
    crashed.some((x) => x.kind === 'unclean-shutdown'), kindOf(crashed));
  check('崩溃遗留的用户输入仍在对话里',
    crashed.some((x) => x.role === 'user' && String(x.content).includes('崩溃前我发的问题')), kindOf(crashed));

  finish();
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
