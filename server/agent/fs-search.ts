// 文件发现工具(glob_local / grep_local):移植 deepseek-harness 的 tool-fs-search
// 插件(packages/fs/tool-fs-search)。两者都由**打包的 ripgrep 二进制**驱动
// (@vscode/ripgrep 依赖自带平台包),不依赖系统 rg 是否安装,也不经 shell:
// argv 固定,模型给的 pattern/path/include 只作为独立 argv 元素 —— pattern 走
// `--flag=value` 形式、搜索根放在 `--` 之后,前导 `-` 的值不可能被解析成 flag。
//
// 与既有的 search_local_code 的分工:search_local_code 是"内容搜索"(且在本机
// 无 rg 时会退化成 findstr,丢掉 include 参数);glob_local/grep_local 走内置
// ripgrep,补上"按路径模式发现文件"的能力,并让技能库里写的 Glob/Grep 有落点
// (别名见 registry.ts 的 TOOL_ALIASES)。
//
// 只读工具:自带 access='read' 与 concurrencySafe=true,不参与 tools.ts 的名字表
// 兜底(browser-tools.ts / computer-use-tools.ts 同款做法)。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { localFs } from '../core/local-fs.ts';
import type { ToolDef } from './registry.ts';

/** 单次 glob 内联返回的路径上限(对齐 harness GLOB_MAX_RESULTS) */
export const GLOB_MAX_RESULTS = 100;
/** 单次 grep 内联返回的匹配行上限(对齐 harness GREP_MAX_MATCHES) */
const GREP_MAX_MATCHES = 250;
/** 单行匹配预览的字符上限(对齐 harness GREP_MAX_LINE_BYTES 的意图) */
const GREP_MAX_LINE_CHARS = 2000;
/** 一次搜索允许解析的原始 stdout 上限:超过按溢出处理,避免大仓库把内存打满 */
const RAW_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
/** 单次搜索的进程预算 */
const SEARCH_TIMEOUT_MS = 60_000;
/** 保留的 stderr 诊断尾巴长度 */
const STDERR_MAX_BYTES = 4000;
/**
 * 永不进入的 VCS 元数据目录。每个名字配两条取反 glob:裸形态在遍历时剪枝整个目录,
 * `/**` 形态在"搜索根就在该目录内或等于它"时仍然排除其内容(此时裸形态匹配不到)。
 */
export const VCS_EXCLUDES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];

let rgPathCache: string | null | undefined;

/**
 * 懒解析打包的 ripgrep 二进制路径(进程内记忆化)。
 * 不能写成静态 import:@vscode/ripgrep 在模块求值时就解析平台包,平台包缺失
 * (--omit=optional、安装不完整)会让整个 server 起不来;这里让它只影响
 * glob/grep 两个工具,报一条可操作的错误即可。
 */
async function resolveRgPath(): Promise<string | null> {
  if (rgPathCache !== undefined) return rgPathCache;
  try {
    const mod: any = await import('@vscode/ripgrep');
    const p = mod?.rgPath ?? mod?.default?.rgPath;
    rgPathCache = typeof p === 'string' && p && fs.existsSync(p) ? p : null;
  } catch {
    rgPathCache = null;
  }
  return rgPathCache;
}

/** 把 Windows 反斜杠路径归一成 `/`,与远程工具的输出观感一致 */
const toSlash = (s: string): string => s.replace(/\\/g, '/');

/**
 * 解析搜索根:缺省本地工作区(全盘模式回落用户主目录);相对路径按本地工作区解析,
 * 而不是按服务进程的 cwd(否则模型给相对路径会落到意料之外的地方)。
 */
function resolveRoot(p?: string): { root: string; isFile: boolean } {
  const raw = p && String(p).trim() ? String(p).trim() : (localFs.workspace || localFs.home || '.');
  const base = localFs.workspace || process.cwd();
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(base, raw);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`路径不存在: ${abs}`);
  }
  return { root: abs, isFile: st.isFile() };
}

/** VCS 目录始终排除;node_modules 默认排除(否则宽 pattern 会被依赖目录刷满),但搜索根就在里面时不再排除 */
function excludeArgs(root: string): string[] {
  const args = VCS_EXCLUDES.flatMap((name) => [`--glob=!**/${name}`, `--glob=!**/${name}/**`]);
  if (!root.split(/[\\/]/).includes('node_modules')) {
    args.push('--glob=!**/node_modules', '--glob=!**/node_modules/**');
  }
  return args;
}

