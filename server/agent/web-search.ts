// 免 key 网络搜索,后端 = DuckDuckGo,执行方式 = ddgs Python 库(旧名 duckduckgo-search,新名 ddgs)。
// 三条执行路径,优先用真正的 ddgs Python 库:
//   远程:SSH 已连接时,在服务器上部署并调用 ddgs(缺失自动 pip 安装,root/免密 sudo 优先),
//        python3 -c 跑脚本 —— 服务器能访问 DuckDuckGo 时(如境外 VPS)比本机更可靠
//   本地-python:未连接 SSH 或远程失败时,本机若有 python+ddgs 则优先用它(写临时脚本文件执行)
//   本地-fetch:无 python/缺库/安装失败时的最终兜底,Node fetch 直抓 html.duckduckgo.com(零依赖)
// 无 API Key、无 npm 依赖。query 一律 base64 传给脚本,规避各平台 shell 引号问题。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sshManager as ssh } from '../core/ssh-manager.ts';
import { execLocal } from '../core/local-exec.ts';
import { AGENT } from '../config.ts';

/** 一条搜索结果来源 */
export interface WebSearchSource {
  url: string;
  title?: string;
  /** 摘要片段(DuckDuckGo 网页结果一般没有发布日期,故无 publishedAt) */
  snippet?: string;
  publishedAt?: string;
}

export interface WebSearchOutcome {
  sources: WebSearchSource[];
  /** 本次搜索实际执行的路径:remote = SSH 服务器跑 ddgs,local = 本机 python/fetch */
  source: 'remote' | 'local';
}

export interface WebSearchOptions {
  query: string;
  /** 最多返回条数,缺省 8(对齐 harness tool-web 的 WEB_SEARCH_MAX_RESULTS) */
  maxResults?: number;
  signal?: AbortSignal;
}

/** 结果条数上限 */
const DEFAULT_MAX_RESULTS = 8;

/** 单次搜索总超时(远程含脚本起停) */
const SEARCH_TIMEOUT_MS = 30_000;

/** 函数外声明脚本文件的扩展名 */
const PY_FILE_EXT = '.py';

// ---------------- ddgs 搜索脚本(远程 / 本机共用) ----------------

// DDGS().text() 产出 {title, href, body}(href 已是真实 URL)。query 走 base64(argv[1])。
// 约定:整段只用双引号,便于远程被单引号包裹传给 python3 -c;本机则落临时文件执行。
const DDGS_SEARCH_PYTHON = String.raw`
import sys, json, base64
try:
    from ddgs import DDGS
except ImportError:
    from duckduckgo_search import DDGS
q = base64.b64decode(sys.argv[1]).decode("utf-8")
n = int(sys.argv[2]) if len(sys.argv) > 2 else 8
out = []
try:
    d = DDGS()
    for r in d.text(q, max_results=n):
        href = r.get("href") or ""
        title = (r.get("title") or "").strip()
        if not href or not title:
            continue
        out.append({"url": href, "title": title, "snippet": (r.get("body") or "").strip()})
except Exception as e:
    sys.stderr.write("ddgs error: %s\n" % e)
    sys.exit(3)
sys.stdout.write(json.dumps(out, ensure_ascii=False))
`;

