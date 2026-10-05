// 文件发现工具(glob_local / grep_local)测试:验证内置 ripgrep 驱动的"按路径发现文件"
// 与"按内容搜索"真的可用,并锁死三件事:
//   1. 技能库/Claude Code 生态里写的 Glob/Grep 别名能解析到同一份实现,但别名不进模型可见 schema;
//   2. 用户实际诉求的那条 pattern(**/*.{json,md,ts,js,tsx,jsx,rs,py})能返回结果;
//   3. node_modules 默认排除、无匹配不是错误、include 只接受单个正向 glob。
// 运行:node test/glob-grep.test.js
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

// tool-settings 会读 DATA_DIR 下的禁用名单,隔离到临时目录避免受宿主机配置影响
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-glob-'));

const { ToolRegistry } = await import('../server/agent/registry.ts');
const { registerTools } = await import('../server/agent/tools.ts');
const { toolAccess } = await import('../server/agent/permission.ts');
const { localFs } = await import('../server/core/local-fs.ts');

// 造一棵小工作区树(含 node_modules,用来验证默认排除)
const root = mkdtempSync(path.join(tmpdir(), 'sshai-glob-ws-'));
localFs.workspace = root;
mkdirSync(path.join(root, 'src'), { recursive: true });
mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
writeFileSync(path.join(root, 'src', 'a.ts'), 'export function alpha() {}\nconst x = 1;\n');
writeFileSync(path.join(root, 'src', 'b.js'), 'const alpha = 2;\n');
writeFileSync(path.join(root, 'README.md'), '# alpha doc\n');
writeFileSync(path.join(root, 'package.json'), '{ "name": "t" }\n');
writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'alpha in dep\n');

const registry = new ToolRegistry();
registerTools(registry);
const call = (name, args) => registry.execute({ name, args });

// ---- 1. 注册 + 别名 + 远程/本地分工(只影响查找,不重复投影 schema)----
for (const n of ['glob', 'grep', 'glob_local', 'grep_local']) assert.ok(registry.get(n), `${n} 未注册`);
// 未连接 SSH:技能里的 Glob/Grep 回落到本机实现(而不是丢给必然被 SSH 守卫拒绝的远程实现)
assert.equal(registry.get('Glob')?.name, 'glob_local', '未连接时 Glob 应解析到 glob_local');
assert.equal(registry.get('Grep')?.name, 'grep_local', '未连接时 Grep 应解析到 grep_local');
// 远程实现带 remote 标记,未连接时从模型可见 schema 中剔除(localOnly)
assert.equal(registry.get('glob').remote, true, '远程 glob 应带 remote 标记');
assert.equal(registry.get('grep').remote, true, '远程 grep 应带 remote 标记');
const localSchema = registry.schemas({ localOnly: true }).map((s) => s.function.name);
assert.ok(localSchema.includes('glob_local') && localSchema.includes('grep_local'), '本地模式应能看到本机实现');
assert.ok(!localSchema.includes('glob') && !localSchema.includes('grep'), '未连接时远程实现不得进入 schema');
assert.ok(!localSchema.includes('Glob') && !localSchema.includes('Grep'), '别名不得进入模型可见 schema');
// 连接后:Glob/Grep 应优先落到远程实现(远程工作区才是 SSH 会话的主战场)
const { sshManager } = await import('../server/core/ssh-manager.ts');
Object.defineProperty(sshManager, 'active', { configurable: true, get: () => ({ status: 'connected' }) });
assert.equal(sshManager.connected, true, '测试前置:伪造为已连接');
assert.equal(registry.get('Glob')?.name, 'glob', '连接后 Glob 应优先落到远程 glob');
assert.equal(registry.get('Grep')?.name, 'grep', '连接后 Grep 应优先落到远程 grep');
Object.defineProperty(sshManager, 'active', { configurable: true, get: () => null });
assert.equal(registry.get('Glob')?.name, 'glob_local', '断开后应回落本机实现');
console.log('  ✓ 注册与别名(连接时远程优先、未连接回落本机,schema 无重复项)');

