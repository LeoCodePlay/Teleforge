// 远程项目地址 ↔ 本机预览:把远程服务器上的端口,经现有 SSH 连接映射到本机回环端口,
// 让「浏览器预览」能直接打开 SSH 服务器上跑起来的开发服务(远程 localhost:5173 →
// 本机 127.0.0.1:随机端口)。本地模式下地址本就直达,不经过隧道。
//
// 实现方式:每个隧道是一个本机 net.Server;每个进来的 TCP 连接都用 ssh2 的 forwardOut
// 开一条到远程目标端口的通道并双向 pipe。SSH 重连后 conn.client 会换成新连接,
// 因为每次建连都是惰性读取 conn.client,旧隧道自动跟着新连接生效。
//
// 两个「必须防住」的坑(都是用户可见的怪现象来源):
//  1) **回环地址不一定是远程的**:连上服务器时消息里说的是"远程工作区",但用户/AI 也可能
//     在本机起一个静态服务再看它。以往只要连着 SSH 就把 localhost:端口 一律映射到远程,
//     于是本机服务被送去了远程服务器的同名端口 —— 那边通常没人监听,预览直接打不开。
//     现在先探测远程是否真有服务:有才隧道,没有就回退直连本机(两边都没有则给出可操作说明)。
//  2) **隧道对端没服务时的静默空响应**:forwardOut 拿到 "Connection refused" 后以往直接
//     destroy 掉本地 socket,浏览器只能得到 ERR_EMPTY_RESPONSE(看起来像"网络坏了"),
//     而真正的原因(远程端口没人监听)一个字都没露出来。现在回一句 502 说明,让原因可见。
import net from 'node:net';
import { sshManager as ssh } from './ssh-manager.ts';
import { normalizePreviewUrl } from './browser-manager.ts';

interface Tunnel {
  localPort: number;
  server: net.Server;
  sockets: Set<net.Socket>;
}

const tunnels = new Map<string, Tunnel>();
const connIds = new WeakMap<object, number>();
let connSeq = 0;

// 端口探测结果缓存:值 = 是否监听(远程探测为 null 表示探不了,例如没连接)。
// 短 TTL:够挡住"打开一次预览要探好几次",又不至于让刚起的服务等太久才被认出来。
const PROBE_TTL_MS = 5000;
const probeCache = new Map<string, { at: number; listening: boolean | null }>();

function connKey(conn: object): number {
  let id = connIds.get(conn);
  if (!id) {
    id = ++connSeq;
    connIds.set(conn, id);
  }
  return id;
}

function listenLocal(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('无法分配本地端口'));
    });
  });
}

/** 本机 127.0.0.1:port 上是否有服务在监听 */
export function isLocalPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v: boolean) => { try { s.destroy(); } catch { /* 忽略 */ } resolve(v); };
    s.setTimeout(1500);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

/** 在某个 ssh2 连接上试一条到 host:port 的转发通道(能开起来就说明对端有服务监听) */
function forwardProbe(client: any, host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    if (!client) return resolve(false);
    let settled = false;
    const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done(false), timeoutMs);
    try {
      client.forwardOut('127.0.0.1', 0, host, port, (err: Error | undefined, stream: any) => {
        clearTimeout(timer);
        if (err || !stream) return done(false);
        try { stream.close?.(); } catch { /* 忽略 */ }
        done(true);
      });
    } catch {
      clearTimeout(timer);
      done(false);
    }
  });
}

/**
 * 远程 host:port 上是否有服务在监听(经 SSH 的 forwardOut 探一条通道,不产生隧道)。
 * 返回 null = 探不了(当前没连接/连接不可用),调用方应保持旧行为(照常隧道,失败交给错误诊断)。
 */
export async function isRemotePortListening(conn: any, host: string, port: number): Promise<boolean | null> {
  if (!conn || !conn.connected || !conn.client) return null;
  const key = `remote:${connKey(conn)}:${host}:${port}`;
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.listening;
  // 先试 IPv4 回环;失败再试 IPv6(::1):开发服务器只绑 ::1 是常见情况
  let listening = await forwardProbe(conn.client, host, port);
  if (!listening && host === '127.0.0.1') listening = await forwardProbe(conn.client, '::1', port);
  probeCache.set(key, { at: Date.now(), listening });
  return listening;
}

