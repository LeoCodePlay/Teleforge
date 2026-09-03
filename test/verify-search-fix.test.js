// 回归验证:远程其实有 grep,但首次探测失败把 null 永久缓存 → search_code 应能恢复
// 修复前:ensureSearchTools 确认工具有但不清缓存 → 重新探测仍命中 null → 一直误报
// 修复后:ensureSearchTools 确认工具就绪后 clearSearchEngine → 重新探测到 grep → 正常搜索
import { registerTools } from '../server/agent/tools.ts';
import { sshManager as ssh } from '../server/core/ssh-manager.ts';

// ---- mock registry 收集工具 ----
const tools = {};
const registry = {
  register: (def) => { tools[def.name] = def; },
  guard: () => {}
};
registerTools(registry);
const searchCode = tools['search_code'];
if (!searchCode) { console.error('✗ 未找到 search_code 工具'); process.exit(1); }

// ---- stub ssh ----
ssh.status = 'connected';
ssh.platform = 'posix';
ssh.hostInfo = { host: 'srv', port: 22, username: 'root' };
ssh.workspace = '/tmp';
ssh.emit = () => {};

let execMode = 'fail'; // fail: 探测命令全部失败 | okGrep: grep 探测成功

const probe = (cmd, ok) => {
  const m = /^command -v (\S+)$/.exec(cmd.trim());
  if (!m) return undefined;
  const present = (ok && m[1] === 'grep') || (ok && m[1] === 'python3');
  return present
    ? { code: 0, stdout: `/usr/bin/${m[1]}\n`, stderr: '' }
    : { code: 1, stdout: '', stderr: '' };
};

ssh.exec = async (cmd) => {
  const p = probe(cmd, execMode === 'okGrep');
  if (p) return p;
  if (/grep -rn/.test(cmd)) return { code: 0, stdout: '/tmp/a.js:1:hello\n', stderr: '' };
  if (/^id -u/.test(cmd)) return { code: 0, stdout: '0\n', stderr: '' };
  if (/command -v apt-get/.test(cmd)) return { code: 0, stdout: '/usr/bin/apt-get\n', stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};

// execBackground:探测时 grep/python3 始终存在(模拟"远程其实有工具")
ssh.execBackground = async (cmd) => {
  const p = probe(cmd, true);
  if (p) return p;
  if (/^id -u/.test(cmd)) return { code: 0, stdout: '0\n', stderr: '' };
  if (/command -v apt-get/.test(cmd)) return { code: 0, stdout: '/usr/bin/apt-get\n', stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

// 场景 1:探测全失败(模拟瞬时失败) → search_code 抛"未找到"(首次把 null 缓存)
execMode = 'fail';
let threw = null;
try { await searchCode.run({ pattern: 'foo', path: '/tmp' }); } catch (e) { threw = e.message; }
check('首次探测失败时正常报错', threw && threw.includes('未找到可用搜索工具'), String(threw));

// 场景 2:远程实际有 grep(探测恢复) → 修复后应恢复搜索,不再误报
execMode = 'okGrep';
let res = null;
try { res = await searchCode.run({ pattern: 'hello', path: '/tmp' }); } catch (e) { res = 'ERR: ' + e.message; }
check('缓存 null 后远程有工具时恢复搜索', typeof res === 'string' && res.includes('hello'), String(res));

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