interface RgRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** 原始输出超过 RAW_OUTPUT_MAX_BYTES(已提前 kill) */
  overflow: boolean;
  timedOut: boolean;
}

/** 以固定 argv 直接 spawn ripgrep(不经 shell),带输出上限、超时与 abort 转发 */
function runRipgrep(rgPath: string, args: string[], cwd: string, signal?: AbortSignal): Promise<RgRun> {
  return new Promise((resolve) => {
    const child = spawn(rgPath, args, { cwd, windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let overflow = false;
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout: Buffer.concat(chunks).toString('utf8'), stderr, overflow, timedOut });
    };
    const onAbort = () => child.kill();
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, SEARCH_TIMEOUT_MS);
    if (signal?.aborted) child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > RAW_OUTPUT_MAX_BYTES) { overflow = true; child.kill(); return; }
      chunks.push(c);
    });
    child.stderr.on('data', (c: Buffer) => { stderr = (stderr + c.toString('utf8')).slice(-STDERR_MAX_BYTES); });
    child.on('error', (e: any) => { stderr = String(e?.message || e); finish(null); });
    child.on('close', (code) => finish(code));
  });
}

/** 解析二进制 + 执行 + 统一错误面(退出码 1 = 无匹配,是正常结果) */
async function runSearch(args: string[], cwd: string, signal?: AbortSignal): Promise<RgRun> {
  const rgPath = await resolveRgPath();
  if (!rgPath) {
    throw new Error('内置 ripgrep 二进制不可用(@vscode/ripgrep 平台包缺失或被裁剪);请重新安装依赖(npm install)后重试');
  }
  const r = await runRipgrep(rgPath, args, cwd, signal);
  if (r.timedOut) throw new Error(`搜索超时(${SEARCH_TIMEOUT_MS / 1000}s),请收窄 pattern 或 path 后重试`);
  if (r.overflow) throw new Error(`搜索结果过大(超过 ${RAW_OUTPUT_MAX_BYTES / 1024 / 1024}MB),请收窄 pattern 或 path 后重试`);
  if (r.code !== 0 && r.code !== 1) {
    throw new Error(`搜索失败(ripgrep 退出码 ${r.code}):${r.stderr.trim() || '(无错误输出)'}`);
  }
  return r;
}

/** grep 的 include 只接受**单个正向 glob**:空串、`!` 取反、逗号列表都拒绝(花括号内的逗号合法) */
function validateInclude(include: unknown): void {
  if (include === undefined || include === null || include === '') return;
  const s = String(include);
  if (!s.trim()) throw new Error('include 不能是空白字符串');
  if (s.startsWith('!')) throw new Error('include 只支持正向 glob,不支持 "!" 取反');
  let depth = 0;
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) throw new Error('include 只能是单个 glob,不能是逗号分隔的列表(多项请用 {a,b} 花括号)');
  }
}