/** 确保存在「远程 remoteHost:remotePort → 本机回环端口」的隧道,返回本机端口 */
export async function ensureRemoteTunnel(conn: any, remoteHost: string, remotePort: number): Promise<number> {
  const key = `${connKey(conn)}:${remoteHost}:${remotePort}`;
  const hit = tunnels.get(key);
  if (hit) return hit.localPort;

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { /* 由下方 stream 的 error/close 统一收尾 */ });
    const client = conn?.client;
    if (!client) { socket.destroy(); return; }
    // 隧道打通失败时,给浏览器一句人话而不是"空响应":它连的是本机回环端口,
    // 所以这里可以直接回一个 HTTP 502,页面上就能看到真正的原因。
    // 注意别用"浏览器是否已发出字节"当判据:实测请求字节常常早于 forwardOut 回调到达
    // (本地回环 + SSH 不走同一事件循环),那样会把我们要给的诊断又吞掉,退回 ERR_EMPTY_RESPONSE。
    // 唯一可靠的判据是"远程是否已经开始回数据"——回了就不能再抢着写 502。
    let finished = false;
    let gotRemoteData = false;
    const failPlainly = (reason: string) => {
      if (finished || gotRemoteData) return;
      finished = true;
      const body = `远程服务没有响应:${reason}\n\n`
        + `隧道:本机 127.0.0.1 → 远程 ${remoteHost}:${remotePort}\n`
        + '常见原因:该项目还没启动;dev server 被前台命令超时杀掉(默认 300s);服务只监听在别的地址。\n'
        + '处理:在远程工作区重新以后台方式启动项目(例如 nohup npm run dev > /tmp/dev.log 2>&1 &),'
        + '确认端口在监听后再打开预览。\n';
      const buf = Buffer.from(body, 'utf8');
      try {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n'
          + 'Content-Type: text/plain; charset=utf-8\r\n'
          + `Content-Length: ${buf.length}\r\n`
          + 'Cache-Control: no-store\r\n'
          + 'Connection: close\r\n\r\n');
        socket.write(buf);
      } catch { /* 忽略 */ }
      try { socket.end(); } catch { /* 忽略 */ }
    };
    client.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (err: Error | undefined, stream: any) => {
      if (err || !stream) {
        // 通道建不起来(对端没人监听 / 被拒绝):这正是"端口没服务"的确切原因
        failPlainly(err?.message || '通道建立失败');
        socket.destroy();
        return;
      }
      const done = () => {
        if (finished) return;
        finished = true;
        try { socket.destroy(); } catch { /* 忽略 */ }
        try { stream.close?.(); } catch { /* 忽略 */ }
      };
      stream.on('data', () => { gotRemoteData = true; });
      stream.on('error', done);
      socket.on('error', done);
      socket.on('close', done);
      // 通道刚建起来就被对端关闭、且远程一个字节都没回过:同样是"那边没人服务"的形态
      stream.on('close', () => { failPlainly('连接被远程对端直接关闭'); done(); });
      socket.pipe(stream);
      stream.pipe(socket);
    });
  });
  server.on('error', () => { /* 客户端侧错误:单条连接失败不应影响隧道本身 */ });

  const localPort = await listenLocal(server);
  tunnels.set(key, { localPort, server, sockets });
  return localPort;
}

/** 关闭全部隧道(进程退出 / 测试清理用) */
export function closeTunnels(): void {
  for (const t of tunnels.values()) {
    for (const s of t.sockets) { try { s.destroy(); } catch { /* 忽略 */ } }
    try { t.server.close(); } catch { /* 忽略 */ }
  }
  tunnels.clear();
}

export interface PreviewTarget {
  /** 真正让浏览器访问的地址(自动隧道时是本机回环地址) */
  url: string;
  /** 用户在终端里看到的原始地址 */
  direct: string;
  tunneled: boolean;
  note?: string;
}

/**
 * 把用户/AI 给出的地址解析成「预览浏览器实际应访问的地址」。
 * - 非回环地址(局域网 IP、公网域名)保持原样;
 * - **回环地址**(localhost / 127.0.0.1):先看远程服务器上该端口有没有服务 —
 *     有 → 建隧道并换成 127.0.0.1:<本机端口>(远程工作区的项目预览);
 *     没有、而本机该端口有服务 → 直接连本机(用户在本机起的预览服务,绝不能被送去远程);
 *     两边都没有 → 明确报错说明两边都没监听,而不是让浏览器收到一个"空响应";
 * - opts.tunnel === false 可强制直连本机;opts.tunnel === true 可强制走隧道(即使探到远程没服务)。
 */
export async function resolvePreviewUrl(raw: unknown, opts: { tunnel?: boolean } = {}): Promise<PreviewTarget> {
  const direct = normalizePreviewUrl(raw);
  if (!direct) throw new Error(`不是有效的预览地址:${String(raw ?? '(空)')}。请给出形如 http://localhost:5173 的地址。`);
  let u: URL;
  try { u = new URL(direct); } catch { return { url: direct, direct, tunneled: false }; }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
  if (!loopback || opts.tunnel === false) return { url: direct, direct, tunneled: false };
  const conn: any = ssh.active;
  if (!conn || !conn.connected) return { url: direct, direct, tunneled: false };
  const remotePort = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (!remotePort) return { url: direct, direct, tunneled: false };

  // 回环地址到底是谁的服务?这决定了"该不该隧道"。
  // 以往只要连着 SSH 就一律隧道,于是「在本机起的预览服务」会被送去远程同名端口 ——
  // 那边没人监听,浏览器只拿到一个空响应(ERR_EMPTY_RESPONSE),用户完全看不出原因。
  const remoteListening = await isRemotePortListening(conn, '127.0.0.1', remotePort);
  if (opts.tunnel !== true) {
    if (remoteListening === false) {
      const localListening = await isLocalPortListening(remotePort);
      if (localListening) {
        return {
          url: direct, direct, tunneled: false,
          note: `远程 ${host}:${remotePort} 没有服务在监听,已改走本机 127.0.0.1:${remotePort}(本机该端口有服务)`
        };
      }
      // 两边都没有:直接给出可操作的诊断,别让浏览器去撞一个空响应
      throw new Error(`localhost:${remotePort} 打不开:远程服务器(SSH 已连接)与本机都没有服务监听这个端口。\n`
        + '常见原因:项目还没启动;dev server 曾被前台命令启动、随后被命令超时终止(默认 300s);'
        + '改过端口后地址没更新。\n'
        + `处理:在远程工作区以后台方式启动项目(例如 nohup npm run dev > /tmp/dev.log 2>&1 &),`
        + `用 ss -lntp | grep ${remotePort} 确认端口在监听,再打开预览;`
        + `若该项目其实跑在本机,请用 tunnel=false 指定直连。`);
    }
  }

  const localPort = await ensureRemoteTunnel(conn, '127.0.0.1', remotePort);
  u.protocol = 'http:';
  u.hostname = '127.0.0.1';
  u.port = String(localPort);
  return {
    url: u.toString(),
    direct,
    tunneled: true,
    note: `已通过 SSH 隧道把远程 ${host}:${remotePort} 映射到本机 127.0.0.1:${localPort}`
  };
}
