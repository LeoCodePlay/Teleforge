// 回归:压缩「进行中」标志必须覆盖所有压缩路径。
//
// 线上现象:对话里出现了「上下文压缩中…」,切到别的会话再切回来,这一行就不见了
// (要等压缩完成/失败才又冒出来)。前端靠服务端 get_history 的 compacting 标志把运行行补回来
// (compaction_start 只是实时事件、不落盘),而这个标志读的是会话 runtime 的 rt.compacting。
// 常规超水位压缩与手动 /compact 都置了它;**爆窗恢复压缩**只广播 compaction_start 却没置,
// 于是切回来时 get_history 答「不在压缩」,运行行凭空消失。
//
// 不变量:任何一条压缩路径在摘要生成期间,isCompacting(sid) 都必须为 true;结束后复位。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-compacting-flag-'));

const { Agent } = await import('../server/agent/agent.ts');
const store = await import('../server/store/session-store.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const finish = () => { console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`); if (fail) process.exit(1); };

const tick = () => new Promise((r) => setTimeout(r, 0));

function fillConversation(session, groups) {
  for (let g = 0; g < groups; g++) {
    const turn = g + 1;
    session.append('turn/start', { turn });
    session.append('user/message', { content: `问题${g}:` + '请分析这个模块的实现细节并给出改造方案。'.repeat(60), source: 'user' });
    session.append('assistant/message', { turn, step: 1, message: { role: 'assistant', content: `回答${g}:` + '这里是一大段实现说明与代码走读结论。'.repeat(60) } });
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
  }
}

// 第 1 次 chat() = 本步请求 → 抛「爆窗」错误,触发爆窗恢复压缩;第 2 次 = 摘要请求 → 挂起等放行
function overflowGatedAgent() {
  const a = new Agent({ emit: () => {} });
  a._systemPrompt = () => 'sys';
  a.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake-1', contextWindow: 1000000 });
  let release;
  const gate = new Promise((res) => { release = res; });
  let calls = 0;
  a.llm = {
    isMock: false, contextWindow: 1000000, maxTokens: 1024,
    async chat() {
      calls++;
      if (calls === 1) throw new Error("This model's maximum context length is 1000000 tokens");
      if (calls === 2) {
        await gate;
        return { content: '【checkpoint 摘要】目标:治理上下文;已完成:读取与修改;待办:验证。', toolCalls: [], reasoning: '' };
      }
      return { content: '好的', toolCalls: [], reasoning: '' };
    }
  };
  a.llmConfigured = true;
  return { a, release, callCount: () => calls };
}

// ---- 爆窗恢复压缩:摘要生成期间 isCompacting 必须为 true ----
{
  const { a, release, callCount } = overflowGatedAgent();
  const sid = a.createSession('爆窗恢复').id;
  fillConversation(a._runtimes.get(sid).session, 3);
  store.saveEvents(sid, a._runtimes.get(sid).session.events);
  a.switchSession(sid);

  const p = Promise.resolve(a.submit(sid, '干活')).catch(() => {});
  // 等到摘要请求真的挂起(calls===2),此刻正是「压缩中」窗口
  for (let i = 0; i < 200 && callCount() < 2; i++) await tick();

  check('已进入压缩(摘要请求已发出)', callCount() >= 2, `calls=${callCount()}`);
  check('爆窗恢复压缩期间 isCompacting(sid) 为 true(切回来能补回「压缩中」行)', a.isCompacting(sid) === true);

  release();
  await p;
  check('压缩结束后 isCompacting 复位', a.isCompacting(sid) === false);
}

// ---- 常规超水位压缩(非爆窗)同样必须置标志,防止以后回归 ----
{
  const a = new Agent({ emit: () => {} });
  a._systemPrompt = () => 'sys';
  a.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake-1', contextWindow: 1 }); // 极小窗口 → 必压
  let release;
  const gate = new Promise((res) => { release = res; });
  let gated = false;
  a.llm = {
    isMock: false, contextWindow: 1, maxTokens: 1024,
    async chat() {
      gated = true;
      await gate;
      return { content: '【checkpoint 摘要】摘要内容足够短。', toolCalls: [], reasoning: '' };
    }
  };
  a.llmConfigured = true;
  const sid = a.createSession('常规压缩').id;
  fillConversation(a._runtimes.get(sid).session, 3);
  store.saveEvents(sid, a._runtimes.get(sid).session.events);
  a.switchSession(sid);

  const p = Promise.resolve(a.submit(sid, '干活')).catch(() => {});
  for (let i = 0; i < 200 && !gated; i++) await tick();
  check('常规压缩期间 isCompacting(sid) 为 true', a.isCompacting(sid) === true, `gated=${gated}`);
  release();
  await p;
  check('常规压缩结束后复位', a.isCompacting(sid) === false);
}

finish();
