// ego(lite) 接入层:把 `ego-browser` CLI 当成一个"浏览器后端"来驱动。
//
// 为什么走 CLI 而不是直连 CDP:ego(lite) 的调试通道是 App 注入到 ego-browser 子进程里的
// `globalThis.ego` 原生绑定,外部进程拿不到;官方给 Agent 的接入方式就是
// `ego-browser nodejs` + 预注入 helper 的脚本。所以这里就按官方姿势来:
//   - 每个动作 = 一次 `ego-browser nodejs` 调用(脚本从 stdin 进,避免 Windows 引号地狱);
//   - 一个批处理 = 一次调用里跑完整段流程(和 ego 自己的设计一致,最省往返);
//   - 脚本用 `console.log('__TF__' + JSON.stringify(...))` 回结构化结果,服务端只认这个标记。
//
// 版本前提:用当前 skill 文档里的 Page API(`taskSpace(name)` / `task.page('p1')` / `page.*`)。
// 老版本如果只有 `useOrCreateTaskSpace` 那套,探测阶段会明确告诉用户升级 ego lite。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const EGO_MARKER = '__TF__';
/** 探测缓存:成功 30s、失败 10s,避免每个工具调用都起一个 Node 进程 */
const PROBE_TTL_OK = 30_000;
const PROBE_TTL_FAIL = 10_000;

let cachedBin: string | null | undefined;
let probeCache: { at: number; ok: boolean; info: Record<string, unknown>; error?: string } | null = null;

/** 找 ego-browser 可执行文件:支持 EGO_BROWSER_BIN 覆盖(测试/自定义安装位置) */
export function egoBinaryPath(): string | null {
  if (cachedBin !== undefined) return cachedBin;
  const fromEnv = String(process.env.EGO_BROWSER_BIN || '').trim();
  if (fromEnv && existsSync(fromEnv)) {
    cachedBin = fromEnv;
    return cachedBin;
  }
  // 常见安装位置:ego lite 的 onboarding 会把它放到 PATH(Windows 是 %LOCALAPPDATA% 下的 shim)
  const names = process.platform === 'win32'
    ? ['ego-browser.cmd', 'ego-browser.exe', 'ego-browser']
    : ['ego-browser'];
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        if (existsSync(p)) { cachedBin = p; return cachedBin; }
      } catch { /* 目录不可读就跳过 */ }
    }
  }
  cachedBin = null;
  return cachedBin;
}

export function resetEgoProbe(): void {
  cachedBin = undefined;
  probeCache = null;
}

export interface EgoRunResult {
  ok: boolean;
  payload?: Record<string, any>;
  stdout: string;
  stderr: string;
  ms: number;
}

/**
 * 跑一段 ego-browser 脚本。脚本必须自己用 console.log('__TF__'+json) 回结果。
 * 这里只负责:喂 stdin、收 stdout/stderr、超时杀掉、把最后一条标记行解析出来。
 */
export function runEgoScript(script: string, { timeoutMs = 60_000 }: { timeoutMs?: number } = {}): Promise<EgoRunResult> {
  const bin = egoBinaryPath();
  if (!bin) {
    return Promise.reject(new Error(
      '没有找到 ego-browser 命令:请先安装 ego lite(https://lite.ego.app/),完成首次引导后重开终端;'
      + '或用环境变量 EGO_BROWSER_BIN 指向它的可执行文件。'
    ));
  }
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const done = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const payload = parseMarker(stdout);
      resolve({
        ok: ok && !!payload && payload.ok !== false,
        payload: payload || (error ? { ok: false, error } : undefined),
        stdout,
        stderr,
        ms: Date.now() - started
      });
    };
    let child;
    try {
      // EGO_BROWSER_BIN 也可以指向一个 .js/.mjs(测试替身或自定义安装):
      // 直接用当前 Node 跑它,省得为了跨平台再包一层 .cmd/.sh
      const asScript = /\.(mjs|cjs|js)$/i.test(bin);
      child = asScript
        ? spawn(process.execPath, [bin, 'nodejs'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn(bin, ['nodejs'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      resolve({ ok: false, payload: { ok: false, error: String(e?.message || e) }, stdout, stderr, ms: Date.now() - started });
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (e: any) => done(false, `ego-browser 启动失败:${e?.message || e}`));
    child.on('close', (code: number | null) => {
      const payload = parseMarker(stdout);
      if (payload) { done(true); return; }
      const tail = (stderr || stdout).trim().split('\n').slice(-3).join(' | ');
      done(false, `ego-browser 退出码 ${code}${tail ? `:${tail.slice(0, 300)}` : '(没有输出)'}`);
    });
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      done(false, `ego-browser 超时(${Math.round(timeoutMs / 1000)}s):脚本没有跑完`);
    }, Math.max(5000, timeoutMs));
    timer.unref?.();
    try {
      child.stdin?.end(script);
    } catch (e: any) {
      done(false, `写入脚本失败:${e?.message || e}`);
    }
  });
}

