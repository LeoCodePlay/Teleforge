// 验证 Agent 本地工具链:假 LLM 驱动 read_local_file + write_local_file,
// 断言本地工具被真实调用且写入落盘(本地工具不依赖 SSH,SSH 断开也应可用)。
// 注意:本测试写会话历史并覆盖 <data>/sessions.json,需在临时目录里隔离运行
// 说明:ESM 静态 import 先于代码执行,故用顶层 await 在导入 agent 前设置 DATA_DIR
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-al-'));
const { Agent } = await import('../server/agent/agent.ts');
const { localFs } = await import('../server/core/local-fs.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

const root = mkdtempSync(path.join(tmpdir(), 'sshai-al-ws-'));
localFs.workspace = root;
writeFileSync(path.join(root, 'note.txt'), 'local content');

const agent = new Agent({ emit: () => {} });
// 本测试验证本地工具链(写入直接落盘),与权限门控无关:默认「变更前确认」模式下
// 写入会弹审批挂起等待作答,这里显式切到完全访问绕开门控
agent.setPermissionMode('full-access');
let calls = 0;
agent.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake' });
agent.llm = {
  isMock: false,
  async chat({ messages, tools }) {
    calls++;
    if (calls === 1) return { content: '', toolCalls: [{ id: 'c1', name: 'read_local_file', arguments: JSON.stringify({ path: path.join(root, 'note.txt') }) }] };
    if (calls === 2) return { content: '', toolCalls: [{ id: 'c2', name: 'write_local_file', arguments: JSON.stringify({ path: 'out.txt', content: 'written' }) }] };
    return { content: '完成', toolCalls: [] };
  }
};

await agent.run('读本地文件再写一个');
check('本地工具链完成', calls === 3, `calls=${calls}`);
check('write_local_file 写入了工作区相对路径', existsSync(path.join(root, 'out.txt')));

// Task 8:工作区信息现在走"运行时上下文"快照消息(对齐 harness runtime-context),
// system prompt 保持纯静态;本地工具使用规则仍在 system prompt 中。
const sys = agent._systemPrompt();
const ctx = agent._buildRuntimeContext();
check('system prompt 为纯静态(不含工作区路径)', !sys.includes(root), '');
check('运行时上下文含本地工作区', ctx.includes('本地工作区') && ctx.includes(root), ctx.slice(0, 200));
check('system prompt 含本地工具规则', sys.includes('run_local_command') || sys.includes('*_local'), '');

// 「不在工作区对话」(全盘模式):会话绑定改为哨兵后,原本会被越界守卫拒绝的绝对路径
// 可以真实写入(边界 = 整台电脑),运行时上下文同步说明全盘边界与绝对路径要求
const { NO_WORKSPACE } = await import('../server/config.ts');
const s2 = agent.createSession('全盘模式会话');
agent.updateSessionLocalWorkspace(s2.id, NO_WORKSPACE);
check('全盘模式:本地工作区被清空并置标记', localFs.workspace === null && localFs.noWorkspace === true);
const outside = path.join(root, '..', 'whole-mode-out.txt');
let wholeCalls = 0;
agent.llm = {
  isMock: false,
  async chat() {
    wholeCalls++;
    if (wholeCalls === 1) return { content: '', toolCalls: [{ id: 'w1', name: 'write_local_file', arguments: JSON.stringify({ path: outside, content: 'whole' }) }] };
    return { content: '完成', toolCalls: [] };
  }
};
await agent.run('在全盘模式写一个工作区外的文件');
check('全盘模式:工作区外的绝对路径写入成功', existsSync(path.resolve(outside)), outside);
const ctxWhole = agent._buildRuntimeContext();
check('全盘模式:运行时上下文声明全盘边界', ctxWhole.includes('不在工作区对话') && ctxWhole.includes('整台电脑'), ctxWhole.slice(0, 260));

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail > 0 ? 1 : 0);
