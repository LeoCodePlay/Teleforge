// 统一出站网络层:所有访问外部 API(模型网关 / 搜索 / 生图)的请求共用这里的初始化与错误描述。
//
// 目标:无论系统代理开还是关、中途怎么切换,应用都能正常出网,且失败时能说清原因。
//
// 为什么需要它——「换一台电脑就连不上网,浏览器却一切正常」通常是下面几件事之一:
//
//   1. DNS 顺序:Node 17+ 默认 verbatim(不再把 IPv4 排前面)。双栈网络里会先连 IPv6,
//      而 IPv6 出口不通时每次都要干等到超时,最终 fetch failed;浏览器有 Happy Eyeballs
//      会自动回落,所以表现为"浏览器能上,应用不能"。→ 这里默认改为 IPv4 优先。
//
//   2. 代理:Node 内置 fetch(undici)既不读 Windows「Internet 选项」里的代理,
//      也不读 HTTP_PROXY/HTTPS_PROXY(实测:只设环境变量无效,必须替换全局 dispatcher)。
//      → 探测环境变量与系统代理,挂上代理 agent;并按 TTL 复探,运行中开关代理自动跟上。
//
//   3. 代理残留:注册表里 ProxyEnable=1 但代理软件已经退出。→ 对回环代理做端口可达性
//      检查,端口不通就按直连处理,不让一条失效的代理设置卡死整个应用。
//
//   4. 错误信息:undici 把连接层失败统一成一句 "fetch failed",真正原因藏在 error.cause
//      (ENOTFOUND / ECONNREFUSED / ETIMEDOUT / 证书错误)。只取 e.message 会让所有网络
//      故障长得一模一样——这正是"换个机器就 fetch failed"查不动的根源。→ 统一展开成人话。
//
// 注意:这里**不做请求重试**。重试属于上层(llm.ts 有自己的重试与半成品回滚语义),
// 在网络层悄悄重发会吞掉上层的失败信号,把「流中断需要回滚」变成「其实成功了」。
import dns from 'node:dns';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { Agent, EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from 'undici';

/** 上次探测到的原始代理值(未启用/未探测到为 null) */
let detectedProxy: string | null = null;
/** 实际生效的代理;null = 直连。拼进报错与启动日志,便于定位"这台机器为什么不行" */
let activeProxy: string | null = null;
let lastProbe = 0;
let inited = false;
/** 在途探测:并发请求只触发一次注册表读取与端口检查 */
let probing: Promise<boolean> | null = null;

/** 代理配置复探间隔:运行中开关代理后,最迟这么久生效(无需重启应用) */
const PROBE_TTL_MS = 10_000;

/** Windows「Internet 选项」里的代理(注册表);未启用或非 Windows 返回 null */
function windowsSystemProxy(): string | null {
  if (process.platform !== 'win32') return null;
  const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const query = (name: string) =>
    execFileSync('reg', ['query', KEY, '/v', name], { encoding: 'utf8', timeout: 3000 });
  try {
    if (!/REG_DWORD\s+0x1\b/i.test(query('ProxyEnable'))) return null;
    const raw = query('ProxyServer').match(/ProxyServer\s+REG_SZ\s+(.+)/i)?.[1]?.trim();
    if (!raw) return null;
    // 分协议写法(如 "http=127.0.0.1:7897;https=127.0.0.1:7897"):取 https,其次 http
    let server = raw;
    if (raw.includes('=')) {
      const m = new Map(raw.split(';').map((s) => s.split('=') as [string, string]));
      server = (m.get('https') || m.get('http') || '').trim();
    }
    if (!server) return null;
    return /^https?:\/\//i.test(server) ? server : `http://${server}`;
  } catch {
    return null; // 无该项 / reg 不可用:按直连处理
  }
}

/** 代理来源:显式环境变量优先,其次 Windows 系统代理 */
export function detectProxy(): string | null {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = process.env[k];
    if (v && v.trim()) return v.trim();
  }
  return windowsSystemProxy();
}

/**
 * 回环代理的端口可达性:代理软件退出后,注册表往往还留着 ProxyEnable=1,
 * 照着它走代理会让所有请求都失败。端口不通即视为「无代理」。
 * 非回环代理不做探测(会引入额外延迟,且可能被防火墙拦),交给请求层报错。
 */
function proxyReachable(proxy: string, timeoutMs = 500): Promise<boolean> {
  // 排障开关:跳过端口探测(定位"某个环境下的句柄/时序问题"时用)
  if (process.env.TF_NO_PROXY_PROBE === '1') return Promise.resolve(true);
  let u: URL;
  try {
    u = new URL(proxy);
  } catch {
    return Promise.resolve(true); // 解析不了:不拦,让请求层给出真实错误
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return Promise.resolve(true);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (!port) return Promise.resolve(true);
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let settled = false;
    // 只结算一次:超时、connect、error 可能相继触发,重复 destroy 会踩到 libuv 的 handle 断言
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

/** 按给定代理(或 null=直连)重建全局 dispatcher */
function applyDispatcher(proxy: string | null): void {
  if (!proxy) {
    setGlobalDispatcher(new Agent()); // 显式直连:否则会停在旧代理上
    return;
  }
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy || proxy;
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || proxy;
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent({
      httpProxy,
      httpsProxy,
      // 回环地址永不代理:本地服务(如 Tauri 健康检查、本地工具后端)必须直连
      noProxy: 'localhost,127.0.0.1,::1'
    }));
  } catch {
    setGlobalDispatcher(new ProxyAgent(proxy));
  }
}

