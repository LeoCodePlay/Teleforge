// 验证 Agent 本地工具链:假 LLM 驱动 read_local_file + write_local_file,
// 断言本地工具被真实调用且写入落盘(本地工具不依赖 SSH,SSH 断开也应可用)。
// 注意:本测试写会话历史并覆盖 <data>/sessions.json,需在临时目录里隔离运行
// 说明:ESM 静态 import 先于代码执行,故用顶层 await 在导入 agent 前设置 DATA_DIR
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-al-'));
const { Agent } = await import('../server/agent/agent.ts');
const { localFs } = await import('../server/local-fs.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

const root = mkdtempSync(path.join(tmpdir(), 'sshai-al-ws-'));
localFs.workspace = root;
writeFileSync(path.join(root, 'note.txt'), 'local content');

const agent = new Agent({ emit: () => {} });
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

// Task 8:system prompt 应描述双工作区(远程 + 本地)并给出本地工具使用规则
const sys = agent._systemPrompt();
check('system prompt 含本地工作区', sys.includes('本地工作区') && sys.includes(root), sys.slice(0, 200));
check('system prompt 含本地工具规则', sys.includes('run_local_command') || sys.includes('*_local'), '');

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail > 0 ? 1 : 0);
