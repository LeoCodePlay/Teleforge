// 桌面资源打包脚本:产出 src-tauri/resources/ 供 Tauri bundle.resources 打进安装包
// 布局($RESOURCE 根):
//   node/node.exe | node/bin/node   —— Node 运行时(随平台下载固定版本)
//   server/**                       —— 后端源码副本(Node 22.18+ 类型剥离直接运行 .ts)
//   web/dist/**                     —— 前端构建产物(static.ts 按 __dirname 相对计算到 web/dist)
//   node_modules/**                 —— 生产依赖(staging 里 npm ci --omit=dev,获得平台正确的 node-pty 预编译)
// 用法:
//   node scripts/build.mjs                  # 按当前平台下载 Node 运行时(需网络)
//   TF_USE_LOCAL_NODE=1 node scripts/build.mjs  # 用本机 node 代替下载(本地开发)
//   TF_NODE_VERSION=22.20.0 node scripts/build.mjs # 指定 Node 版本(需 >= 22.18)
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'src-tauri', 'resources');
const STAGING = path.join(root, 'desktop', '.staging');

const PLAT = os.platform(); // win32 | darwin | linux
const ARCH = os.arch();     // x64 | arm64
const NODE_VERSION = process.env.TF_NODE_VERSION || '22.22.0';

function nodeAsset(platform, arch) {
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  if (platform === 'win32') {
    return { file: `node-v${NODE_VERSION}-win-${a}.zip`, dir: `node-v${NODE_VERSION}-win-${a}`, bin: 'node.exe' };
  }
  if (platform === 'darwin') {
    return { file: `node-v${NODE_VERSION}-darwin-${a}.tar.gz`, dir: `node-v${NODE_VERSION}-darwin-${a}`, bin: 'bin/node' };
  }
  if (platform === 'linux') {
    return { file: `node-v${NODE_VERSION}-linux-${a}.tar.xz`, dir: `node-v${NODE_VERSION}-linux-${a}`, bin: 'bin/node' };
  }
  throw new Error(`不支持的平台: ${platform}`);
}

