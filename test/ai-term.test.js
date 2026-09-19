// AI 运行终端(AiTermManager)契约测试:
// 本地 PTY 拉起 -> 输出/退出码落库 -> 「运行列表只含运行中终端」/ 日志 / 尺寸 / 删除 的最小闭环。
// 不依赖 SSH(远程分支需要真实服务器),远程路径由 rpc-registry 的注册契约与手工联调覆盖。
// 注:Windows 下 node-pty 的 kill 会拉起 conpty 辅助进程,为避免测试进程树悬挂,
//     本用例只对「一个」运行中的终端执行删除(其余命令均自然退出后再操作)。
import { aiTerms } from '../server/core/ai-term.ts';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 12000, step = 80) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

const isWin = process.platform === 'win32';
const echoCmd = 'echo tf_ai_term_ok';
const longCmd = isWin ? 'ping -n 60 127.0.0.1 > nul' : 'sleep 60';
const failCmd = isWin ? 'cmd /c exit 3' : 'exit 3';

// 事件采集:start/output/exit/removed 必须按语义广播
const events = [];
aiTerms.setHub({ emit: (event, payload) => events.push({ event, payload }) });

console.log('ai-term.test.js');

// ---- 1. 列表初始为空 ----
check('初始列表为空', aiTerms.list().length === 0, `实际 ${aiTerms.list().length}`);

// ---- 2. 拉起的终端立即出现在运行列表里 ----
const echoTerm = await aiTerms.start({ command: echoCmd, label: '回显测试', target: 'local', sid: 's_test' });
check('start 返回终端信息', !!echoTerm.id && echoTerm.label === '回显测试' && echoTerm.target === 'local', JSON.stringify(echoTerm));
check('运行列表包含新终端', aiTerms.list().some((t) => t.id === echoTerm.id));
check('get 返回同一终端', aiTerms.get(echoTerm.id)?.id === echoTerm.id);
check('count 增长', aiTerms.count() >= 1);
check('start 事件已广播', events.some((e) => e.event === 'start' && e.payload.term?.id === echoTerm.id));

// ---- 3. 命令自然结束:状态转 exited、退出码 0、日志可读,且从运行列表消失 ----
const done = await aiTerms.waitForExit(echoTerm.id, 12000);
check('waitForExit 拿到结束状态', done && done.state === 'exited', done ? done.state : '超时未结束');
check('退出码为 0', done && done.exitCode === 0, done ? String(done.exitCode) : '-');
check('日志包含命令输出(保留期内可读)', aiTerms.log(echoTerm.id).includes('tf_ai_term_ok'), JSON.stringify(aiTerms.log(echoTerm.id).slice(-80)));
check('output 事件已广播', events.some((e) => e.event === 'output' && e.payload.id === echoTerm.id));
check('exit 事件已广播', events.some((e) => e.event === 'exit' && e.payload.term?.id === echoTerm.id));
check('已结束终端不再出现在运行列表', !aiTerms.list().some((t) => t.id === echoTerm.id));
check('runningCount 不含已结束终端', aiTerms.runningCount() === 0, String(aiTerms.runningCount()));

// ---- 4. 非零退出码 -> failed(同样从运行列表消失) ----
const failTerm = await aiTerms.start({ command: failCmd, label: '失败测试', target: 'local' });
const failed = await aiTerms.waitForExit(failTerm.id, 12000);
check('非零退出标记 failed', failed && failed.state === 'failed', failed ? `${failed.state}/${failed.exitCode}` : '超时');
check('记录退出码 3', failed && failed.exitCode === 3, failed ? String(failed.exitCode) : '-');
check('失败终端不在运行列表', !aiTerms.list().some((t) => t.id === failTerm.id));

// ---- 5. 长期进程:保持 running、可 resize;删除后终止并移出注册表 ----
const liveTerm = await aiTerms.start({ command: longCmd, label: '常驻测试', target: 'local', sid: 's_test' });
await sleep(700);
check('长期进程保持 running', aiTerms.get(liveTerm.id)?.state === 'running', String(aiTerms.get(liveTerm.id)?.state));
check('运行列表只含运行中终端', aiTerms.list().every((t) => t.state === 'running') && aiTerms.list().some((t) => t.id === liveTerm.id));
check('runningCount 计入长期进程', aiTerms.runningCount() === 1, String(aiTerms.runningCount()));
check('waitForExit 对运行中终端超时返回 null', (await aiTerms.waitForExit(liveTerm.id, 300)) === null);
check('resize 成功', aiTerms.resize(liveTerm.id, 100, 40) === true);
check('resize 未知 id 返回 false', aiTerms.resize('ait-none', 80, 24) === false);
check('删除运行中终端返回 true', (await aiTerms.remove(liveTerm.id)) === true);
check('删除后不在列表', !aiTerms.list().some((t) => t.id === liveTerm.id));
check('删除后 get 为 null', aiTerms.get(liveTerm.id) === null);
check('removed 事件已广播', events.some((e) => e.event === 'removed' && e.payload.id === liveTerm.id));
check('重复删除返回 false', (await aiTerms.remove(liveTerm.id)) === false);

// ---- 6. 已结束终端的删除(保留期内仍可被 get/remove 命中) ----
check('删除已结束终端返回 true', (await aiTerms.remove(echoTerm.id)) === true);
check('已结束终端删除后 get 为 null', aiTerms.get(echoTerm.id) === null);

// ---- 7. removeForSession:按会话清理 ----
const s1 = await aiTerms.start({ command: echoCmd, label: 'A', target: 'local', sid: 's_a' });
const s2 = await aiTerms.start({ command: echoCmd, label: 'B', target: 'local', sid: 's_b' });
await waitFor(() => aiTerms.get(s1.id)?.state !== 'running' && aiTerms.get(s2.id)?.state !== 'running');
await aiTerms.removeForSession('s_a');
check('removeForSession 只清目标会话', aiTerms.get(s1.id) === null && aiTerms.get(s2.id) !== null);

// ---- 8. 清理:clear 后注册表为空 ----
aiTerms.clear();
check('clear 清空注册表', aiTerms.list().length === 0 && aiTerms.count() === 0);
aiTerms.setHub(null);

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
