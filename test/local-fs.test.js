// 本地 FS 适配层测试:listDir/readFileChunk/writeFile/mkdirp/rmdirRecursive/copyPath
// 与 resolveInLocalWorkspace 越界守卫
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { localFs, resolveInLocalWorkspace } = await import('../server/local-fs.js');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

const root = mkdtempSync(path.join(tmpdir(), 'sshai-lfs-'));
const ws = path.join(root, 'ws');
mkdirSync(path.join(ws, 'sub', 'deep'), { recursive: true });
writeFileSync(path.join(ws, 'a.txt'), 'hello');
writeFileSync(path.join(ws, 'sub', 'b.md'), 'nested');
localFs.workspace = ws;

// listDir:先目录后文件、含 size/mtime
const list = await localFs.listDir(ws);
check('listDir 目录在前', list.map(e => e.name).join(',') === 'sub,a.txt' || (list[0].type === 'dir' && list[1].name === 'a.txt'), JSON.stringify(list));
check('listDir 识别目录类型', list.find(e => e.name === 'sub')?.type === 'dir');
check('listDir 识别文件 size', list.find(e => e.name === 'a.txt')?.size === 5);

// readFileChunk 分片 + offset
const r = await localFs.readFileChunk(path.join(ws, 'a.txt'), { maxBytes: 3 });
check('readFileChunk 截断读取', r.buffer.toString('utf8') === 'hel' && r.truncated === true && r.size === 5, JSON.stringify(r));
const r2 = await localFs.readFileChunk(path.join(ws, 'a.txt'), { maxBytes: 100, offset: 1 });
check('readFileChunk offset 生效', r2.buffer.toString('utf8') === 'ello' && r2.truncated === false);

// writeFile 自动建父目录 + 覆盖写
const w = await localFs.writeFile(path.join(ws, 'new', 'x.txt'), 'data');
check('writeFile 自动建父目录', existsSync(path.join(ws, 'new', 'x.txt')) && readFileSync(path.join(ws, 'new', 'x.txt'), 'utf8') === 'data');
check('writeFile 返回字节数', w === 4);

// resolveInLocalWorkspace:相对路径、越界、未设工作区
check('resolveInLocalWorkspace 相对路径解析到工作区内', resolveInLocalWorkspace('sub/b.md') === path.join(ws, 'sub', 'b.md'), resolveInLocalWorkspace('sub/b.md'));
check('resolveInLocalWorkspace 工作区根', resolveInLocalWorkspace('.') === ws);
let threw = false; try { resolveInLocalWorkspace('../outside.txt'); } catch { threw = true; }
check('resolveInLocalWorkspace 越界被拒', threw);
const saved = localFs.workspace; localFs.workspace = null;
let threw2 = false; try { resolveInLocalWorkspace('x'); } catch { threw2 = true; }
check('resolveInLocalWorkspace 未设工作区抛错', threw2);
localFs.workspace = saved;

// copyPath:文件复制 + 目录递归 + 越界(复制到自身内部)
await localFs.copyPath(path.join(ws, 'a.txt'), path.join(ws, 'a-copy.txt'));
check('copyPath 复制文件', readFileSync(path.join(ws, 'a-copy.txt'), 'utf8') === 'hello');
await localFs.copyPath(path.join(ws, 'sub'), path.join(ws, 'sub-copy'));
// fixture 中 b.md 是 sub/b.md(sub-copy/b.md),deep 是独立空目录(sub-copy/deep);
// 用 existsSync 守卫避免未捕获 ENOENT(原简报测试的首个 readFileSync 路径不存在会直接抛错)
check('copyPath 复制目录递归', existsSync(path.join(ws, 'sub-copy', 'deep')) && readFileSync(path.join(ws, 'sub-copy', 'b.md'), 'utf8') === 'nested');
let threw3 = false; try { await localFs.copyPath(path.join(ws, 'sub'), path.join(ws, 'sub', 'inner')); } catch { threw3 = true; }
check('copyPath 复制到自身内部被拒', threw3);

// rmdirRecursive:递归删除 + onProgress 计数
let cnt = 0;
await localFs.rmdirRecursive(path.join(ws, 'sub-copy'), () => { cnt++; });
check('rmdirRecursive 递归删除', !existsSync(path.join(ws, 'sub-copy')) && cnt > 0, `cnt=${cnt}`);

// isProbablyBinary
check('isProbablyBinary 检测 NUL 字节', localFs.isProbablyBinary(Buffer.from([0, 1, 2])) === true);
check('isProbablyBinary 纯文本为 false', localFs.isProbablyBinary(Buffer.from('abc')) === false);

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