/** ① Node 运行时:下载官方发行包并抽出单文件二进制 */
async function fetchNode() {
  const asset = nodeAsset(PLAT, ARCH);
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${asset.file}`;
  console.log(`   下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载 Node 失败(HTTP ${res.status}): ${url}\n请确认版本存在:TF_NODE_VERSION=xxx`);
  const tmp = path.join(os.tmpdir(), asset.file);
  await fsp.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  const extract = path.join(os.tmpdir(), 'teleforge-node-extract');
  await fsp.rm(extract, { recursive: true, force: true });
  await fsp.mkdir(extract, { recursive: true });
  const t = spawnSync('tar', ['-xf', tmp, '-C', extract], { stdio: 'inherit' });
  if (t.status !== 0) throw new Error('解压 Node 失败');
  const dstBin = path.join(OUT, 'node', PLAT === 'win32' ? 'node.exe' : asset.bin);
  await fsp.mkdir(path.dirname(dstBin), { recursive: true });
  await fsp.copyFile(path.join(extract, asset.dir, asset.bin), dstBin);
  await fsp.rm(extract, { recursive: true, force: true });
  await fsp.rm(tmp, { force: true });
}

async function useLocalNode() {
  console.log(`   使用本机 node: ${process.execPath} (版本 ${process.versions.node})`);
  const dstBin = path.join(OUT, 'node', PLAT === 'win32' ? 'node.exe' : 'bin/node');
  await fsp.mkdir(path.dirname(dstBin), { recursive: true });
  await fsp.copyFile(process.execPath, dstBin);
}

/** ② server 源码副本(排除运行时数据/构建产物/依赖) */
async function copyServer() {
  const skipDirs = new Set(['data', 'output', 'node_modules', 'test', '.git']);
  async function walk(s, d) {
    await fsp.mkdir(d, { recursive: true });
    for (const ent of await fsp.readdir(s, { withFileTypes: true })) {
      const sp = path.join(s, ent.name);
      const dp = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        await walk(sp, dp);
      } else if (ent.name.endsWith('.log')) {
        continue;
      } else {
        await fsp.copyFile(sp, dp);
      }
    }
  }
  await walk(path.join(root, 'server'), path.join(OUT, 'server'));
}

/** ④ 生产依赖:staging 里 npm ci --omit=dev,再整体搬入 resources */
async function prepareNodeModules() {
  await fsp.rm(STAGING, { recursive: true, force: true });
  await fsp.mkdir(STAGING, { recursive: true });
  await fsp.copyFile(path.join(root, 'package.json'), path.join(STAGING, 'package.json'));
  await fsp.copyFile(path.join(root, 'package-lock.json'), path.join(STAGING, 'package-lock.json'));
  // Windows 上 npm 是 .cmd 脚本,必须经 cmd.exe 才能直接执行(否则 CreateProcess 找不到入口)
  const r = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm ci --omit=dev'], { cwd: STAGING, stdio: 'inherit' })
    : spawnSync('npm', ['ci', '--omit=dev'], { cwd: STAGING, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('staging 安装生产依赖失败');
  const nm = path.join(OUT, 'node_modules');
  await fsp.mkdir(nm, { recursive: true });
  // 先删残留再拷贝(残留会让后续失败不干净)
  await fsp.rm(nm, { recursive: true, force: true });
  await fsp.cp(path.join(STAGING, 'node_modules'), nm, { recursive: true });
  await fsp.rm(path.join(STAGING, 'node_modules'), { recursive: true, force: true });
  // Tauri 资源嵌入会把 resources/ 整个拷进安装包,node_modules 里 npm 的 .bin
  // 符号链接在 Linux/mac 上是悬空的(指向不存在的 bin 文件),会导致
  // tauri-build 的 build.rs 校验资源路径时 panic。打包出的服务端用不到 .bin,
  // 直接把 .bin 目录与所有符号链接清掉
  await stripBins(nm);
}

/** 递归删除 node_modules 中的 .bin 目录与任何符号链接(Tauri 嵌入依赖真实文件) */
async function stripBins(dir) {
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      await fsp.rm(p, { force: true });
    } else if (ent.isDirectory()) {
      if (ent.name === '.bin') await fsp.rm(p, { recursive: true, force: true });
      else await stripBins(p);
    }
  }
}

async function dirSize(dir) {
  let total = 0;
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    // npm 的 .bin 在 Linux/mac 上是符号链接(指向 ../<pkg>/cli.js),悬空或指向
    // 已剔除的包时 stat 会 ENOENT;符号链接不计体积,直接跳过
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) total += await dirSize(p);
    else total += await fsp.stat(p).catch(() => 0);
  }
  return total;
}

async function main() {
  const t0 = Date.now();
  console.log('== 桌面资源打包 ==');
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(path.join(OUT, 'node'), { recursive: true });

  console.log('① 准备 Node 运行时…');
  if (process.env.TF_USE_LOCAL_NODE === '1') await useLocalNode();
  else await fetchNode();

  console.log('② 拷贝 server 源码…');
  await copyServer();

  console.log('③ 拷贝前端产物 web/dist…');
  const dist = path.join(root, 'web', 'dist');
  if (!fs.existsSync(dist)) throw new Error('web/dist 不存在,请先执行 npm run build');
  await fsp.cp(dist, path.join(OUT, 'web', 'dist'), { recursive: true });

  console.log('④ 安装生产依赖(node-pty 等平台原生模块随本机编译)…');
  await prepareNodeModules();

  if (PLAT !== 'win32') {
    const bin = path.join(OUT, 'node', 'bin', 'node');
    if (fs.existsSync(bin)) fs.chmodSync(bin, 0o755);
  }

  console.log('⑤ 自检…');
  const nodeBin = PLAT === 'win32' ? path.join(OUT, 'node', 'node.exe') : path.join(OUT, 'node', 'bin', 'node');
  const v = spawnSync(nodeBin, ['--version'], { encoding: 'utf8' });
  if (v.status !== 0) throw new Error('打包出的 node 不可执行');
  console.log(`   node ${v.stdout.trim()} ✓`);
  const entry = path.join(OUT, 'server', 'index.ts');
  if (!fs.existsSync(entry)) throw new Error('server/index.ts 缺失');
  console.log(`   server/index.ts ✓`);
  // node-pty 原生绑定必须真实可加载(否则打包出的终端在后端启动即崩);
  // cwd 指向资源根,让 require('node-pty') 解析到 OUT/node_modules
  const pty = spawnSync(nodeBin, ['-e', "require('node-pty')"], { cwd: OUT, encoding: 'utf8' });
  if (pty.status !== 0) throw new Error('node-pty 原生绑定缺失或无法加载,请确认 npm 已允许其 install scripts(allowScripts)');
  console.log(`   node-pty 绑定可加载 ✓`);
  const sizeMB = (await dirSize(OUT)) / 1024 / 1024;
  console.log(`完成:${OUT} 共 ${sizeMB.toFixed(1)} MB,耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await fsp.rm(STAGING, { recursive: true, force: true });
}

main().catch((e) => {
  console.error('打包失败:', e.message);
  process.exit(1);
});
