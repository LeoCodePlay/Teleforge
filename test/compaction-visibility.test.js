// 摘要压缩的可见性回归测试:
// 1) 确定要压缩时先发 compaction_start、后发 compaction_done(成对且有序)——
//    摘要是一次真实 LLM 往返(可能几十秒),对话流必须先有"压缩中"的运行态行;
// 2) compaction_done 广播时,压缩检查点已经在磁盘上(不等整轮结束的 finally 落盘),
//    中途重启/切走也不会丢标记行与模型面治理;
// 3) 没真的压缩就绝不发 start(避免界面挂着永不收尾的运行行);
// 4) 摘要生成失败(或轮次被停止)时不再弹 ⚠ 提示,但必须在记录里落一行「压缩未完成」
//    (compaction/failed):刷新/切回会话后仍能看到"这次没压成、历史没动"。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-compaction-visibility-'));

const { Agent, projectEvents, messageFaceIndexes } = await import('../server/agent/agent.ts');
const { compactHistory } = await import('../server/agent/compact.ts');
const sessions = await import('../server/store/session-store.ts');
const { sshManager: ssh } = await import('../server/core/ssh-manager.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const finish = () => { console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`); if (fail) process.exit(1); };

ssh.status = 'connected';
ssh.platform = 'posix';
ssh.workspace = '/home';
ssh.hostInfo = { host: 'h', port: 22, username: 'u' };
ssh.listDir = async () => ([{ name: 'README.md', type: 'file', size: 10, mtime: 0 }]);

/** 造一个"窗口很小 + 历史很大"的会话,逼出自动摘要压缩 */
function makeAgent({ summaryFails = false } = {}) {
  const events = [];
  const seen = [];
  const agent = new Agent({
    emit: (e, p) => {
      events.push([e, p]);
      if (e === 'agent' && p && (p.event === 'compaction_start' || p.event === 'compaction_done')) {
        // 广播瞬间同步回查磁盘:检查点必须已经落盘(而不是等轮末 finally)
        const onDisk = p.sid ? sessions.loadEvents(p.sid) : [];
        seen.push({
          event: p.event,
          dropCount: p.dropCount,
          diskHasCheckpoint: onDisk.some((ev) => ev.type === 'compaction/done')
        });
      }
    }
  });
  agent.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake' });
  agent.llm = {
    isMock: false,
    model: 'fake',
    contextWindow: 600,      // 水位 = 600×80% = 480 token,历史灌到几千 token 必然超
    maxTokens: 100,
    async chat({ messages }) {
      const isSummary = (messages || []).some((m) => String(m.content || '').includes('checkpoint') || String(m.content || '').includes('压缩'));
      if (isSummary) {
        if (summaryFails) throw new Error('上游摘要失败');
        return { content: '【摘要】早期对话已概括。', toolCalls: [] };
      }
      return { content: '收到。', toolCalls: [] };
    }
  };
  const session = agent.session;
  for (let i = 0; i < 12; i++) {
    session.append('user/message', { content: `历史问题 ${i}:${'甲'.repeat(1200)}`, source: 'user' });
    session.append('assistant/message', { message: { content: `历史回答 ${i}` } });
  }
  return { agent, events, seen };
}

const evNames = (events) => events.filter(([e, p]) => e === 'agent' && p && p.event).map(([, p]) => p.event);

async function main() {
  // ---- 场景 1:自动摘要压缩的 start/done 成对、有序,且 done 时检查点已落盘 ----
  console.log('\n[场景 1] 超水位自动压缩:先 start 后 done,done 广播时检查点已落盘');
  {
    const { agent, events, seen } = makeAgent();
    await agent.run('这是本轮的新问题');
    const names = evNames(events);
    const iStart = names.indexOf('compaction_start');
    const iDone = names.indexOf('compaction_done');
    check('广播了 compaction_start(压缩中)', iStart >= 0, names.join(','));
    check('广播了 compaction_done(压缩完成)', iDone >= 0, names.join(','));
    check('start 在 done 之前', iStart >= 0 && iDone > iStart, `start=${iStart} done=${iDone}`);
    check('start 只发一次(同一次压缩不留多条运行行)', seen.filter((s) => s.event === 'compaction_start').length === 1, `got ${seen.filter((s) => s.event === 'compaction_start').length}`);
    check('start 广播时检查点尚未落盘(此刻确实还在压)', seen.find((s) => s.event === 'compaction_start')?.diskHasCheckpoint === false);
    check('done 广播时检查点已落盘', seen.find((s) => s.event === 'compaction_done')?.diskHasCheckpoint === true);
    const done = seen.find((s) => s.event === 'compaction_done');
    check('done 携带被压缩条数', done && Number(done.dropCount) > 0, `dropCount=${done && done.dropCount}`);
    const sid = agent.sessionId;
    const disk = sessions.loadEvents(sid);
    check('磁盘日志里有 compaction/done 检查点', disk.some((ev) => ev.type === 'compaction/done' && typeof ev.data?.dropThroughSeq === 'number'));
    check('落盘的检查点带 dropCount+manual=false', (() => {
      const cp = disk.filter((ev) => ev.type === 'compaction/done').pop();
      return !!cp && cp.data.manual === false && Number(cp.data.dropCount) > 0;
    })());
  }

  // ---- 场景 2:摘要失败必须**不裁剪**、且把失败如实披露(不留悬空运行行) ----
  // 历史缺陷:摘要失败曾静默"降级为直接裁剪"——用户看不到任何提示,早期对话却被永久丢弃。
  // 现在:运行态行收尾为 failure 态(compaction_failed),历史一条不丢。
  console.log('\n[场景 2] 摘要生成失败:不裁剪 + 披露失败(start/failed 成对,无 done)');
  {
    const { agent, events } = makeAgent({ summaryFails: true });
    // 注意:Agent 构造时会 _restore() 接住"当前作用域最近使用的会话"——场景 1 已经把它的
    // 会话落盘了,所以新 Agent 默认会复用它,makeAgent 写的历史会叠加到场景 1 的历史上
    // (用户消息数 / 事件数都不是本场景自己的)。这里显式新建一个干净会话。
    agent.createSession('摘要失败场景');
    const session = agent.session;
    for (let i = 0; i < 12; i++) {
      session.append('user/message', { content: `历史问题 ${i}:${'甲'.repeat(1200)}`, source: 'user' });
      session.append('assistant/message', { message: { content: `历史回答 ${i}` } });
    }
    const before = session.events.length;
    await agent.run('摘要会失败的问题');
    const names = evNames(events);
    check('start 已发', names.includes('compaction_start'), names.join(','));
    check('failed 已发(运行行被收尾,不会一直转圈)', names.includes('compaction_failed'), names.join(','));
    check('不再发 done(没有换来摘要,不能报"压缩完成")', !names.includes('compaction_done'), names.join(','));
    check('start 在 failed 之前', names.indexOf('compaction_start') < names.indexOf('compaction_failed'));
    const failed = events.filter(([, p]) => p && p.event === 'compaction_failed').map(([, p]) => p).pop();
    check('failed 携带原因(摘要生成失败)', /失败/.test(String(failed?.reason || '')), `reason=${failed?.reason}`);
    check('failed 明确是自动压缩(manual=false)', failed?.manual === false);
    // 新语义:压缩停止不再弹 ⚠ notice(用户明确不要),失败本身落盘成一行安静的记录。
    check('不再弹压缩失败的 ⚠ notice', !events.some(([, p]) => p?.event === 'notice' && p?.kind === 'compaction'), names.join(','));
    const diskFail = sessions.loadEvents(agent.sessionId).find((ev) => ev.type === 'compaction/failed');
    check('失败已落盘(compaction/failed)', !!diskFail && /失败/.test(String(diskFail.data?.reason || '')), JSON.stringify(diskFail));
    const failedRows = projectEvents(sessions.loadEvents(agent.sessionId));
    check('落盘的失败行投影成记录里一行「压缩未完成」', failedRows.some((t) => t.role === 'user' && t.compaction?.failed === true), JSON.stringify(failedRows.filter((t) => t.compaction)));
    check('失败行不进模型上下文(仍是显示面)', agent.getHistory().some((t) => t.compaction?.failed === true) && !agent.session.deriveMessages({ budgetChars: Infinity }).some((m) => Object.prototype.hasOwnProperty.call(m, 'compaction')), JSON.stringify(failedRows.filter((t) => t.compaction)));
    const diskForFaces = sessions.loadEvents(agent.sessionId);
    check('投影与消息面下标仍然同构', projectEvents(diskForFaces).length === messageFaceIndexes(diskForFaces).length,
      `turns=${projectEvents(diskForFaces).length} faces=${messageFaceIndexes(diskForFaces).length}`);
    // 关键:事件日志里不得出现压缩检查点,历史一条都不能少
    const disk = sessions.loadEvents(agent.sessionId);
    check('磁盘日志无 compaction/done 检查点(未压缩就不该有检查点)',
      disk.length > 0 && !disk.some((ev) => ev.type === 'compaction/done'), `diskEvents=${disk.length}`);
    const userMsgs = disk.filter((ev) => ev.type === 'user/message' && ev.data?.source === 'user').length;
    check('早期用户消息一条都没丢(12 条历史 + 本轮 1 条)', userMsgs === 13, `got ${userMsgs}`);
    check('事件日志只增不减(未发生截断)', session.events.length > before,
      `before=${before} after=${session.events.length}`);
  }

  // ---- 场景 3:没真的压缩就不该发 start(水位未到 / 无可压区间) ----
  console.log('\n[场景 3] 未触发压缩时不发 compaction_start');
  {
    let started = 0;
    const r1 = await compactHistory({
      messages: [{ role: 'user', content: '短' }, { role: 'assistant', content: '短' }, { role: 'user', content: '短' }],
      contextWindow: 200000, maxTokens: 100, reservedTokens: 0, onStart: () => { started++; }
    });
    check('未超水位:不压缩也不回调 onStart', started === 0 && r1.compacted === false);

    let started2 = 0;
    const r2 = await compactHistory({
      messages: [{ role: 'user', content: '只有一条' }],
      contextWindow: 100, maxTokens: 10, reservedTokens: 999999, onStart: () => { started2++; }
    });
    check('超水位但无可压区间:不回调 onStart', started2 === 0 && r2.compacted === false);

    // 确定要压缩(区间已选定)时回调一次 onStart;摘要可用才会真的换成摘要
    let started3 = 0;
    const msgs = [];
    for (let i = 0; i < 6; i++) { msgs.push({ role: 'user', content: `问题${i}:${'乙'.repeat(600)}` }); msgs.push({ role: 'assistant', content: `回答${i}` }); }
    const okLlm = { isMock: false, async chat() { return { content: '【摘要】早期对话已概括。', toolCalls: [] }; } };
    const r3 = await compactHistory({
      messages: msgs, llm: okLlm, contextWindow: 600, maxTokens: 100, reservedTokens: 0, onStart: () => { started3++; }
    });
    check('确定要压缩时回调一次 onStart', started3 === 1 && r3.compacted === true, `started=${started3} compacted=${r3.compacted}`);

    // 无可用 LLM(纯本地/未配置)时:曾静默裁剪,现在必须保持完整历史
    let started4 = 0;
    const r4 = await compactHistory({
      messages: msgs, llm: null, contextWindow: 600, maxTokens: 100, reservedTokens: 0, onStart: () => { started4++; }
    });
    check('无可用 LLM 时不裁剪(compacted=false,消息原样)', r4.compacted === false && r4.messages === msgs,
      `compacted=${r4.compacted}`);
  }

  finish();
}
main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
