// WebSocket 服务层:统一协议转发
// 客户端 -> 服务端: connect/disconnect/conn_switch/conn_disconnect/llm/list_dir/read_file/write_file/create_dir/delete/
//                    set_workspace/speak/stop_agent/run_command/stop_command/get_status/ssh_profiles_*
// 服务端 -> 客户端: status/dir_list/file_content/file_saved/dir_created/deleted/workspace/
//                    agent(事件流)/exec(命令输出流)/log/error/ssh_profiles
//
// 另有 /ws/term 交互式终端通道(真实 PTY shell):文本帧 = JSON 控制消息
// (start/resize),二进制帧 = 终端原始数据(键盘输入上行 / 屏幕输出下行)
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { spawnSync } from 'node:child_process';
import type { ClientChannel } from 'ssh2';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { SshConnection } from './ssh-manager.ts';
import { WS_MAX_PAYLOAD } from '../config.ts';
import { createRpcRouter } from '../api/rpc/router.ts';
import { sshManager as ssh } from './ssh-manager.ts';
import { localFs } from './local-fs.ts';
import { agent, setAgentHub } from '../agent/agent.ts';
import { clearSearchEngine } from '../agent/tools.ts';
import { rejectAllAskUser } from '../agent/ask-user.ts';
import { migrateLegacy } from '../store/session-store.ts';

