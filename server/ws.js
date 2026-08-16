// WebSocket 服务层:统一协议转发
// 客户端 -> 服务端: connect/disconnect/llm/list_dir/read_file/write_file/create_dir/delete/
//                    set_workspace/speak/stop_agent/run_command/get_status
// 服务端 -> 客户端: status/dir_list/file_content/file_saved/dir_created/deleted/workspace/
//                    agent(事件流)/exec(命令输出流)/log/error
import { WebSocketServer } from 'ws';
import { WS_MAX_PAYLOAD } from './config.js';
import { sshManager as ssh } from './ssh-manager.js';
import { agent, setAgentHub } from './agent/agent.js';
import { clearEnvInfo } from './agent/tools.js';

export function setupWs(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: WS_MAX_PAYLOAD });
  let client = null; // 当前唯一前端(本地工具,单客户端)

  const send = (payload) => {
    if (client && client.readyState === 1) {
      try { client.send(JSON.stringify(payload)); } catch {}
    }
  };

  // Agent 事件 -> 前端
  setAgentHub({
    emit: (event, payload) => send({ type: 'agent', event, ...payload })
  });

  // SSH 状态 -> 前端
  const emitStatus = () => send({
    type: 'status',
    status: ssh.status,
    host: ssh.hostInfo?.host, port: ssh.hostInfo?.port, username: ssh.hostInfo?.username,
    platform: ssh.platform, home: ssh.home, workspace: ssh.workspace,
    agentBusy: agent.busyNow,
    llmModel: agent.llm ? (agent.llm.isMock ? 'mock' : agent.llm.model) : null
  });
  ssh.on('status', emitStatus);
  ssh.on('connection-lost', () => { agent.stop(); emitStatus(); });
  ssh.on('log', (level, message) => send({ type: 'log', level, message }));

  wss.on('connection', (ws) => {
    client = ws;
    send({ type: 'log', level: 'info', message: '前端已连接' });
    emitStatus();

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return send({ type: 'error', error: '消息不是合法 JSON' }); }
      const { type, reqId } = msg;
      const reply = (payload) => send({ ...payload, reqId });

      try {
        switch (type) {
          case 'connect': {
            const { host, port, username, auth, autoReconnect } = msg.ssh || {};
            if (!host || !username) throw new Error('缺少 host 或 username');
            await ssh.connect({
              host, port: Number(port) || 22, username,
              auth: { type: 'password', ...auth },
              autoReconnect: autoReconnect !== false
            });
            reply({ type: 'ok' });
            emitStatus();
            break;
          }
          case 'disconnect':
            await ssh.disconnect();
            reply({ type: 'ok' });
            emitStatus();
            break;
          case 'llm':
            agent.configureLlm(msg.llm);
            reply({ type: 'ok' });
            emitStatus();
            break;
          case 'get_status':
            reply({ type: 'ok' });
            emitStatus();
            break;

          case 'list_dir': {
            const entries = await ssh.listDir(msg.path || '/');
            reply({ type: 'dir_list', path: msg.path || '/', entries });
            break;
          }
          case 'read_file': {
            const { buffer, size, truncated } = await ssh.readFileChunk(msg.path, { maxBytes: msg.maxBytes });
            if (ssh.isProbablyBinary(buffer)) {
              reply({ type: 'file_content', path: msg.path, binary: true, size, truncated });
            } else {
              reply({ type: 'file_content', path: msg.path, content: buffer.toString('utf8'), size, truncated });
            }
            break;
          }
          case 'write_file': {
            const bytes = await ssh.writeRemoteFile(msg.path, msg.content);
            reply({ type: 'file_saved', path: msg.path, size: bytes });
            break;
          }
          case 'create_dir': {
            await ssh.mkdirp(msg.path);
            reply({ type: 'dir_created', path: msg.path });
            break;
          }
          case 'delete': {
            const type = await ssh.atype(msg.path);
            if (!type) throw new Error(`路径不存在: ${msg.path}`);
            if (type === 'dir') await ssh.rmdirRecursive(msg.path);
            else await new Promise((res, rej) => ssh.sftp.unlink(msg.path, (e) => (e ? rej(e) : res())));
            reply({ type: 'deleted', path: msg.path });
            break;
          }
          case 'set_workspace': {
            const st = await ssh.stat(msg.path);
            if (!st) throw new Error(`目录不存在: ${msg.path}`);
            if (!st.isDirectory()) throw new Error(`不是目录: ${msg.path}`);
            ssh.workspace = msg.path;
            clearEnvInfo(); // 工作区变化,旧环境快照失效
            reply({ type: 'workspace', path: msg.path });
            emitStatus();
            break;
          }

          case 'speak': {
            if (!msg.text?.trim()) throw new Error('指令为空');
            if (!ssh.workspace) throw new Error('请先选择远程工作区');
            // 不 await:流式回收,事件经 send 推送
            agent.run(msg.text).catch((e) => send({ type: 'agent', event: 'error', message: e.message }));
            reply({ type: 'ok' });
            break;
          }
          case 'stop_agent':
            agent.stop();
            reply({ type: 'ok' });
            break;

          case 'run_command': {
            if (!msg.command?.trim()) throw new Error('命令为空');
            const runId = Math.random().toString(36).slice(2, 10);
            send({ type: 'exec', runId, event: 'start', command: msg.command });
            ssh.exec(ssh.cdCommand(msg.command), {
              timeout: (msg.timeout || 300) * 1000,
              onOut: (d) => send({ type: 'exec', runId, event: 'output', stream: 'stdout', data: d }),
              onErr: (d) => send({ type: 'exec', runId, event: 'output', stream: 'stderr', data: d })
            }).then((r) => send({ type: 'exec', runId, event: 'exit', code: r.code, signal: r.signal, timedOut: r.timedOut }))
              .catch((e) => send({ type: 'exec', runId, event: 'exit', code: -1, error: e.message }));
            reply({ type: 'ok' });
            break;
          }

          default:
            throw new Error(`未知消息类型: ${type}`);
        }
      } catch (e) {
        send({ type: 'error', error: e.message, reqId, forType: type });
      }
    });

    ws.on('close', () => { if (client === ws) client = null; });
    ws.on('error', () => {});
  });

  return wss;
}