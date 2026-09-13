// 工具访问类别声明完备性测试(对应 server/agent/registry.ts 的 ToolDef.access
// 与 server/agent/permission.ts 的 fail-closed 判定)
//
// 背景(历史事故):permission.ts 的 toolAccess() 兜底分支曾返回 'read'——
// 意味着任何新增的写类/命令类工具,只要忘记加进 WRITE_TOOLS/COMMAND_TOOLS,
// 就会既**免审批**,又在 plan(只读计划)模式下**照常执行**。
// 现在权威来源改为工具**自己声明**的 access,未声明一律按 'write' 兜底。
//
// 本测试锁死两点:
//   1. 每个真实注册的工具都必须显式声明 access(漏声明 = 该工具会多要审批,虽安全
//      但属配置疏漏,必须显式消掉);
//   2. 声明与"写/命令"语义自洽:mutating 工具不得声明为 'read'。
// 运行:node test/tool-access.test.js
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
// tool-settings 会读 DATA_DIR 下的禁用名单,隔离到临时目录避免受宿主机配置影响
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-access-'));

const { ToolRegistry, DEFAULT_TOOL_ACCESS } = await import('../server/agent/registry.ts');
const { registerTools } = await import('../server/agent/tools.ts');
const { toolAccess } = await import('../server/agent/permission.ts');

const registry = new ToolRegistry();
registerTools(registry);

const all = [...registry.tools.values()];
assert.ok(all.length >= 20, `注册工具数异常:${all.length}`);

// ---- 1. 每个工具都必须显式声明 access ----
const missing = all.filter((t) => !t.access).map((t) => t.name);
assert.deepEqual(missing, [], `以下工具未声明 access(会在 plan 模式下被拒绝、每次都要审批):${missing.join(', ')}`);

// ---- 2. 声明值必须合法 ----
const LEGAL = new Set(['meta', 'read', 'write', 'command']);
for (const t of all) {
  assert.ok(LEGAL.has(t.access), `工具 ${t.name} 的 access 非法:${t.access}`);
}

// ---- 3. mutating 工具不得声明为 read ----
const badMutating = all.filter((t) => t.mutating && t.access === 'read').map((t) => t.name);
assert.deepEqual(badMutating, [], `以下 mutating 工具却声明为只读:${badMutating.join(', ')}`);

// ---- 4. 关键工具的类别断言(防止被顺手改错) ----
const expectAccess = {
  read_file: 'read', list_directory: 'read', search_code: 'read', get_workspace_info: 'read',
  read_local_file: 'read', list_local_dir: 'read', search_local_code: 'read', get_local_info: 'read',
  web_search: 'read',
  write_file: 'write', edit_file: 'write', create_directory: 'write', delete_path: 'write',
  write_local_file: 'write', edit_local_file: 'write', create_local_dir: 'write', delete_local_path: 'write',
  skill_copy_builtin: 'write', generate_image: 'write',
  todo_write: 'meta', skill: 'meta', ask_user_question: 'meta',
  run_command: 'command', run_local_command: 'command'
};
for (const [name, want] of Object.entries(expectAccess)) {
  const def = registry.get(name);
  assert.ok(def, `工具 ${name} 未注册`);
  assert.equal(def.access, want, `工具 ${name} 的 access 应为 ${want},实际 ${def.access}`);
  // 守卫实际使用的判定路径:声明优先
  assert.equal(toolAccess(name, def), want, `toolAccess(${name}) 应取声明值 ${want}`);
}

// ---- 5. 未声明 access 的工具体必须 fail-closed ----
const shadowRegistry = new ToolRegistry();
shadowRegistry.register({ name: 'totally_new_mutating_tool', run: () => '' });
assert.equal(shadowRegistry.get('totally_new_mutating_tool').access, undefined);
assert.equal(toolAccess('totally_new_mutating_tool', shadowRegistry.get('totally_new_mutating_tool')), DEFAULT_TOOL_ACCESS);
assert.equal(DEFAULT_TOOL_ACCESS, 'write', '兜底类别必须是 write(fail-closed)');

console.log(`tool-access.test.js 全部通过(${all.length} 个工具均已声明 access)`);
process.exit(0);