/** 从 stdout 里取最后一条 __TF__{json} */
export function parseMarker(stdout: string): Record<string, any> | null {
  const lines = String(stdout || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    const at = line.indexOf(EGO_MARKER);
    if (at < 0) continue;
    const json = line.slice(at + EGO_MARKER.length).trim();
    if (!json) continue;
    try {
      const v = JSON.parse(json);
      if (v && typeof v === 'object') return v;
    } catch { /* 继续往前找 */ }
  }
  return null;
}

/**
 * 探测 ego-browser 是否可用、以及是不是新版 API。
 * 结果缓存一小段时间:工具层每次调用都会问一遍(available),不能每次都起进程。
 */
export async function egoProbe(force = false): Promise<{ ok: boolean; info: Record<string, any>; error?: string }> {
  const now = Date.now();
  if (!force && probeCache && now - probeCache.at < (probeCache.ok ? PROBE_TTL_OK : PROBE_TTL_FAIL)) {
    return { ok: probeCache.ok, info: probeCache.info, error: probeCache.error };
  }
  if (!egoBinaryPath()) {
    const miss = { ok: false, info: {}, error: '没有找到 ego-browser 命令(未安装 ego lite 或不在 PATH 上)' };
    probeCache = { at: now, ...miss };
    return miss;
  }
  const script = [
    'console.log("__TF__" + JSON.stringify({',
    '  api: typeof taskSpace === "function" ? "page-v2" : (typeof useOrCreateTaskSpace === "function" ? "legacy" : "unknown"),',
    '  spaces: (typeof listTaskSpaces === "function") ? (await listTaskSpaces()).length : null',
    '}));'
  ].join('\n');
  const r = await runEgoScript(script, { timeoutMs: 20_000 }).catch((e: any) => ({
    ok: false, payload: { ok: false, error: String(e?.message || e) }, stdout: '', stderr: '', ms: 0
  })) as EgoRunResult;
  const info = (r.payload || {}) as Record<string, any>;
  const ok = r.ok && info.api === 'page-v2';
  const error = r.ok
    ? (ok ? undefined : `ego-browser 版本过旧(API=${String(info.api)}):请在 ego lite 里升级到支持 Page API 的版本`)
    : String(info.error || r.stderr || '无法连接 ego lite(确认 App 正在运行)');
  probeCache = { at: now, ok, info, error };
  return { ok, info, error };
}

/** 一段自包含脚本的公共头部:选/建 TaskSpace,拿到 p1 页,以及统一的回结果出口 */
function shim(spaceName: string): string {
  return `
const __tfName = ${JSON.stringify(spaceName)};
const __ok = (o) => console.log("${EGO_MARKER}" + JSON.stringify(Object.assign({ ok: true }, o || {})));
let __task, __page;
try {
  if (typeof taskSpace !== "function") throw new Error("ego-browser 版本过旧:缺少 taskSpace()");
  __task = await taskSpace(__tfName);
  __page = __task.page("p1");
} catch (e) {
  __ok({ ok: false, error: String((e && e.message) || e), code: (e && e.error_code) || null });
  throw e;
}
`;
}

/**
 * 生成并执行一段脚本。body 里可以直接用 __page / __task / __ok。
 * 失败统一转成 Error,消息里带 ego 的 error_code(方便上层区分"用户接管了"这种情况)。
 */