/**
 * 复探代理配置并切换(带 TTL,避免每个请求都去读注册表)。
 * @returns 配置是否发生变化
 */
export function refreshProxy(force = false): Promise<boolean> {
  const now = Date.now();
  if (!force && now - lastProbe < PROBE_TTL_MS) return Promise.resolve(false);
  if (probing) return probing; // 复用在途探测
  probing = (async () => {
    lastProbe = Date.now();
    let detected = detectProxy();
    if (detected && !(await proxyReachable(detected))) detected = null; // 代理已失效:按直连
    if (detected !== detectedProxy) detectedProxy = detected;
    if (detected === activeProxy) return false;
    activeProxy = detected;
    applyDispatcher(detected);
    return true;
  })().finally(() => { probing = null; });
  return probing;
}

/**
 * 启动时调用一次:固定 DNS 顺序 + 探测代理。
 * 返回实际生效的配置,供启动日志打印。
 */
export async function initNetwork(): Promise<{ dnsOrder: string; proxy: string | null }> {
  // 纯 IPv6 环境或排障时可用 TF_DNS_ORDER=ipv6first / verbatim 覆盖
  const env = process.env.TF_DNS_ORDER;
  const dnsOrder = env === 'ipv6first' || env === 'verbatim' ? env : 'ipv4first';
  if (!inited) {
    try {
      dns.setDefaultResultOrder(dnsOrder);
    } catch { /* 老版本 Node 不认识该参数:保持默认即可 */ }
    inited = true;
  }
  await refreshProxy(true);
  return { dnsOrder, proxy: activeProxy };
}

/** 当前网络配置摘要(拼进报错,用户一看就知道这台机器有没有走代理) */
export function networkSummary(): string {
  return activeProxy ? `经代理 ${activeProxy}` : '直连(未检测到代理)';
}

/**
 * 出站请求统一入口:按 TTL 复探代理后发出。
 * 运行中开/关系统代理都会在 PROBE_TTL_MS 内自动跟上,不必重启应用。
 * 刻意不做失败重试:重试与半成品回滚是上层的职责(见文件头说明)。
 */
export async function outboundFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  await refreshProxy();
  return fetch(input, init);
}

/** 连接层错误码 → 人话。undici 把这些全部折叠成 "fetch failed",必须自己翻译 */
const CAUSE_HINT: Record<string, string> = {
  ENOTFOUND: '域名解析失败,DNS 查不到该主机',
  EAI_AGAIN: 'DNS 临时解析失败,可稍后重试',
  ECONNREFUSED: '目标拒绝连接(端口不通,或被防火墙/安全软件拦截)',
  ECONNRESET: '连接被重置(可能被中间设备或防火墙切断)',
  EPIPE: '连接被对端关闭',
  ETIMEDOUT: '连接超时(网络不通,或该地址需要代理)',
  UND_ERR_CONNECT_TIMEOUT: '连接超时(网络不通,或该地址需要代理)',
  UND_ERR_HEADERS_TIMEOUT: '等待响应超时',
  UND_ERR_BODY_TIMEOUT: '读取响应超时',
  UND_ERR_SOCKET: '连接被中断',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  CERT_HAS_EXPIRED: 'TLS 证书已过期',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书无法验证(可能被中间设备替换)',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 证书为自签名(可能被中间设备替换)',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS 证书与域名不匹配'
};

/**
 * 把 undici 的 "fetch failed" 展开成能定位的原因。
 * 输出形如:`fetch failed | ENOTFOUND(域名解析失败,DNS 查不到该主机) | 目标 api.xxx.com | 直连`
 */
export function describeFetchError(e: unknown): string {
  const err = e as { message?: string; name?: string; cause?: any } | null;
  if (!err || typeof err !== 'object') return String(e ?? '未知错误');
  const base = err.message || err.name || '请求失败';
  const cause = err.cause;
  if (!cause || typeof cause !== 'object') return base;

  const code: string = cause.code || cause.errno || '';
  const host: string = cause.hostname || cause.host || '';
  const parts = [base];
  if (code) parts.push(`${code}${CAUSE_HINT[code] ? `(${CAUSE_HINT[code]})` : ''}`);
  if (host) parts.push(`目标 ${host}`);
  const detail = String(cause.message || '');
  if (detail && detail !== base && !detail.includes(base)) parts.push(detail.slice(0, 160));
  parts.push(networkSummary());
  return parts.join(' | ');
}
