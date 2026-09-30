// 「用户主动关掉软件 → 下次打开不要擅自继续」回归(用户明确口径)。
// 标记文件必须在导入 agent 之前写好:它是在模块加载时读取并消费的(见 store/clean-quit.ts),
// 桌面外壳 kill 后端之前会写这个文件,控制台 Ctrl+C 时由服务端自己写。
// 注意:本测试写会话历史,需在临时 DATA_DIR 里隔离运行。
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-quit-'));
const flagPath = join(process.env.DATA_DIR, 'clean-quit.flag');
// 模拟"上次是用户点了退出应用":标记先落盘,再"启动"后端
writeFileSync(flagPath, JSON.stringify({ at: Date.now(), reason: 'app-quit' }));

const { Agent } = await import('../server/agent/agent.ts');
const sessions = await import('../server/store/session-store.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

// 假网关:真被调用就算失败(本用例不该有任何模型请求)
let calls = 0;
const server = http.createServer((req, res) => {
  calls++;
  req.resume();
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

// 造一个"生成到一半进程没了"的会话(内容与崩溃场景完全相同,区别只在退出标记)
const meta = sessions.create('关软件时正在跑的任务', 'local', {});
const now = Date.now();
sessions.saveEvents(meta.id, [
  { seq: 0, time: now, type: 'turn/start', data: { turn: 1 } },
  { seq: 1, time: now, type: 'step/start', data: { turn: 1, step: 1 } },
  { seq: 2, time: now, type: 'user/message', data: { content: '把这个长任务做完', display: '把这个长任务做完', source: 'user' } },
  { seq: 3, time: now, type: 'assistant/message', data: { message: { role: 'assistant', content: '正在做…' } } }
]);

const agent = new Agent({ emit: () => {} }); // 新实例 = 用户重新打开软件
agent.configureLlm({ baseUrl, apiKey: 'test', model: 'deepseek-chat' });
agent._tryAutoResume();
await new Promise((r) => setTimeout(r, 300)); // 给"万一真续跑了"留出暴露时间
agent._tryAutoResume();

check('认出了"上次是用户主动退出"', agent._lastExitClean === true);
check('用户主动退出后重启:不自动续跑', agent._autoResume.size === 0, `pending=${[...agent._autoResume.keys()]}`);
check('没有产生任何模型请求', calls === 0, `calls=${calls}`);
check('没有多开出第二轮', !agent.session.events.some((e) => e.type === 'turn/end' && e.data?.turn === 2));
check('该会话仍然是空闲的(等用户自己发话)', agent.busyIds().length === 0);
check('「未正常结束」的披露依然可见(用户知道上次停在哪)',
  agent.getHistory(meta.id).some((x) => x.kind === 'unclean-shutdown'));
check('披露与自愈结果已落盘', sessions.loadEvents(meta.id).some((e) => e.type === 'turn/end'));
check('标记已被消费(一次退出只影响一次启动)', !existsSync(flagPath));

server.close();
console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
