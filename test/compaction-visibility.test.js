// 摘要压缩的可见性回归测试:
// 1) 确定要压缩时先发 compaction_start、后发 compaction_done(成对且有序)——
//    摘要是一次真实 LLM 往返(可能几十秒),对话流必须先有"压缩中"的运行态行;
// 2) compaction_done 广播时,压缩检查点已经在磁盘上(不等整轮结束的 finally 落盘),
//    中途重启/切走也不会丢标记行与模型面治理;
// 3) 没真的压缩就绝不发 start(避免界面挂着永不收尾的运行行);
// 4) 摘要生成失败(降级直接裁剪)同样成对收尾。
// 注意:本测试写会话历史,需在临时 DATA_DIR 里隔离运行。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-compaction-visibility-'));

const { Agent } = await import('../server/agent/agent.ts');
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

  // ---- 场景 2:摘要失败(降级直接裁剪)也必须成对收尾,不留悬空运行行 ----
  console.log('\n[场景 2] 摘要生成失败降级裁剪:start/done 仍成对');
  {
    const { agent, events } = makeAgent({ summaryFails: true });
    await agent.run('摘要会失败的问题');
    const names = evNames(events);
    check('start 已发', names.includes('compaction_start'));
    check('done 已发(降级裁剪同样算压缩完成)', names.includes('compaction_done'));
    check('start 在 done 之前', names.indexOf('compaction_start') < names.indexOf('compaction_done'));
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

    let started3 = 0;
    const msgs = [];
    for (let i = 0; i < 6; i++) { msgs.push({ role: 'user', content: `问题${i}:${'乙'.repeat(600)}` }); msgs.push({ role: 'assistant', content: `回答${i}` }); }
    const r3 = await compactHistory({
      messages: msgs, llm: null, contextWindow: 600, maxTokens: 100, reservedTokens: 0, onStart: () => { started3++; }
    });
    check('确定要压缩时回调一次 onStart', started3 === 1 && r3.compacted === true, `started=${started3} compacted=${r3.compacted}`);
  }

  finish();
}
main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
