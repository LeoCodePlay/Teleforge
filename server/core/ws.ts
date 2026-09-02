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
import type { ClientChannel } from 'ssh2';
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
  let client: WebSocket | null = null; // 当前唯一前端(本地工具,单客户端)

  const send = (payload: any) => {
    if (client && client.readyState === 1) {
      try { client.send(JSON.stringify(payload)); } catch {}
    }
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
    client = ws;
    send({ type: 'log', level: 'info', message: '前端已连接' });
    syncAgentScope();
    emitStatus();

    ws.on('message', async (raw: any) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return send({ type: 'error', error: '消息不是合法 JSON' }); }
      try {
        await router.handle(msg);
      } catch (e: any) {
        send({ type: 'error', error: e.message, reqId: msg.reqId, forType: msg.type });
      }
    });

    ws.on('close', () => {
      if (client === ws) client = null;
      // 前端断开:正在等待用户回答的提问全部作废,对应工具返回结构化错误而不是挂死
      rejectAllAskUser('前端连接已断开,提问已取消');
    });
    ws.on('error', () => {});
  });

  // ---------- 交互式终端通道(/ws/term) ----------
  // 每个连接对应一个远程 PTY shell;连接关闭即关闭 shell。
  // 文本帧(JSON):start {cols,rows} / resize {cols,rows}
  // 二进制帧:客户端键盘输入 -> shell;shell 输出 -> 客户端屏幕
  termWss.on('connection', (ws: WebSocket) => {
    let stream: ClientChannel | null = null; // 当前 shell 通道
    let closed = false;

    const sendJson = (o: any) => { try { ws.send(JSON.stringify(o)); } catch {} };
    const closeStream = () => {
      if (!stream) return;
      const s = stream; stream = null;
      try { s.close(); } catch {}
      try { s.end?.(); } catch {}
    };

    ws.on('message', (raw: any, isBinary: boolean) => {
      // 二进制帧:键盘输入直接进 shell
      if (isBinary) {
        if (stream && ws.readyState === 1) { try { stream.write(raw); } catch {} }
        return;
      }
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'start') {
        if (stream || closed) return; // 已有会话/正在关闭
        if (!ssh.connected) { sendJson({ type: 'error', error: 'SSH 未连接,无法打开终端' }); return; }
        const cols = Math.max(2, Math.min(500, msg.cols | 0 || 80));
        const rows = Math.max(2, Math.min(300, msg.rows | 0 || 24));
        ssh.shell({ cols, rows }).then((s: ClientChannel) => {
          if (closed || stream) { try { s.close(); } catch {} return; }
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
        }).catch((e: any) => sendJson({ type: 'error', error: `打开终端失败: ${e.message}` }));
      } else if (msg.type === 'resize') {
        const cols = Math.max(2, Math.min(500, msg.cols | 0 || 80));
        const rows = Math.max(2, Math.min(300, msg.rows | 0 || 24));
        try { stream?.setWindow(rows, cols, 0, 0); } catch {}
      } else if (msg.type === 'kill') {
        // 关闭当前 shell(前端"重启终端"用),close 事件会回发 exit
        closeStream();
      }
    });

    ws.on('close', () => { closed = true; closeStream(); });
    ws.on('error', () => { closed = true; closeStream(); });
  });

  return { wss, termWss };
}