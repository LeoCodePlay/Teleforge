// 写桌面打包的构建戳(src-tauri/resources/BUILD.json),由 scripts/build.mjs 在打包时调用。
// 目的:桌面端跑的是代码快照,必须能一眼看出「这份包是什么时候、哪个提交打的、有没有带本地改动」。
// 单独成脚本:可脱离完整打包流程直接运行(联调/排查时验证解析逻辑)。
//   node scripts/write-build-stamp.mjs                 # 写入默认位置
//   node scripts/write-build-stamp.mjs /tmp/BUILD.json # 写入指定位置(测试用)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_STAMP_FILE = path.join(root, 'src-tauri', 'resources', 'BUILD.json');

function git(args) {
  try {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 3000 });
    return r.status === 0 ? String(r.stdout || '').trim() : '';
  } catch { return ''; }
}

/** 生成并写入构建戳;返回写入的内容(便于调用方打印/断言) */
export function writeBuildStamp(outFile = DEFAULT_STAMP_FILE) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const gitSha = git(['rev-parse', '--short', 'HEAD']);
  const dirty = !!gitSha && git(['status', '--porcelain']) !== '';
  const stamp = {
    version: pkg.version,
    gitSha,
    builtAt: new Date().toISOString(),
    dirty,
    node: process.version
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(stamp, null, 2) + '\n');
  return stamp;
}

// 直接运行(而非被 import)时才写默认位置
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_STAMP_FILE;
  const s = writeBuildStamp(out);
  console.log(`[build-stamp] v${s.version} ${s.gitSha}${s.dirty ? '+dirty' : ''} → ${out}`);
}
