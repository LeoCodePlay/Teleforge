import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { localFs } = await import('../server/local-fs.js');
const { sshManager: ssh } = await import('../server/ssh-manager.js');
const { localToRemote, remoteToLocal } = await import('../server/transfer.js');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

const root = mkdtempSync(path.join(tmpdir(), 'sshai-xfer-'));
const localDir = path.join(root, 'local'); mkdirSync(localDir, { recursive: true });
writeFileSync(path.join(localDir, 'a.txt'), 'AAA');
mkdirSync(path.join(localDir, 'sub'), { recursive: true });
writeFileSync(path.join(localDir, 'sub', 'b.txt'), 'BBB');

// fake 远程:用一个内存对象记录写入(不真连 SSH)
const remoteFs = new Map();
ssh.writeRemoteFile = async (p, buf) => { remoteFs.set(p, Buffer.from(buf).toString('utf8')); return Buffer.from(buf).length; };
ssh.mkdirp = async () => {};
ssh.listDir = async (p) => [{ name: 'x.txt', type: 'file', size: 3 }];
ssh.readFileChunk = async (p) => ({ buffer: Buffer.from('XYZ'), size: 3, truncated: false });
ssh.atype = async (p) => 'file';
ssh.stat = async (p) => ({ isDirectory: () => false, size: 3 });

// local -> remote
const r1 = await localToRemote([path.join(localDir, 'a.txt'), path.join(localDir, 'sub')], '/rem', { onProgress: () => {} });
check('localToRemote 单文件+目录均上传', r1.uploaded === 2 && remoteFs.has('/rem/a.txt') && remoteFs.has('/rem/sub/b.txt'), JSON.stringify([...remoteFs.keys()]));
check('localToRemote 内容正确', remoteFs.get('/rem/a.txt') === 'AAA' && remoteFs.get('/rem/sub/b.txt') === 'BBB');

// remote -> local
const r2 = await remoteToLocal(['/x/x.txt'], path.join(root, 'dl'), { onProgress: () => {} });
check('remoteToLocal 下载写入本地', r2.downloaded === 1 && readFileSync(path.join(root, 'dl', 'x.txt'), 'utf8') === 'XYZ', JSON.stringify(r2));

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);