function shQuote(s: string): string { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/** 平台感知引号:Windows cmd 不认单引号,用双引号;POSIX 用单引号 */
function shq(s: string): string { return process.platform === 'win32' ? `"${String(s).replace(/"/g, '""')}"` : shQuote(s); }

const b64 = (s: string) => Buffer.from(String(s), 'utf8').toString('base64');

/** 解析 ddgs 脚本的 JSON 输出为来源列表 */
function parseDdgsJson(text: string): WebSearchSource[] {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('搜索无输出');
  let parsed: any;
  try { parsed = JSON.parse(trimmed); } catch { throw new Error(`搜索输出无法解析: ${trimmed.slice(0, 200)}`); }
  if (!Array.isArray(parsed)) throw new Error('搜索输出不是数组');
  return parsed.map((s: any) => ({
    url: String(s?.url || ''),
    ...(s?.title ? { title: String(s.title) } : {}),
    ...(s?.snippet ? { snippet: String(s.snippet) } : {})
  })).filter((s: WebSearchSource) => s.url);
}

/** 把脚本 stderr 映射为可读错误 */
function ddgsErr(err: string): string {
  const e = String(err || '');
  if (/ratelimit|202/i.test(e)) return 'DuckDuckGo 限流(202),请稍后重试';
  if (/captcha|challenge/i.test(e)) return 'DuckDuckGo 触发了验证码,请稍后重试';
  return e.slice(0, 300);
}

// ---------------- 远程路径:SSH 服务器上用 ddgs Python 库 ----------------

/** 远端 Python 命令:仅 POSIX 支持 python3 -c(POSIX 才保证单引号包裹可靠);Windows 远端回落本机 */
function remotePython(): string { return ssh.platform === 'win32' ? '' : 'python3'; }

// ddgs 部署结果按服务器 + TTL 缓存,避免每次搜索都重新探测/安装
const DDGS_ENSURE_TTL_MS = 10 * 60_000;
let ddgsEnsurePromise: Promise<boolean> | null = null;
let ddgsEnsureCache: { key: string; at: number; ok: boolean } | null = null;

function ddgsConnKey(): string {
  const hi: any = ssh.hostInfo || {};
  return hi.host ? `${hi.username}@${hi.host}:${hi.port}` : 'local';
}

/**
 * 确保远程可 import ddgs;缺失时自动 pip 安装(root 或免密 sudo)。
 * 返回 true=已可用,false=不可用(调用方据此回落本机)。
 */
function ensureRemoteDdgs(): Promise<boolean> {
  const key = ddgsConnKey();
  if (ddgsEnsureCache && ddgsEnsureCache.key === key && Date.now() - ddgsEnsureCache.at < DDGS_ENSURE_TTL_MS) {
    return Promise.resolve(ddgsEnsureCache.ok);
  }
  if (!ddgsEnsurePromise) {
    ddgsEnsurePromise = doEnsureRemoteDdgs(key)
      .then((ok) => { ddgsEnsureCache = { key, at: Date.now(), ok }; return ok; })
      .finally(() => { ddgsEnsurePromise = null; });
  }
  return ddgsEnsurePromise;
}

async function doEnsureRemoteDdgs(key: string): Promise<boolean> {
  const py = remotePython();
  if (!py || !ssh.connected) return false;
  const probe = (mod: string) => ssh.exec(`${py} -c "import ${mod}"`, { timeout: 15000 })
    .then((r: any) => r.code === 0)
    .catch(() => false);
  // 新旧包名都探一遍
  if (await probe('ddgs')) return true;
  if (await probe('duckduckgo_search')) return true;
  // 安装:root 直接装;非 root 需免密 sudo(-n 不交互)
  const uid = await ssh.exec('id -u', { timeout: 8000 }).catch(() => null);
  const isRoot = uid && uid.code === 0 && String(uid.stdout || '').trim() === '0';
  let sudo = '';
  if (!isRoot) {
    const s = await ssh.exec('sudo -n true', { timeout: 8000 }).catch(() => null);
    if (!s || s.code !== 0) return false;
    sudo = 'sudo -n ';
  }
  const pipInstall = `${sudo}${py} -m pip install -U --quiet ddgs`;
  let r = await ssh.exec(pipInstall, { timeout: 180_000 }).catch(() => null);
  if (!r || r.code !== 0) {
    // PEP 668(externally-managed)等场景:pip 会拒绝系统级安装,加 --break-system-packages 重试
    r = await ssh.exec(`${pipInstall} --break-system-packages`, { timeout: 180_000 }).catch(() => null);
  }
  if (!r || r.code !== 0) return false;
  return probe('ddgs');
}

/** 在 SSH 服务器上跑 ddgs 搜索脚本,解析 JSON 输出 */
async function searchRemote(query: string, maxResults: number): Promise<WebSearchSource[]> {
  const py = remotePython();
  if (!py) throw new Error('Windows 远端不支持在服务器上跑 python 搜索');
  if (!(await ensureRemoteDdgs())) {
    throw new Error('远程缺少 ddgs 且自动安装失败(需 root 或免密 sudo;也可手动执行 pip install ddgs)');
  }
  const cmd = `${py} -c ${shQuote(DDGS_SEARCH_PYTHON)} ${shQuote(b64(query))} ${maxResults}`;
  const res = await ssh.exec(cmd, { timeout: SEARCH_TIMEOUT_MS });
  const err = String(res.stderr || '').trim();
  if (res.code !== 0) throw new Error(`远程 ddgs 执行失败(退出码 ${res.code}): ${ddgsErr(err) || '(无输出)'}`);
  return parseDdgsJson(String(res.stdout || ''));
}

// ---------------- 本机-python 路径:python + ddgs 库(写临时脚本文件执行,规避 Windows 引号问题) ----------------

let localDdgs: { at: number; bin: string | null } = { at: 0, bin: null };
const LOCAL_DDGS_TTL_MS = 10 * 60_000;

/** 找到本机可用的 python 并确保 ddgs 可 import(缺失尝试静默安装);返回 python 命令或 null */
async function ensureLocalDdgs(force = false): Promise<string | null> {
  if (!force && Date.now() - localDdgs.at < LOCAL_DDGS_TTL_MS) return localDdgs.bin;
  const candidates = process.platform === 'win32' ? ['python', 'py -3'] : ['python3', 'python'];
  const canImport = async (bin: string, mod: string) => {
    const r = await execLocal(`${bin} -c "import ${mod}"`, { timeout: 15000 });
    return r.code === 0;
  };
  let found: string | null = null;
  for (const bin of candidates) {
    if (await canImport(bin, 'ddgs') || await canImport(bin, 'duckduckgo_search')) { found = bin; break; }
  }
  if (!found) {
    // 有 python 但缺库:尝试静默安装(用户要求部署该工具);失败则交给 fetch 兜底
    for (const bin of candidates) {
      const probePy = await execLocal(`${bin} -c "import sys"`, { timeout: 15000 });
      if (probePy.code !== 0) continue;
      let inst = await execLocal(`${bin} -m pip install -U --quiet ddgs`, { timeout: 180_000 });
      if (inst.code !== 0) inst = await execLocal(`${bin} -m pip install -U --quiet --break-system-packages ddgs`, { timeout: 180_000 });
      if (inst.code === 0 && await canImport(bin, 'ddgs')) { found = bin; }
      break;
    }
  }
  localDdgs = { at: Date.now(), bin: found };
  return found;
}

/** 本机用 ddgs 库搜索:脚本落临时文件再执行,query 走 base64,规避 cmd/bash 引号问题 */
async function searchLocalPython(bin: string, query: string, maxResults: number): Promise<WebSearchSource[]> {
  const file = path.join(os.tmpdir(), `teleforge_ddgs_${process.pid}_${Date.now()}${PY_FILE_EXT}`);
  try {
    fs.writeFileSync(file, DDGS_SEARCH_PYTHON, 'utf8');
    const res = await execLocal(`${bin} ${shq(file)} ${shq(b64(query))} ${maxResults}`, { timeout: SEARCH_TIMEOUT_MS });
    if (res.timedOut) throw new Error('本地搜索超时');
    if (res.code !== 0) throw new Error(`本地 ddgs 执行失败(退出码 ${res.code}): ${ddgsErr(String(res.stderr || '')) || '(无输出)'}`);
    return parseDdgsJson(String(res.stdout || ''));
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

// ---------------- 本机-fetch 兜底:Node fetch 直抓 html.duckduckgo.com ----------------

/** 浏览器 UA:DDG 对无 UA/机器人 UA 直接 403 */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** DDG 反爬/验证码标记 */
const CAPTCHA_MARKER = 'anomaly-modal__mask';

/** 标题链接块:class="result__a" href="<ddg 跳转链接>">title</a> */
const RE_TITLE = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis;
/** 摘要块:任意含 result__snippet 类的标签 */
const RE_SNIPPET = /<[a-z]+[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)<\/[a-z]+>/gis;
const RE_TAG = /<[^>]+>/g;

/** 从 DDG 跳转链接(href)解码出真实 URL:html 结果的 href 是 //duckduckgo.com/l/?uddg=<编码后的真实地址> */
function decodeDdgUrl(href: string): string {
  let real = href;
  if (href.includes('uddg=')) {
    const m = /uddg=([^&]+)/.exec(href);
    if (m) {
      try { real = decodeURIComponent(m[1]); } catch { real = m[1]; }
    }
  }
  if (real.startsWith('//')) real = `https:${real}`;
  return real;
}

function stripTags(raw: string): string {
  return raw.replace(RE_TAG, '').replaceAll('&quot;', '"').trim();
}

/** 解析 DDG HTML 结果页为来源列表(fetch 兜底用) */
function parseDdgHtml(body: string, maxResults: number): WebSearchSource[] {
  if (body.includes(CAPTCHA_MARKER)) throw new Error('DuckDuckGo 触发了验证码(anomaly),请稍后重试或更换网络');
  const out: WebSearchSource[] = [];
  for (const m of body.matchAll(RE_TITLE)) {
    const href = m[1];
    const title = stripTags(m[2]);
    const url = decodeDdgUrl(href);
    if (!url || !title) continue;
    out.push({ url, title });
    if (out.length >= maxResults) break;
  }
  const snips = [...body.matchAll(RE_SNIPPET)].map((m) => stripTags(m[1]));
  for (let i = 0; i < out.length && i < snips.length; i++) {
    if (snips[i]) out[i].snippet = snips[i];
  }
  return out;
}

async function searchLocalFetch(query: string, maxResults: number, signal?: AbortSignal): Promise<WebSearchSource[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  // 202 限流:等 3s 重试一次;其它错误直接抛
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': BROWSER_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        signal,
        redirect: 'follow'
      });
    } catch (e: any) {
      if (signal?.aborted) throw new Error('已停止');
      throw new Error(`网络请求失败(本机无法访问 DuckDuckGo?): ${e?.message || e}`);
    }
    if (res.status === 202) { if (attempt === 0) continue; throw new Error('DuckDuckGo 限流(HTTP 202),请稍后重试'); }
    if (!res.ok) throw new Error(`DuckDuckGo 请求失败(HTTP ${res.status})`);
    const body = await res.text();
    return parseDdgHtml(body, maxResults);
  }
  throw new Error('DuckDuckGo 请求失败');
}