// ---- 1b. 未连接时调用远程工具:由 SSH 守卫给出明确拒绝,而不是"未知工具"----
const rRemote = await call('glob', { pattern: '**/*.ts' });
assert.ok(rRemote.isError && /SSH 连接已断开/.test(rRemote.content), rRemote.content);
console.log('  ✓ 未连接调用远程 glob 被 SSH 守卫拒绝(报错可操作)');

// ---- 2. glob_local:用户原始诉求的那条 pattern ----
const r1 = await call('glob_local', { pattern: '**/*.{json,md,ts,js,tsx,jsx,rs,py}' });
assert.ok(!r1.isError, r1.content);
assert.match(r1.content, /src\/a\.ts/, r1.content);
assert.match(r1.content, /src\/b\.js/, r1.content);
assert.match(r1.content, /README\.md/, r1.content);
assert.match(r1.content, /package\.json/, r1.content);
assert.ok(!r1.content.includes('node_modules'), `node_modules 应默认排除:${r1.content}`);
console.log('  ✓ glob_local 用 **/*.{json,md,ts,js,tsx,jsx,rs,py} 命中工作区文件');

// ---- 3. 走别名调用同样可用(技能正文里写的是 Glob)----
const r2 = await call('Glob', { pattern: '**/*.md' });
assert.ok(!r2.isError && /README\.md/.test(r2.content), r2.content);
console.log('  ✓ 用 Glob 别名调用可用');

// ---- 4. 错误面:路径不存在 / path 是文件 ----
const r3 = await call('glob_local', { pattern: '**/*.ts', path: path.join(root, 'nope') });
assert.ok(r3.isError && /路径不存在/.test(r3.content), r3.content);
const r3b = await call('glob_local', { pattern: '**/*.ts', path: path.join(root, 'README.md') });
assert.ok(r3b.isError && /必须是目录/.test(r3b.content), r3b.content);

