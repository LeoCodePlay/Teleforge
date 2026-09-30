// 「进程中断后自动续跑」回归:后端在生成途中没了(崩溃/被杀/热重启)时,下次启动要接着做——
// 用户口径是"后端正常跑着突然断了就继续",但要挡住两种不该续的情形:
//   ① 用户自己关掉软件再打开(见 store/clean-quit.ts,由 turn-auto-resume-quit.test.js 覆盖);
//   ② 被中断的那一轮本身就是自动续跑发起的 —— 否则"崩溃 → 续跑 → 再崩"会变成死循环。
// 链路闸门(模型没配好、服务器没连回来)也必须生效:续跑不能瞎跑。
// 注意:本测试写会话历史,需在临时 DATA_DIR 里隔离运行。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-autoresume-'));
process.env.LLM_RETRY_BASE_DELAY_MS = '20';
process.env.LLM_RETRY_MAX_DELAY_MS = '60';
process.env.LLM_RETRY_MAX_ATTEMPTS = '2';

const { Agent } = await import('../server/agent/agent.ts');
const sessions = await import('../server/store/session-store.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const finish = () => { console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`); process.exit(fail ? 1 : 0); };
const waitFor = async (fn, timeout = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 15)); }
  return fn();
};

// ---- 假网关:记录每次请求体,回一段最简回复 ----
const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '接着做完了。' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

/** 在磁盘上造一个"生成到一半进程就没了"的会话:turn/start 之后没有 turn/end */
const crashLeftover = (title, { autoStarted = false } = {}) => {
  const meta = sessions.create(title, 'local', {});
  const now = Date.now();
  sessions.saveEvents(meta.id, [
    { seq: 0, time: now, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: now, type: 'step/start', data: { turn: 1, step: 1 } },
    {
      seq: 2, time: now, type: 'user/message',
      data: autoStarted
        ? { content: '[自动续跑] 接着做', display: '↻ 后端中断后自动继续', source: 'auto-resume' }
        : { content: '把这个长任务做完', display: '把这个长任务做完', source: 'user' }
    },
    { seq: 3, time: now, type: 'assistant/message', data: { message: { role: 'assistant', content: '正在做…' } } }
  ]);
  return meta;
};

console.log('== 1) 崩溃遗留:链路没就绪时先等着,不瞎跑 ==');
const meta = crashLeftover('崩溃遗留的长任务');
const agent = new Agent({ emit: () => {} }); // 新实例 = 后端重启
check('自愈出一个"非正常结束"的轮次', agent.session.events.some((e) => e.type === 'notice' && e.data?.kind === 'unclean-shutdown'));
check('该会话被登记为待续跑', agent._autoResume.has(meta.id), `pending=${[...agent._autoResume.keys()]}`);
check('模型还没配置(前端未连上)→ 不急着开轮', agent.busyIds().length === 0);
check('续跑不会在配置前被消费掉', agent._autoResume.size === 1);

console.log('\n== 2) 模型配置到位 → 自动接着上一轮做 ==');
agent.configureLlm({ baseUrl, apiKey: 'test', model: 'deepseek-chat' });
agent._tryAutoResume();
const done = await waitFor(() => {
  const evs = agent.session.events;
  return evs.some((e) => e.type === 'turn/end' && e.data?.turn === 2);
}, 8000);
const evs = agent.session.events;
const resumeMsg = evs.find((e) => e.type === 'user/message' && e.data?.source === 'auto-resume');
check('确实开了新一轮(turn 2 收尾)', !!done, `events=${evs.map((e) => e.type).join(',')}`);
check('续跑的指令来源标记为 auto-resume(不算用户消息)', !!resumeMsg);
check('续跑指令要求"从中断处接着做、不要重做"', /不要重做/.test(String(resumeMsg?.data?.content || '')));
check('气泡只显示一句短提示,不糊整段注入指令', resumeMsg?.data?.display === '↻ 后端中断后自动继续', String(resumeMsg?.data?.display));
check('对话里留下可见的自动续跑提示行', evs.some((e) => e.type === 'notice' && e.data?.kind === 'auto-resume'));
check('「未正常结束」的披露仍然保留(用户能看懂中间发生过什么)',
  evs.some((e) => e.type === 'notice' && e.data?.kind === 'unclean-shutdown'));
check('模型确实收到了续跑指令', seen.some((b) => b.includes('自动续跑')), `请求数=${seen.length}`);
check('续跑完成后不再挂等待项', agent._autoResume.size === 0);
check('续跑产生的消息不会被算成"用户消息"(不影响首条命名/工作区锁定)',
  evs.filter((e) => e.type === 'user/message' && e.data?.source === 'user').length === 1);

console.log('\n== 3) 被中断的那一轮本身就是自动续跑发起的 → 不再续(防崩溃→续跑→再崩死循环) ==');
const agent2 = new Agent({ emit: () => {} });
const meta2 = crashLeftover('续跑中又崩的会话', { autoStarted: true });
const healed2 = agent2._loadHealed(meta2.id);
agent2.configureLlm({ baseUrl, apiKey: 'test', model: 'deepseek-chat' });
agent2._tryAutoResume();
check('自愈时认出了"这一轮是自动续跑发起的"', healed2.openTurnStartedByAutoResume === true);
check('不再登记自动续跑', !agent2._autoResume.has(meta2.id), `pending=${[...agent2._autoResume.keys()]}`);
check('没有多跑出第三轮', !agent2._runtimes.get(meta2.id)?.busy);
check('仍然给出可见披露(由用户决定要不要继续)',
  agent2.getHistory(meta2.id).some((x) => x.kind === 'unclean-shutdown'));

server.close();
finish();
