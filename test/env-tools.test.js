// 环境自检 + 搜索工具自动安装:ensureSearchTools 在远程缺失搜索工具时按包管理器自动安装,
// 已有工具时幂等、无权限/无包管理器时仅记录不抛错、并发调用合并为同一轮安装、TTL 内命中缓存。
// 用实例方法覆盖 ssh.execBackground 返回预设结果,让自检逻辑可确定性测试(不依赖真实服务器)。
import { ensureSearchTools } from '../server/agent/tools.js';
import { sshManager as ssh } from '../server/ssh-manager.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

const installLog = [];

// 覆盖管理器实例的 execBackground:按规则返回预设结果,统计所有 install 命令
function stubExec(rules) {
  ssh.status = 'connected';
  ssh.platform = 'posix';
  installLog.length = 0;
  ssh.execBackground = async (cmd) => {
    for (const r of rules) {
      const hit = r(cmd);
      if (hit !== undefined) return hit;
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}
// 探测规则:某个 bin 存在于 set 时返回找到,否则未找到
const probeSet = (set) => (cmd) => {
  const m = /^command -v (\S+)$/.exec(cmd.trim());
  if (!m) return undefined;
  return set.has(m[1]) ? { code: 0, stdout: `/usr/bin/${m[1]}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' };
};

// ---- 场景 1:已有 rg(最优工具)→ 无需安装 ----
{
  ssh.hostInfo = { host: 'srv1', port: 22, username: 'u' };
  stubExec([probeSet(new Set(['rg', 'grep']))]);
  const r = await ensureSearchTools({ force: true });
  check('已有 rg 时不安装', r.ok === true && installLog.length === 0 && (r.installed || []).length === 0, JSON.stringify(r));
}

// ---- 场景 2:仅 grep 存在(rg 缺失)→ 搜索链路已可用,不安装 ----
{
  ssh.hostInfo = { host: 'srv2', port: 22, username: 'u' };
  stubExec([probeSet(new Set(['grep']))]);
  const r = await ensureSearchTools({ force: true });
  check('仅 grep 存在时不安装', r.ok === true && installLog.length === 0, JSON.stringify(r));
}

// ---- 场景 3:完全无工具 + root + apt → 自动安装 ripgrep(装好即止,不装 grep/python3) ----
{
  ssh.hostInfo = { host: 'srv3', port: 22, username: 'u' };
  stubExec([
    (cmd) => (/command -v apt-get/.test(cmd) ? { code: 0, stdout: '/usr/bin/apt-get\n', stderr: '' } : undefined),
    (cmd) => (/^id -u/.test(cmd) ? { code: 0, stdout: '0\n', stderr: '' } : undefined),
    probeSet(new Set()),
    (cmd) => { installLog.push(cmd); return /apt-get install -y ripgrep/.test(cmd) ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: '' }; }
  ]);
  const r = await ensureSearchTools({ force: true });
  check('无工具时自动安装 ripgrep', r.ok === true && (r.installed || []).includes('rg'), JSON.stringify(r));
  check('只安装 ripgrep 一轮', installLog.filter((c) => /install/.test(c)).length === 1, installLog.join('\n'));
}

// ---- 场景 4:非 root 且无免密 sudo → 不安装,返回 no-permission ----
{
  ssh.hostInfo = { host: 'srv4', port: 22, username: 'u' };
  stubExec([
    probeSet(new Set()),
    (cmd) => (/^id -u/.test(cmd) ? { code: 1, stdout: '', stderr: '' } : undefined),
    (cmd) => (/^sudo -n true/.test(cmd) ? { code: 1, stdout: '', stderr: '' } : undefined),
    (cmd) => { installLog.push(cmd); return { code: 0, stdout: '', stderr: '' }; }
  ]);
  const r = await ensureSearchTools({ force: true });
  check('无权限时不安装并返回原因', r.ok === false && r.reason === 'no-permission' && installLog.length === 0, JSON.stringify(r));
}

// ---- 场景 5:并发调用合并为同一轮安装 ----
{
  ssh.hostInfo = { host: 'srv5', port: 22, username: 'u' };
  stubExec([
    (cmd) => (/command -v apt-get/.test(cmd) ? { code: 0, stdout: '/usr/bin/apt-get\n', stderr: '' } : undefined),
    (cmd) => (/^id -u/.test(cmd) ? { code: 0, stdout: '0\n', stderr: '' } : undefined),
    probeSet(new Set()),
    (cmd) => { installLog.push(cmd); return /apt-get install -y ripgrep/.test(cmd) ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: '' }; }
  ]);
  const [ra, rb] = await Promise.all([ensureSearchTools({ force: true }), ensureSearchTools({ force: true })]);
  check('并发调用合并,只安装一轮', installLog.filter((c) => /install/.test(c)).length === 1, installLog.join('\n'));
  check('并发调用返回同一结果', (ra.installed || []).includes('rg') && (rb.installed || []).includes('rg'), JSON.stringify([ra, rb]));
}

// ---- 场景 6:安装成功后,TTL 内再次调用命中缓存,不重复探测/安装 ----
{
  const r = await ensureSearchTools(); // 非 force:命中 srv5 的缓存
  check('TTL 内命中缓存不重复安装', r.ok === true && (r.installed || []).includes('rg') && installLog.filter((c) => /install/.test(c)).length === 1, JSON.stringify(r));
}

// ---- 场景 7:win32 平台(如 Windows 服务器)→ 直接返回,无需安装(findstr 原生存在) ----
{
  ssh.hostInfo = { host: 'srv6', port: 22, username: 'u' };
  ssh.platform = 'win32';
  let called = 0;
  ssh.execBackground = async () => { called++; return { code: 0, stdout: '', stderr: '' }; };
  const r = await ensureSearchTools({ force: true });
  check('win32 平台不探测不安装', r.ok === true && called === 0 && (r.installed || []).length === 0, JSON.stringify(r));
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
