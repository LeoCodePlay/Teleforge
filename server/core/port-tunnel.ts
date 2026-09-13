// 远程项目地址 ↔ 本机预览:把远程服务器上的端口,经现有 SSH 连接映射到本机回环端口,
// 让「浏览器预览」能直接打开 SSH 服务器上跑起来的开发服务(远程 localhost:5173 →
// 本机 127.0.0.1:随机端口)。本地模式下地址本就直达,不经过隧道。
//
// 实现方式:每个隧道是一个本机 net.Server;每个进来的 TCP 连接都用 ssh2 的 forwardOut
// 开一条到远程目标端口的通道并双向 pipe。SSH 重连后 conn.client 会换成新连接,
// 因为每次建连都是惰性读取 conn.client,旧隧道自动跟着新连接生效。
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
    client.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (err: Error | undefined, stream: any) => {
      if (err || !stream) { socket.destroy(); return; }
      let closed = false;
      const done = () => {
        if (closed) return;
        closed = true;
        try { socket.destroy(); } catch { /* 忽略 */ }
        try { stream.close?.(); } catch { /* 忽略 */ }
      };
      stream.on('close', done);
      stream.on('error', done);
      socket.on('error', done);
      socket.on('close', done);
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
 * - 回环地址且当前有 SSH 连接时,自动建隧道并把地址换成 127.0.0.1:<本机端口>;
 * - opts.tunnel === false 可强制直连(例如项目其实跑在本机,只是当前也连着服务器)。
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
