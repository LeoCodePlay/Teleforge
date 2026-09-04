// 冒烟验证:优化后的环境快照目录树 + pruneToolResults 投影裁剪 + schemas 缓存
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-smoke-'));
const { localFs } = await import('../server/core/local-fs.ts');
const { getLocalEnvInfo } = await import('../server/agent/tools.ts');
const { toolRegistry } = await import('../server/agent/agent.ts');
const { pruneToolResults, measureMessages, estimateTokens } = await import('../server/agent/compact.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

// ---- 1. get_local_info 的目录树(合成工作区:噪声目录 + 真实结构 + 超量条目) ----
const wsRoot = join(process.env.DATA_DIR, 'ws');
for (const d of ['server/agent', 'server/api', 'web/src', '.git/objects/ff', 'node_modules/react']) {
  mkdirSync(join(wsRoot, d), { recursive: true });
}
writeFileSync(join(wsRoot, '.git/objects/ff/deadbeef'), 'x');
writeFileSync(join(wsRoot, 'node_modules/react/index.js'), 'x');
writeFileSync(join(wsRoot, 'server/agent/agent.ts'), 'export {}');
writeFileSync(join(wsRoot, 'README.md'), '# ws');
for (let i = 0; i < 50; i++) writeFileSync(join(wsRoot, `file${i}.txt`), 'x'); // 超出单目录 40 条上限
localFs.workspace = wsRoot;

const r = await toolRegistry.execute({ name: 'get_local_info', args: '{}' });
const len = String(r.content).length;
check(`环境快照体积受控(${len} 字符,预期 < 8000)`, len < 8000, `got ${len}`);
check('快照含真实结构(server/agent)', r.content.includes('agent/'));
check('快照不含 .git 噪声', !r.content.includes('deadbeef') && !r.content.includes('objects/'));
check('快照不含 node_modules', !r.content.includes('node_modules/'));
check('单目录超量时折叠提示', r.content.includes('另有'), r.content.slice(0, 200));
const cached = getLocalEnvInfo();
check('envCache 快照同步受控', String(cached?.summary || '').length < 8000, `got ${String(cached?.summary || '').length}`);

// ---- 2. pruneToolResults ----
const mk = (role, content, extra = {}) => ({ role, content, ...extra });
const hist = [
  mk('user', 'q0'),
  mk('assistant', '', { tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{}' } }] }),
  mk('tool', 'x'.repeat(5000), { tool_call_id: 'c1' }),
  mk('assistant', '', { tool_calls: [{ id: 'c2', function: { name: 'run_command', arguments: '{}' } }] }),
  mk('tool', 'y'.repeat(2000), { tool_call_id: 'c2' }),
  mk('assistant', '中期结论'),
  mk('assistant', '', { tool_calls: [3, 4, 5, 6, 7, 8, 9, 10].map((i) => ({ id: `c${i}`, function: { name: 'read_file', arguments: '{}' } })) }),
  ...[3, 4, 5, 6, 7, 8, 9, 10].map((i) => mk('tool', `T${i} `.repeat(500), { tool_call_id: `c${i}` })),
  mk('assistant', '最新分析')
];
const before = measureMessages(hist);
const { messages, pruned, charsSaved } = pruneToolResults(hist, { keepRecent: 6, minChars: 1200, headChars: 900, tailChars: 300 });
check('裁剪数量正确(10 条超长里保最近 6,折 4 条)', pruned === 4, `got ${pruned}`);
check('原数组不被修改(日志完整性)', hist[2].content.length === 5000);
check('tool 消息结构保留(role/tool_call_id)', messages[2].role === 'tool' && messages[2].tool_call_id === 'c1');
check('折叠加了回读指引', messages[2].content.includes('早期工具结果已折叠'));
check('折叠保留头尾', messages[2].content.startsWith('x'.repeat(900)) && messages[2].content.endsWith('x'.repeat(300)));
check('最近 6 条结果原样', messages[messages.length - 2].content === 'T10 '.repeat(500));
const after = measureMessages(messages);
check(`估算 token 下降(${Math.round(after)} < ${Math.round(before)},省 ${charsSaved} 字符)`, after < before);
check('assistant/user 消息不受影响', messages[0].content === 'q0' && messages[5].content === '中期结论');
check('空/短结果不折叠', pruneToolResults([mk('tool', 'short', { tool_call_id: 'z' })], { keepRecent: 0, minChars: 1200, headChars: 900, tailChars: 300 }).pruned === 0);

// ---- 3. estimateTokens 校准 ----
check('ASCII 估算按 3 字符/token', estimateTokens('aaaaaaaaaa') === Math.ceil(10 / 3) + 1, `got ${estimateTokens('aaaaaaaaaa')}`);

// ---- 4. schemas() 缓存 + isMutating ----
const s1 = toolRegistry.schemas({ localOnly: true });
const s2 = toolRegistry.schemas({ localOnly: true });
check('schemas() 命中缓存(同一引用)', s1 === s2);
const s3 = toolRegistry.schemas({ localOnly: false });
check('localOnly 变化重建投影', s3 !== s1);
const unregister = toolRegistry.register({ name: 'smoke_probe', description: 'x', parameters: { type: 'object', properties: {}, required: [] }, mutating: true, async run() { return 'ok'; } });
check('新注册工具后缓存失效', toolRegistry.schemas({ localOnly: true }) !== s1);
check('isMutating 读取标记', toolRegistry.isMutating('smoke_probe') === true && toolRegistry.isMutating('read_local_file') === false);
unregister();
check('注销后重建投影内容一致', JSON.stringify(toolRegistry.schemas({ localOnly: true })) === JSON.stringify(s1));

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