export function setupWs(httpServer: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  const termWss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

  // 同一 http server 上有两个 WSS,必须手动路由 upgrade:
  // 若各自自动监听,非匹配路径的 WSS 会对已升级的 socket abortHandshake(400),
  // 把 HTTP 字节写进 WebSocket 流,客户端报 "Invalid WebSocket frame: RSV1 must be clear"
  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = String(req.url || '').split('?')[0];
    if (pathname === '/ws/term') {
      termWss.handleUpgrade(req, socket, head, (ws) => termWss.emit('connection', ws));
    } else if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
    } else {
      socket.destroy();
    }
  });
  // 多浏览器可同时在线:事件(status/agent/log)广播给全部连接;
  // RPC 回复与请求期间的事件(进度等)定向回发起请求的那个连接(见下方 sendTo + router.handle)。
  // 断线补偿:无任何连接期间 agent 产生的事件(尤其 done/status)按序缓存,
  // 新连接建立后立即补发(flushPending),避免「后台已完成但前端永不解除 streaming」的界面卡死。
  // 只缓存 type==='agent' 的事件:status/log/error 等重连后都会由 emitStatus/显式发送重新下发;
  // 上限控制内存(长时间离线时丢最旧),正常断线窗口内的事件条数远小于该值。
  const pendingEvents: any[] = [];
  const PENDING_MAX = 1500;

  const send = (payload: any) => {
    const data = JSON.stringify(payload);
    let delivered = false;
    for (const c of wss.clients) {
      if (c.readyState === 1) {
        try { c.send(data); } catch {}
        delivered = true;
      }
    }
    if (!delivered && payload && payload.type === 'agent') {
      pendingEvents.push(payload);
      if (pendingEvents.length > PENDING_MAX) pendingEvents.splice(0, pendingEvents.length - PENDING_MAX);
    }
  };

  // 定向发送:只发给指定连接(某浏览器发起的 RPC 回复/进度事件)
  const sendTo = (ws: WebSocket, payload: any) => {
    if (ws.readyState === 1) { try { ws.send(JSON.stringify(payload)); } catch {} }
  };

  // 新连接就绪后按序补发断线期间缓存的 agent 事件(发送失败的最小概率事件会重新入队)
  const flushPending = () => {
    const evs = pendingEvents.splice(0);
    for (const p of evs) send(p);
  };

  // Agent 事件 -> 前端(agent 的 'log' 是 3 参调用:event=log, level, message)
  setAgentHub({
    emit: (event: string, payload: any, extra?: any) => {
      if (event === 'log') send({ type: 'log', level: payload, message: extra });
      else {
        send({ type: 'agent', event, ...payload });
        // 会话级 running/idle 变化会改变"哪些会话在运行"的集合,同步刷新 status 快照
        if (event === 'agent' && payload?.event === 'status') emitStatus();
      }
    }
  });

  // SSH 状态 -> 前端(活动连接字段 + 全部连接列表,前端据此做多连接管理与快速切换;
  // busySessions:运行中的会话 id 列表,多会话并行的忙碌集合)
  // 注意:这里必须取「真实活动连接」(ssh.activeId/conns),不能用 ssh.active——
  // agent 会话运行期间 ssh.active 被 AsyncLocalStorage 重定向到会话绑定的连接,
  // 若按其上报,顶栏会错误显示成后台运行的那台服务器。
  const emitStatus = () => {
    const activeId = ssh.activeId;
    const active = activeId ? ssh.conns.get(activeId) || null : null;
    send({
      type: 'status',
      status: active?.status || 'disconnected',
      host: active?.hostInfo?.host ?? null,
      port: active?.hostInfo?.port ?? null,
      username: active?.hostInfo?.username ?? null,
      platform: active?.platform ?? null,
      home: active?.home ?? null,
      workspace: active?.workspace ?? null,
      ...ssh.snapshot(), // { activeConn, conns: [...] }
      localWorkspace: localFs.workspace,
      localHome: localFs.home,
      agentBusy: agent.busyNow,
      busySessions: agent.busyIds(),
      llmModel: agent.llm ? (agent.llm.isMock ? 'mock' : agent.llm.model) : null
    });
  };
  ssh.on('status', emitStatus);
  // 任一连接意外掉线(含后台非活动连接):只停绑定在该连接上的会话(其工具已无法执行),
  // 其他服务器上还在后台运行的会话不受影响,可继续干完。
  ssh.on('connection-lost', (key: string) => {
    clearSearchEngine();
    const lost = key != null ? ssh.conns.get(String(key)) : null;
    if (lost) agent.stopForConn(lost); else agent.stopAll();
    syncAgentScope();
    emitStatus();
  });
  ssh.on('log', (level, message) => send({ type: 'log', level, message }));

  // ---- 会话作用域:会话按"当前活动连接"隔离(连接 = username@host:port;无连接 = 本地工作区模式) ----
  const LOCAL_CONN_KEY = 'local';
  const connKeyOf = (conn: SshConnection | null) => {
    const hi = conn?.hostInfo;
    return hi && hi.host ? `${hi.username}@${hi.host}:${hi.port}` : LOCAL_CONN_KEY;
  };
  // 连接状态变化后同步 agent 作用域(切服务器/断开都走这里);
  // 首次连上服务器时把无归属的旧会话一次性迁移到该服务器
  const syncAgentScope = () => {
    const key = connKeyOf(ssh.active);
    if (key !== LOCAL_CONN_KEY) migrateLegacy(key);
    agent.setConnKey(key);
  };

  // 消息分发路由表:49 种 RPC 消息在 server/rpc/ 下按领域注册,ctx 只注入 ws 闭包专有物
  const router = createRpcRouter({ send, emitStatus, syncAgentScope });

  wss.on('connection', (ws: WebSocket) => {
    // 心跳探活:连接必须响应服务端 ping,未应答的超时连接会被 terminate(见下方定时器),
    // 使电脑休眠/网络抖动导致的"假死连接"被及时发现并触发前端自动重连
    (ws as any).isAlive = true;
    ws.on('pong', () => { (ws as any).isAlive = true; });
    flushPending(); // 先补发断线期间缓存的 agent 事件,再下发状态,保证 UI 状态无缝衔接
    send({ type: 'log', level: 'info', message: '前端已连接' });
    syncAgentScope();
    emitStatus();

    ws.on('message', async (raw: any) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return sendTo(ws, { type: 'error', error: '消息不是合法 JSON' }); }
      try {
        // 定向回复:该连接的请求与进度事件只回给它,其他浏览器不受干扰
        await router.handle(msg, { send: (p) => sendTo(ws, p) });
      } catch (e: any) {
        sendTo(ws, { type: 'error', error: e.message, reqId: msg.reqId, forType: msg.type });
      }
    });

    ws.on('close', () => {
      // 多浏览器可同时在线:只有全部连接都断开(最后一个前端离开)时,
      // 才把正在等待用户回答的提问作废,避免 B 关掉页面把 A 的提问误杀
      const stillAlive = [...wss.clients].some((c) => c !== ws && c.readyState === 1);
      if (!stillAlive) rejectAllAskUser('前端连接已断开,提问已取消');
    });
    ws.on('error', () => {});
  });

  // ---------- 交互式终端通道(/ws/term) ----------
  // 每个连接对应一个可切换模式(remote=远程 SSH PTY / local=本机 shell)的会话;连接关闭即关闭会话。
  // start 消息携带 mode 字段:缺省为 remote(保持旧行为)。
  // 文本帧(JSON):start {mode,cols,rows} / resize {cols,rows} / kill
  // 二进制帧:客户端键盘输入 -> shell;shell 输出 -> 客户端屏幕
  termWss.on('connection', (ws: WebSocket) => {
    (ws as any).isAlive = true;
    ws.on('pong', () => { (ws as any).isAlive = true; });
    let stream: ClientChannel | null = null; // 远程 PTY shell 通道
    let localPty: IPty | null = null;        // 本机 shell 进程(ConPTY 真终端)
    let closed = false;

    const sendJson = (o: any) => { try { ws.send(JSON.stringify(o)); } catch {} };
    const isLocalAlive = () => localPty !== null;
    const closeStream = () => {
      if (stream) {
        const s = stream; stream = null;
        try { s.close(); } catch {}
        try { s.end?.(); } catch {}
      }
      if (localPty) {
        const p = localPty; localPty = null;
        try { p.kill(); } catch {}
      }
    };

    // 打开本机交互式终端:node-pty(Windows 走 ConPTY)起真实终端,
    // 回显/回车/方向键历史/Tab 补全等由 OS 终端层处理,前端 xterm 直接透传。
    // cwd 默认本地工作区,未设置则回退到服务器进程工作目录。
    // Windows 优先 PowerShell(pwsh 7 排最前,其次系统自带 powershell.exe),都无再回退 cmd。
    const pickWinShell = (): string => {
      const probe = (name: string) => {
        try { return spawnSync(name, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0; }
        catch { return false; }
      };
      if (probe('pwsh')) return 'pwsh';
      if (probe('powershell.exe')) return 'powershell.exe';
      return process.env.ComSpec || 'cmd.exe';
    };
    const startLocal = (cols: number, rows: number) => {
      if (localPty) return; // 已有会话
      const isWin = process.platform === 'win32';
      const shell = isWin ? pickWinShell() : (process.env.SHELL || 'bash');
      // 默认 cwd:已选择本地工作区则用工作区,否则回退到用户家目录(而非服务进程目录)
      const cwd = localFs.workspace || localFs.home;
      let term: IPty;
      try {
        term = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols, rows,
          cwd,
          env: process.env as NodeJS.ProcessEnv
        });
      } catch (e: any) { sendJson({ type: 'error', error: `打开本地终端失败: ${e.message}` }); return; }
      localPty = term;
      term.onData((d: string) => { if (ws.readyState === 1) { try { ws.send(Buffer.from(d)); } catch {} } });
      term.onExit(() => { if (localPty === term) { localPty = null; sendJson({ type: 'exit' }); } });
      sendJson({ type: 'ready' });
    };

    ws.on('message', (raw: any, isBinary: boolean) => {
      // 二进制帧:键盘输入直接进会话(远程 PTY 或本机 shell 的 stdin)
      if (isBinary) {
        if (ws.readyState !== 1) return;
        if (stream) { try { stream.write(raw); } catch {} return; }
        if (isLocalAlive()) { try { localPty!.write(raw.toString('utf8')); } catch {} return; }
        return;
      }
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const mode = msg.mode === 'local' ? 'local' : 'remote';

      if (msg.type === 'start') {
        if (stream || localPty || closed) return; // 已有会话/正在关闭
        const cols = Math.max(2, Math.min(500, msg.cols | 0 || 80));
        const rows = Math.max(2, Math.min(300, msg.rows | 0 || 24));
        if (mode === 'local') { startLocal(cols, rows); return; }
        if (!ssh.connected) { sendJson({ type: 'error', error: 'SSH 未连接,无法打开远程终端' }); return; }
        ssh.shell({ cols, rows }).then((s: ClientChannel) => {
          if (closed || stream || localPty) { try { s.close(); } catch {} return; }
          stream = s;
          s.on('data', (d: Buffer) => { if (ws.readyState === 1) { try { ws.send(d); } catch {} } });
          // PTY shell 输出走 stdout,stderr 一般为空,保险起见也转发
          s.stderr?.on('data', (d: Buffer) => { if (ws.readyState === 1) { try { ws.send(d); } catch {} } });
          s.on('close', () => { if (stream === s) stream = null; sendJson({ type: 'exit' }); });
          s.on('error', () => {});
          sendJson({ type: 'ready' });
          // 打开后自动 cd 进工作区(以用户手敲命令的方式回显,可见且真实)
          if (ssh.workspace) {
            const wsq = ssh.platform === 'win32'
              ? `cd "${ssh.workspace.replace(/"/g, '""')}"`
              : `cd '${ssh.workspace.replace(/'/g, `'\\''`)}'`;
            try { s.write(wsq + '\n'); } catch {}
          }
        }).catch((e: any) => sendJson({ type: 'error', error: `打开远程终端失败: ${e.message}` }));
      } else if (msg.type === 'resize') {
        const cols = Math.max(2, Math.min(500, msg.cols | 0 || 80));
        const rows = Math.max(2, Math.min(300, msg.rows | 0 || 24));
        // 远程 PTY 与本地 ConPTY 均支持实时 resize(本机早期管道版曾忽略,现已支持)
        try { stream?.setWindow(rows, cols, 0, 0); } catch {}
        try { localPty?.resize(cols, rows); } catch {}
      } else if (msg.type === 'kill') {
        // 关闭当前 shell(前端"重启终端"用),close 事件会回发 exit
        closeStream();
      }
    });

    ws.on('close', () => { closed = true; closeStream(); });
    ws.on('error', () => { closed = true; closeStream(); });
  });

  // 心跳保活:每 30s 向全部连接发 ping,下一轮仍无 pong 的(假死/TCP 半开)直接 terminate,
  // 让浏览器触发 onclose 走前端自动重连,而不是无声无息地双向都收不到数据。
  // 浏览器 WebSocket 对 ping 控制帧自动回 pong,无需前端配合。
  const HEARTBEAT_MS = 30_000;
  const heartbeat = (server: WebSocketServer) => {
    for (const ws of server.clients) {
      if (!(ws as any).isAlive) { try { ws.terminate(); } catch {} continue; }
      (ws as any).isAlive = false;
      try { ws.ping(); } catch {}
    }
  };
  const heartbeatTimer = setInterval(() => { heartbeat(wss); heartbeat(termWss); }, HEARTBEAT_MS);
  httpServer.on('close', () => clearInterval(heartbeatTimer));

  return { wss, termWss };
}