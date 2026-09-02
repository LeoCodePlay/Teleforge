// 聚焦测试:ssh-manager.readFileChunk 的 maxBytes:0 语义(0=不限制,整文件读取),
// 覆盖 Task 5 对 ssh-manager 的修复(remoteToLocal 依赖的真实 SFTP 读路径)。
// 用 mock SSH 服务器(startMockSsh)走真实 SFTP 往返,不依赖被 monkey-patch 的 fake ssh。
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { startMockSsh } = await import('./mock-ssh-server.js');
const { sshManager: ssh } = await import('../server/core/ssh-manager.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

const root = mkdtempSync(path.join(tmpdir(), 'sshai-rmb-'));
const SSH_PORT = 2399;

// fixture:一个大于默认分块(100k)的二进制文件,用于验证 maxBytes:0 拿到全量
const big = Buffer.alloc(200 * 1024);
for (let i = 0; i < big.length; i++) big[i] = i % 256;
writeFileSync(path.join(root, 'big.bin'), big);
writeFileSync(path.join(root, 'small.txt'), 'hello-maxbytes');

const mock = startMockSsh({ port: SSH_PORT, rootDir: root });
await ssh.connect({
  host: '127.0.0.1', port: SSH_PORT, username: 'tester',
  auth: { type: 'password', password: 'pass' }
});

// 1) 有限 p maxBytes:3 只读前 3 字节 ('hello-maxbytes' 共 14 字节)
const r3 = await ssh.readFileChunk('/small.txt', { maxBytes: 3 });
check('maxBytes:3 截断为 3 字节', r3.buffer.toString('utf8') === 'hel' && r3.size === 14 && r3.truncated === true, JSON.stringify({ buf: r3.buffer.toString(), size: r3.size, truncated: r3.truncated }));

// 2) maxBytes:0 应整文件读取(长度 = 文件字节数,内容与源文件完全一致)
const rFull = await ssh.readFileChunk('/big.bin', { maxBytes: 0 });
check('maxBytes:0 读出整文件长度', rFull.buffer.length === big.length, `got ${rFull.buffer.length}, want ${big.length}`);
check('maxBytes:0 内容逐字节一致', rFull.buffer.equals(big), 'content mismatch');
check('maxBytes:0 truncated=false', rFull.truncated === false && rFull.size === big.length, JSON.stringify({ truncated: rFull.truncated, size: rFull.size }));

// 3) 完整小文件 maxBytes:0 同样全量
const rSmall = await ssh.readFileChunk('/small.txt', { maxBytes: 0 });
check('maxBytes:0 小文件全量', rSmall.buffer.toString('utf8') === 'hello-maxbytes', rSmall.buffer.toString('utf8'));

await ssh.disconnect();
mock.close();

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);