export async function runEgo(spaceName: string, body: string, { timeoutMs = 60_000 }: { timeoutMs?: number } = {}): Promise<Record<string, any>> {
  const script = `${shim(spaceName)}
try {
${body}
} catch (e) {
  __ok({ ok: false, error: String((e && e.message) || e), code: (e && e.error_code) || null });
}
`;
  // 排查生成脚本的问题时:TELEFORGE_EGO_DEBUG=1 会把脚本打到 stderr
  if (process.env.TELEFORGE_EGO_DEBUG === '1') process.stderr.write(`[ego script]\n${script}\n[/ego script]\n`);
  const r = await runEgoScript(script, { timeoutMs });
  const payload = r.payload || {};
  if (!r.ok || payload.ok === false) {
    const code = payload.code ? `${payload.code}:` : '';
    throw new Error(`ego(lite) 执行失败 — ${code}${String(payload.error || r.stderr || '未知错误').split('\n')[0]}`);
  }
  return payload;
}

/** 快照里每条元素行尾的 `[ref=N, loc=..., url=...]` */
const REF_META = /\[ref=([^,\]]+)(?:,\s*([^\]]*))?\]\s*$/;

function shortHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36).slice(-5);
}

export interface EgoSnapshot {
  /** 改写后的文本:ego 的数字 ref 换成本端稳定 ref */
  text: string;
  /** 本端 ref → 可跨进程使用的 locator(没有稳定 locator 的不在表里) */
  refs: Map<string, string>;
  /** 本端 ref → 元素名(报错时更好懂) */
  names: Map<string, string>;
}

/**
 * 把 ego 的快照文本转成"我们这一侧能跨调用使用的 ref"。
 *
 * ego 的 @N 只对**产生它的那个进程里的 refMap** 有效,而每次工具调用都是一个新进程,
 * 所以 @N 不能直接跨调用;但快照行里带了 `loc=...`(稳定选择器),我们就用它做锚点:
 * 同一个 loc 永远映射到同一个 ref(`e` + 短哈希),点它时再把 loc 传给 ego 执行。
 */
export function normalizeEgoSnapshot(raw: string): EgoSnapshot {
  const refs = new Map<string, string>();
  const names = new Map<string, string>();
  const out: string[] = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const m = REF_META.exec(line);
    if (!m) { out.push(line); continue; }
    const meta = m[2] || '';
    const locMatch = /(?:^|,\s*)loc=([^,\]]+)/.exec(meta);
    const loc = locMatch ? locMatch[1].trim() : '';
    const usable = !!loc && loc !== 'unstable' && loc !== 'ambiguous';
    const anchor = usable ? loc : `ref:${m[1]}:${line.slice(0, 40)}`;
    const ref = 'e' + shortHash(anchor);
    if (usable) refs.set(ref, loc.startsWith('loc=') ? loc : `loc=${loc}`);
    const nameMatch = /"([^"]*)"/.exec(line.slice(0, m.index));
    if (nameMatch) names.set(ref, nameMatch[1]);
    const rest = line.slice(0, m.index).replace(/\s+$/, '');
    out.push(`${rest} [ref=${ref}${loc ? `, loc=${loc}` : ''}]`);
  }
  return { text: out.join('\n'), refs, names };
}

/** 把工具层给的 ref 解析成 ego 能用的 locator;不是本端 ref 就原样透传(CSS/text=/loc= 都支持) */
export function egoTarget(ref: string | undefined, selector: string | undefined, text: string | undefined, map: Map<string, string>): string {
  if (ref) {
    const loc = map.get(ref);
    if (loc) return loc;
    // 本端 ref 但表里没有 = 上次快照里 ego 把它标成了 unstable/ambiguous:跨调用没法定位
    if (/^e[a-z0-9]{3,}$/i.test(ref)) {
      throw new Error(`ref ${ref} 没有可跨调用的稳定定位(ego 标记为 unstable/ambiguous),请改用 selector 或 text 指定目标`);
    }
    // 允许模型直接传 ego 原生的 @N / loc= / css
    return ref;
  }
  if (selector) return selector;
  if (text) return `text=${text}`;
  throw new Error('需要提供 ref / selector / text 之一');
}