/** grep 输出行:只归一化首个 ':' 之前的路径部分(反斜杠 → /、去掉 rg 的 './' 前缀),避免改动匹配到的内容本身 */
function normalizeMatchLine(line: string): string {
  const i = line.indexOf(':');
  const out = i > 0 ? toSlash(line.slice(0, i)).replace(/^\.\//, '') + line.slice(i) : line;
  return out.length > GREP_MAX_LINE_CHARS ? out.slice(0, GREP_MAX_LINE_CHARS) + '…[本行过长已截断]' : out;
}

export const fsSearchToolDefs: ToolDef[] = [
  {
    name: 'glob_local',
    description: '按路径 glob 模式在本机查找文件,返回文件路径(不返回目录),按修改时间从新到旧排序。'
      + `单次最多返回 ${GLOB_MAX_RESULTS} 个;底层是内置 ripgrep,支持 ** * ? [] {} 语法(如 "**/*.ts"、"**/*.{json,md}")。`
      + '用于"这个仓库里有哪些 X 文件"这类按文件名/扩展名的发现;按内容搜索请用 grep_local。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式,匹配的是文件路径,如 "**/*.ts"、"src/**/*.test.js"、"**/*.{json,md}"' },
        path: { type: 'string', description: '搜索起点目录,缺省为本地工作区;相对路径按本地工作区解析' }
      },
      required: ['pattern']
    },
    timeoutMs: SEARCH_TIMEOUT_MS + 5_000,
    access: 'read',
    concurrencySafe: true,
    async run({ pattern, path: p }: any, invoke?: any) {
      if (pattern === undefined || pattern === null || String(pattern).trim() === '') throw new Error('pattern 不能为空');
      const { root, isFile } = resolveRoot(p);
      if (isFile) throw new Error(`glob_local 的 path 必须是目录(要看单个文件的内容请用 read_local_file): ${root}`);
      const args = [
        '--files',
        `--glob=${String(pattern)}`,
        '--sort=modified',
        '--no-ignore',
        '--hidden',
        ...excludeArgs(root)
      ];
      // cwd = 搜索根且不传路径参数:ripgrep 输出的就是相对搜索根的路径
      const r = await runSearch(args, root, invoke?.signal);
      const all = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean).map(toSlash);
      if (all.length === 0) return `无匹配文件(pattern=${pattern},根目录=${root})`;
      const shown = all.slice(0, GLOB_MAX_RESULTS);
      const more = all.length - shown.length;
      return `找到 ${all.length} 个匹配文件(按修改时间从新到旧,相对 ${root}):\n`
        + shown.join('\n')
        + (more > 0 ? `\n\n[已达单次上限 ${GLOB_MAX_RESULTS} 个,另有 ${more} 个未列出;请收窄 pattern 或 path]` : '');
    }
  },
  {
    name: 'grep_local',
    description: '用 ripgrep 正则在本机搜索文件内容,返回带行号的匹配行(同一文件的命中连续排列,相对路径)。'
      + `单次最多返回 ${GREP_MAX_MATCHES} 行;遵循 .gitignore、不搜隐藏文件。`
      + '需要命中处的上下文时,再对命中的文件调用 read_local_file。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'ripgrep 正则表达式(如 "registerTools"、"function\\s+\\w+")' },
        path: { type: 'string', description: '要搜索的文件或目录,缺省为本地工作区;相对路径按本地工作区解析' },
        include: { type: 'string', description: '只搜匹配该 glob 的文件,如 "*.ts"、"*.{js,jsx}"(单个正向 glob,不支持逗号列表与 "!" 取反)' }
      },
      required: ['pattern']
    },
    timeoutMs: SEARCH_TIMEOUT_MS + 5_000,
    access: 'read',
    concurrencySafe: true,
    async run({ pattern, path: p, include }: any, invoke?: any) {
      if (pattern === undefined || pattern === null || String(pattern).length === 0) throw new Error('pattern 不能为空');
      validateInclude(include);
      const { root, isFile } = resolveRoot(p);
      // 单文件搜索:在它的父目录里搜该文件名,输出才是相对路径
      const cwd = isFile ? path.dirname(root) : root;
      const target = isFile ? path.basename(root) : '.';
      const args = ['--line-number', '--no-heading', '--color=never', '--with-filename', '--glob=!**/node_modules/**'];
      if (include) args.push(`--glob=${String(include)}`);
      args.push(`--regexp=${String(pattern)}`, '--', target);
      const r = await runSearch(args, cwd, invoke?.signal);
      const lines = r.stdout.split('\n').filter(Boolean);
      if (lines.length === 0) return `无匹配(pattern=${pattern},根目录=${root}${include ? `,include=${include}` : ''})`;
      const shown = lines.slice(0, GREP_MAX_MATCHES).map(normalizeMatchLine);
      const more = lines.length - shown.length;
      // 表头以「匹配结果」开头:前端 SearchRow 的 'path:line:content' 解析器会显式跳过它
      // (与 search_code / search_local_code 的表头保持同一约定)
      return `匹配结果(${lines.length} 行,相对 ${cwd}):\n`
        + shown.join('\n')
        + (more > 0 ? `\n\n[已达单次上限 ${GREP_MAX_MATCHES} 行,另有 ${more} 行未列出;请收窄 pattern / include / path]` : '');
    }
  }
];
