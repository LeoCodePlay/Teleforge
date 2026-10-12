// 回归验证:连接建立期间的平台探测必须真的能把命令发出去。
// bug 现场:_open() 在 'ready' 回调里调用 _probe() 时 status 还是 connecting,
// 而 _execRaw 有 `!this.connected` 守卫 → uname 恒被拒绝(code -1 / stdout 空)→
// 每台 Linux 都被判成 win32;搜索工具探测随之全走 `where`、自动安装被 win32 分支跳过,
// 最终 search_code / grep / glob 永久报「远程未找到可用搜索工具」,home 也恒为 null。
// 修复:_probe 走 internal 通道(只看 client 是否在,不看 status),且判定以 stdout 为准。
// 运行:node test/ssh-probe-platform.test.js
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { SshConnection } from '../server/core/ssh-manager.ts';

// 伪造 ssh2 Client:exec 回调一个假 stream,按命令给出预设输出后 close(code)。
// code 缺省为 undefined,用来模拟"服务器不回 exit-status"的服务器。
function fakeClient(handler) {
  return {
    exec(cmd, _opts, cb) {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      cb(null, stream);
      setTimeout(() => {
        const r = handler(String(cmd).trim()) || {};
        if (r.stdout) stream.emit('data', Buffer.from(r.stdout));
        if (r.stderr) stream.stderr.emit('data', Buffer.from(r.stderr));
        stream.emit('close', r.code, null);
      }, 0);
    },
    end() {}
  };
}

// ---- 1. 核心回归:status 尚未置为 connected 时,探测也必须生效 ----
{
  const conn = new SshConnection();
  conn.client = fakeClient((cmd) => (cmd === 'uname -s'
    ? { stdout: 'Linux\n', code: 0 }
    : { stdout: '/root\n', code: 0 }));
  // _open 的 ready 回调正是这个时序:_probe() 先跑,之后才 _setStatus('connected')
  assert.equal(conn.status, 'disconnected', '测试前置:模拟连接就绪前的状态');
  await conn._probe();
  assert.equal(conn.platform, 'posix', `Linux 应判为 posix,实际 ${conn.platform}`);
  assert.equal(conn.home, '/root', `家目录应为 /root,实际 ${conn.home}`);
  // 对照:修复前的 _probe 就是这么发的(没有 internal),同一条命令必被守卫拒绝——
  // 只有 internal 打开的这条通道能拿到输出,证明上面的结果来自修复本身。
  const raw = await conn._execRaw('uname -s', { timeout: 6000 });
  assert.equal(raw.code, -1, '不经 internal 的调用应被 connected 守卫拒绝');
  assert.equal(String(raw.stdout).trim(), '', '被拒时 stdout 为空,这正是误判 win32 的来源');
  console.log('  ✓ 连接建立期间探测到 posix(修复前会被 connected 守卫拒绝并误判 win32)');
}

// ---- 2. 服务器不回 exit-status(close code 缺失)时,按 stdout 判定 ----
{
  const conn = new SshConnection();
  conn.client = fakeClient((cmd) => (cmd === 'uname -s'
    ? { stdout: 'Linux\n' }
    : { stdout: '/home/app\n' }));
  await conn._probe();
  assert.equal(conn.platform, 'posix', `code 缺失时应按 stdout 判 posix,实际 ${conn.platform}`);
  assert.equal(conn.home, '/home/app');
  console.log('  ✓ exit-status 缺失时仍按 stdout 判定平台');
}

// ---- 3. 远程真的没有 uname(Windows)时,仍判 win32 ----
{
  const conn = new SshConnection();
  conn.client = fakeClient((cmd) => (cmd === 'uname -s'
    ? { stdout: '', stderr: "'uname' 不是内部或外部命令,也不是可运行的程序\n", code: 1 }
    : { stdout: 'C:\\Users\\tester\n', code: 0 }));
  await conn._probe();
  assert.equal(conn.platform, 'win32', `无 uname 输出应判 win32,实际 ${conn.platform}`);
  assert.equal(conn.home, 'C:\\Users\\tester');
  console.log('  ✓ 远程无 uname 输出时仍判 win32(未把 Windows 误判成 posix)');
}

// ---- 4. internal 只给内部探测开口:未连接时外部命令依旧被拒 ----
{
  const conn = new SshConnection();
  conn.client = fakeClient(() => ({ stdout: 'x\n', code: 0 }));
  const blocked = await conn._execRaw('echo hi');
  assert.equal(blocked.code, -1, '未连接时外部命令应被拒绝');
  assert.match(blocked.stderr, /SSH 未连接/);
  const allowed = await conn._execRaw('echo hi', { internal: true });
  assert.equal(allowed.code, 0, 'internal 探测通道应放行');
  assert.equal(allowed.stdout.trim(), 'x');
  console.log('  ✓ 未连接时外部命令仍被拒,仅内部探测通道放行');
}

console.log('\nssh-probe-platform.test.js 全部通过');
