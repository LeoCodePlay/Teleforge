// 构建版本信息:回答「正在跑的到底是哪份代码」。
// 桌面端跑的是打包时的代码快照(scripts/build.mjs 把 server/ 与 web/dist 复制进安装包),
// 改源码不会自动生效 —— 排查"这个 bug 到底修没修到"时,必须先能一眼看出构建版本。
// 来源优先级:BUILD.json(打包时写入) > 现场探测(git sha + package.json,源码运行态)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // 打包后为 <资源根>/server
const PKG_ROOT = path.resolve(__dirname, '..');                 // 源码运行 = 项目根;打包后 = 资源根

export interface BuildInfo {
  /** 应用版本(package.json / 构建戳) */
  version: string;
  /** 构建时的提交(短 sha);源码运行态为当前 HEAD */
  gitSha: string;
  /** 构建时间(ISO);源码运行态为 null */
  builtAt: string | null;
  /** 构建时工作区有未提交改动(源码运行态为实时判断)—— 用来区分"这份包是干净提交打的"还是"带着本地改动" */
  dirty: boolean;
  /** packaged = 打包快照;dev = 直接跑源码 */
  source: 'packaged' | 'dev';
  /** 实际运行的 Node 版本与入口路径(排查"跑的是哪个文件"最直接) */
  node: string;
  entry: string;
}

let cached: BuildInfo | null = null;

function readJson(p: string | undefined | null): any | null {
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** 构建戳候选位置:环境变量覆盖 / 进程工作目录 / 入口上级目录(打包资源根) / server 同目录 */
function findStamp(): any | null {
  const cands = [
    process.env.TF_BUILD_FILE,
    path.join(process.cwd(), 'BUILD.json'),
    path.join(PKG_ROOT, 'BUILD.json'),
    path.join(__dirname, 'BUILD.json')
  ];
  for (const p of cands) {
    const j = readJson(p);
    if (j && typeof j === 'object' && j.version) return j;
  }
  return null;
}

function git(args: string[]): string {
  try {
    const r = spawnSync('git', args, { cwd: PKG_ROOT, encoding: 'utf8', timeout: 3000 });
    return r.status === 0 ? String(r.stdout || '').trim() : '';
  } catch { return ''; }
}

/** 缓存读取(打包信息在一次进程生命周期内不变) */
export function getBuildInfo(): BuildInfo {
  if (cached) return cached;
  const stamp = findStamp();
  const node = process.version;
  const entry = process.argv[1] || '';
  if (stamp) {
    cached = {
      version: String(stamp.version || '0.0.0'),
      gitSha: String(stamp.gitSha || ''),
      builtAt: stamp.builtAt ? String(stamp.builtAt) : null,
      dirty: stamp.dirty === true,
      source: 'packaged',
      node,
      entry
    };
    return cached;
  }
  const sha = git(['rev-parse', '--short', 'HEAD']);
  cached = {
    version: String(readJson(path.join(PKG_ROOT, 'package.json'))?.version || '0.0.0'),
    gitSha: sha,
    builtAt: null,
    dirty: !!sha && git(['status', '--porcelain']) !== '',
    source: 'dev',
    node,
    entry
  };
  return cached;
}

/** 单行摘要(日志/健康检查用):v0.2.3 · packaged · 4dc0f6 · 2026-09-20T09:40:00Z */
export function buildInfoLine(b: BuildInfo = getBuildInfo()): string {
  return [
    `v${b.version}`,
    b.source,
    b.gitSha ? `${b.gitSha}${b.dirty ? '+dirty' : ''}` : '(无 sha)',
    b.builtAt || '未打包'
  ].join(' · ');
}
