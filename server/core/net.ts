// 统一出站网络层:所有访问外部 API(模型网关 / 搜索 / 生图)的请求共用这里的初始化与错误描述。
//
// 为什么需要它——「换一台电脑就连不上网,浏览器却一切正常」通常是下面三件事之一:
//
//   1. DNS 顺序:Node 17+ 默认 verbatim(不再把 IPv4 排前面)。双栈网络里会先连 IPv6,
//      而 IPv6 出口不通时每次都要干等到超时,最终 fetch failed;浏览器有 Happy Eyeballs
//      会自动回落,所以表现为"浏览器能上,应用不能"。→ 这里默认改为 IPv4 优先。
//
//   2. 代理:Node 内置 fetch(undici)既不读 Windows「Internet 选项」里的代理,
//      也不读 HTTP_PROXY/HTTPS_PROXY(实测:只设环境变量无效,必须替换全局 dispatcher)。
//      于是"靠系统代理上网"的机器上,浏览器能开网页、应用却全部 fetch failed。
//      → 启动时探测环境变量与系统代理,挂上代理 agent。
//
//   3. 错误信息:undici 把连接层失败统一成一句 "fetch failed",真正原因藏在 error.cause
//      (ENOTFOUND / ECONNREFUSED / ETIMEDOUT / 证书错误)。只取 e.message 会让所有网络
//      故障长得一模一样——这正是"换个机器就 fetch failed"查不动的根源。→ 统一展开成人话。
import dns from 'node:dns';
import { execFileSync } from 'node:child_process';
import { EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from 'undici';

/** 当前生效的代理地址;null 表示直连(拼进报错与启动日志,便于定位"这台机器为什么不行") */
let activeProxy: string | null = null;
let inited = false;

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
 * 启动时调用一次:固定 DNS 顺序 + 按需挂上代理。
 * 返回实际生效的配置,供启动日志打印。
 */
export function initNetwork(): { dnsOrder: string; proxy: string | null } {
  // 纯 IPv6 环境或排障时可用 TF_DNS_ORDER=ipv6first / verbatim 覆盖
  const env = process.env.TF_DNS_ORDER;
  const dnsOrder = env === 'ipv6first' || env === 'verbatim' ? env : 'ipv4first';
  if (!inited) {
    try {
      dns.setDefaultResultOrder(dnsOrder);
    } catch { /* 老版本 Node 不认识该参数:保持默认即可 */ }
    inited = true;
  }

  activeProxy = detectProxy();
  if (activeProxy) {
    const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy || activeProxy;
    const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || activeProxy;
    try {
      setGlobalDispatcher(new EnvHttpProxyAgent({
        httpProxy,
        httpsProxy,
        // 回环地址永不代理:本地服务(如 Tauri 健康检查、本地工具后端)必须直连
        noProxy: 'localhost,127.0.0.1,::1'
      }));
    } catch {
      setGlobalDispatcher(new ProxyAgent(activeProxy));
    }
  }
  return { dnsOrder, proxy: activeProxy };
}

/** 当前网络配置摘要(拼进报错,用户一看就知道这台机器有没有走代理) */
export function networkSummary(): string {
  return activeProxy ? `经代理 ${activeProxy}` : '直连(未检测到代理)';
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