// ---- 5. grep_local:命中内容带行号,同一文件连续排列 ----
const r4 = await call('grep_local', { pattern: 'alpha', include: '*.{ts,js,md}' });
assert.ok(!r4.isError, r4.content);
assert.match(r4.content, /src\/a\.ts:1:/, r4.content);
assert.match(r4.content, /src\/b\.js:1:/, r4.content);
assert.match(r4.content, /README\.md:1:/, r4.content);
assert.ok(!r4.content.includes('node_modules'), `node_modules 应被排除:${r4.content}`);
assert.ok(!/^\.\//m.test(r4.content), `grep 输出不应带 './' 前缀:${r4.content}`);
console.log('  ✓ grep_local 命中内容并带行号');

// ---- 6. 无匹配是正常结果(不是 isError)----
const r5 = await call('grep_local', { pattern: 'zzz_not_exist_zzz' });
assert.ok(!r5.isError && /无匹配/.test(r5.content), r5.content);
const r5b = await call('glob_local', { pattern: '**/*.no_such_ext' });
assert.ok(!r5b.isError && /无匹配文件/.test(r5b.content), r5b.content);

// ---- 7. include 只接受单个正向 glob ----
const r6 = await call('grep_local', { pattern: 'alpha', include: '*.ts,*.js' });
assert.ok(r6.isError && /单个 glob/.test(r6.content), r6.content);
const r7 = await call('grep_local', { pattern: 'alpha', include: '!*.ts' });
assert.ok(r7.isError && /取反/.test(r7.content), r7.content);
const r8 = await call('grep_local', { pattern: '', include: undefined });
assert.ok(r8.isError && /pattern 不能为空/.test(r8.content), r8.content);

// ---- 8. 权限类别:四个工具都是只读(plan 模式下也放行)----
assert.equal(toolAccess('glob_local', registry.get('glob_local')), 'read');
assert.equal(toolAccess('grep_local', registry.get('grep_local')), 'read');
assert.equal(toolAccess('glob', registry.get('glob')), 'read');
assert.equal(toolAccess('grep', registry.get('grep')), 'read');
for (const n of ['glob', 'grep', 'glob_local', 'grep_local']) {
  assert.equal(registry.get(n).concurrencySafe, true, `${n} 应声明并发安全`);
}

// ---- 9. 远程版:伪造 SSH 连接验证命令构造与结果整形(不依赖真实服务器)----
const cmds = [];
const fakeActive = (exec) => ({
  status: 'connected', platform: 'linux', home: '/home/app', workspace: '/home/app', exec
});
Object.defineProperty(sshManager, 'active', {
  configurable: true,
  get: () => fakeActive(async (cmd) => {
    cmds.push(cmd);
    if (cmd.includes('--files')) return { code: 0, stdout: '/home/app/src/a.ts\n/home/app/README.md\n', stderr: '' };
    return { code: 0, stdout: 'src/a.ts:3:alpha\n', stderr: '' };
  })
});
assert.equal(sshManager.connected, true, '测试前置:伪造为已连接');

const rg = await call('glob', { pattern: '**/*.{json,md}' });
assert.ok(!rg.isError, rg.content);
const globCmd = cmds.find((c) => c.includes('--files'));
assert.ok(globCmd, `未发出 rg --files 命令:${JSON.stringify(cmds)}`);
assert.ok(globCmd.startsWith('rg --files '), globCmd);
assert.ok(globCmd.includes("--glob='**/*.{json,md}'"), globCmd);
assert.ok(globCmd.includes('--sort=modified'), globCmd);
assert.ok(globCmd.includes('--no-ignore') && globCmd.includes('--hidden'), globCmd);
assert.ok(globCmd.includes("--glob='!**/.git'") && globCmd.includes("--glob='!**/.git/**'"), globCmd);
assert.ok(globCmd.includes("--glob='!**/node_modules'"), globCmd);
assert.ok(globCmd.endsWith("-- '/home/app'"), globCmd);
assert.match(rg.content, /^src\/a\.ts$/m, rg.content);
assert.match(rg.content, /^README\.md$/m, rg.content);
assert.ok(!rg.content.includes('/home/app/'), `应输出相对远程工作区的路径:${rg.content}`);
console.log('  ✓ 远程 glob:rg --files 命令正确(引号/排除/排序),输出相对远程工作区');

// 远程 grep 与 search_code 共用内核:结果原样返回
const gr = await call('grep', { pattern: 'alpha', include: '*.ts' });
assert.ok(!gr.isError && /src\/a\.ts:3:alpha/.test(gr.content), gr.content);
const grepCmd = cmds.find((c) => c.includes('-n') && !c.includes('--files'));
assert.ok(grepCmd && grepCmd.includes("-- 'alpha'"), `grep 命令应把 pattern 放在 -- 之后:${grepCmd}`);
console.log('  ✓ 远程 grep:与 search_code 共用内核,返回带行号结果');

// 老版本 rg 不认 --sort:应去掉排序重跑一次,而不是整体失败
cmds.length = 0;
Object.defineProperty(sshManager, 'active', {
  configurable: true,
  get: () => fakeActive(async (cmd) => {
    cmds.push(cmd);
    if (cmd.includes('--sort=modified')) return { code: 2, stdout: '', stderr: 'error: unrecognized flag --sort' };
    return { code: 0, stdout: '/home/app/src/a.ts\n', stderr: '' };
  })
});
const rg2 = await call('glob', { pattern: '**/*.ts' });
assert.ok(!rg2.isError && /src\/a\.ts/.test(rg2.content), rg2.content);
assert.equal(cmds.length, 2, `应先试 --sort 再降级重跑:${JSON.stringify(cmds)}`);
assert.ok(cmds[0].includes('--sort=modified') && !cmds[1].includes('--sort'), JSON.stringify(cmds));
console.log('  ✓ 老版本 rg 不认 --sort 时自动降级重跑');

// 远端只有 grep(无 rg)时:glob 给出可操作报错,而不是静默返回空结果
Object.defineProperty(sshManager, 'active', {
  configurable: true,
  get: () => fakeActive(async (cmd) => (cmd.startsWith('command -v rg') || cmd.startsWith('where rg')
    ? { code: 1, stdout: '', stderr: '' }
    : { code: 0, stdout: '/usr/bin/grep\n', stderr: '' }))
});
const { clearSearchEngine } = await import('../server/agent/tools.ts');
clearSearchEngine();
const rg3 = await call('glob', { pattern: '**/*.ts' });
assert.ok(rg3.isError && /需要 ripgrep/.test(rg3.content), rg3.content);
console.log('  ✓ 远端无 rg 时 glob 报错可操作(不返回假空结果)');

console.log('glob-grep.test.js 全部通过');
process.exit(0);
