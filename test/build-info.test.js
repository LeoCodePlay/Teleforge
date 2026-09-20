// 构建版本可见(server/build-info.ts + build_info RPC)回归:
// 桌面端跑的是打包快照 —— 必须能一眼看出「这份包是哪个提交、什么时候打的、有没有带未提交改动」,
// 否则"这个修复到底生效没有"只能靠猜(我们真的为此浪费过一整轮排查)。
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('.');
const tmp = mkdtempSync(join(tmpdir(), 'sshai-buildinfo-'));
const stampFile = join(tmp, 'BUILD.json');
const stamp = {
  version: '9.9.9',
  gitSha: 'abc1234',
  builtAt: '2026-09-20T09:40:00.000Z',
  dirty: true,
  node: 'v22.0.0'
};
writeFileSync(stampFile, JSON.stringify(stamp));

// 必须在 import 之前设好:build-info 首次调用即缓存(进程内不变)
process.env.TF_BUILD_FILE = stampFile;

const { getBuildInfo, buildInfoLine } = await import('../server/build-info.ts');
const { registerConfig } = await import('../server/api/rpc/config.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

console.log('== 打包态:读 BUILD.json ==');
{
  const b = getBuildInfo();
  check('识别为打包快照', b.source === 'packaged', JSON.stringify(b));
  check('版本/提交/构建时间来自构建戳', b.version === '9.9.9' && b.gitSha === 'abc1234' && b.builtAt === stamp.builtAt, JSON.stringify(b));
  check('带未提交改动的标记透传(dirty)', b.dirty === true, JSON.stringify(b));
  check('带上实际运行的入口与 Node 版本(排查跑的是哪个文件)', !!b.entry && !!b.node, JSON.stringify(b));
  check('单行摘要包含版本/来源/sha/时间', /v9\.9\.9 · packaged · abc1234\+dirty · 2026-09-20/.test(buildInfoLine(b)), buildInfoLine(b));
  check('同一进程内结果被缓存(不再重复读盘)', getBuildInfo() === b);
}

console.log('== build_info RPC ==');
{
  // 最小注册器(同 rpc-registry.test.js 的做法):createRpcRouter 会自行注册全部模块,不能重复注册
  const handlers = new Map();
  const rpc = {
    register: (t, h) => { if (handlers.has(t)) throw new Error(`RPC 消息重复注册: ${t}`); handlers.set(t, h); },
    types: () => [...handlers.keys()]
  };
  registerConfig(rpc);
  check('config 模块注册了 build_info', rpc.types().includes('build_info'), rpc.types().join(','));
  const sent = [];
  await handlers.get('build_info')({}, { reply: (p) => sent.push(p), emitStatus: () => {} });
  const msg = sent.find((p) => p.type === 'ok');
  check('build_info 回复 ok 且携带 build', !!msg && !!msg.build, JSON.stringify(sent));
  check('RPC 下发的构建信息与本地一致', msg && msg.build.version === '9.9.9' && msg.build.source === 'packaged', JSON.stringify(msg && msg.build));
}

console.log('== 源码运行态:无 BUILD.json 时现场探测 ==');
{
  // 缓存是进程内的,换个进程测"没有构建戳"的分支
  const script = "import('./server/build-info.ts').then(m => { const b = m.getBuildInfo(); console.log(JSON.stringify({ source: b.source, version: b.version, gitSha: b.gitSha, builtAt: b.builtAt })); });";
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    env: { ...process.env, TF_BUILD_FILE: join(tmp, '不存在.json') },
    encoding: 'utf8',
    timeout: 20000
  });
  let info = null;
  try { info = JSON.parse(String(r.stdout || '').trim().split('\n').pop() || 'null'); } catch { /* 解析失败按 null 处理 */ }
  check('无构建戳时判为源码运行(dev)', info?.source === 'dev', `stdout=${String(r.stdout).trim().slice(0, 200)} stderr=${String(r.stderr).trim().slice(0, 200)}`);
  check('源码运行态 builtAt 为空(不是打包)', info?.builtAt === null, JSON.stringify(info));
  check('源码运行态仍带 package.json 版本与 git sha', !!info?.version && info.version !== '9.9.9', JSON.stringify(info));
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