/** 本机搜索:优先 python+ddgs 库,失败回落 fetch */
async function searchLocal(query: string, maxResults: number, signal?: AbortSignal): Promise<WebSearchSource[]> {
  const bin = await ensureLocalDdgs();
  if (bin) {
    try { return await searchLocalPython(bin, query, maxResults); }
    catch { /* python 路径失败,继续回落 fetch */ }
  }
  return searchLocalFetch(query, maxResults, signal);
}

// ---------------- 对外入口 ----------------

/**
 * 执行一次 DuckDuckGo 网络搜索。
 * 优先在已连接的 SSH 服务器上用 ddgs Python 库跑(境外 VPS 直连 DDG 更可靠),失败再回落本机。
 * @returns 规范化来源列表 + 实际执行路径(remote/local)
 */
export async function webSearch(opts: WebSearchOptions): Promise<WebSearchOutcome> {
  const query = String(opts?.query || '').trim();
  if (!query) throw new Error('查询词为空');
  const maxResults = Number.isInteger(opts?.maxResults) && (opts.maxResults as number) > 0
    ? Math.min(opts.maxResults as number, 20)
    : DEFAULT_MAX_RESULTS;

  if (ssh.connected) {
    try {
      const sources = await searchRemote(query, maxResults);
      if (sources.length > 0) return { sources, source: 'remote' };
      throw new Error('远程未返回结果');
    } catch (e: any) {
      // 远程不可用(无 python/缺 ddgs/网络/限流)时回落本机,把远程错误作为提示附上
      try {
        const sources = await searchLocal(query, maxResults, opts?.signal);
        return { sources, source: 'local' };
      } catch (localErr: any) {
        throw new Error(`远程搜索失败(${String(e?.message || e)});本机搜索也失败(${String(localErr?.message || localErr)})`);
      }
    }
  }
  const sources = await searchLocal(query, maxResults, opts?.signal);
  return { sources, source: 'local' };
}

/** 渲染搜索结果为模型可见文本(附执行路径说明) */
export function renderSearchResult(outcome: WebSearchOutcome): string {
  const where = outcome.source === 'remote' ? '(在 SSH 服务器上用 ddgs 执行)' : '(本机执行)';
  const lines = outcome.sources.map((s, i) => {
    const head = s.title || s.url;
    const meta = [s.publishedAt, s.url].filter(Boolean).join(' · ');
    return `${i + 1}. ${head}\n   ${meta}${s.snippet ? `\n   ${s.snippet}` : ''}`;
  });
  const text = `DuckDuckGo 网络搜索结果 ${where}(${outcome.sources.length} 条):\n\n${lines.join('\n\n') || '(无结果)'}`;
  // 与其它工具一致:超长时头尾保留、中段折叠(AGENT.TOOL_RESULT_MAX_CHARS)
  const max = AGENT.TOOL_RESULT_MAX_CHARS;
  if (text.length <= max) return text;
  return text.slice(0, Math.floor(max * 0.6)) + `\n…[结果过长,已截断,剩余 ${text.length - max} 字符]…\n` + text.slice(text.length - Math.floor(max * 0.4));
}
