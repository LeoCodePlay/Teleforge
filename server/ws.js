// WebSocket 服务层:统一协议转发
// 客户端 -> 服务端: connect/disconnect/llm/list_dir/read_file/write_file/create_dir/delete/
//                    set_workspace/speak/stop_agent/run_command/stop_command/get_status
// 服务端 -> 客户端: status/dir_list/file_content/file_saved/dir_created/deleted/workspace/
//                    agent(事件流)/exec(命令输出流)/log/error
//
// 另有 /ws/term 交互式终端通道(真实 PTY shell):文本帧 = JSON 控制消息
// (start/resize),二进制帧 = 终端原始数据(键盘输入上行 / 屏幕输出下行)
import { WebSocketServer } from 'ws';
import { WS_MAX_PAYLOAD } from './config.js';
import { sshManager as ssh } from './ssh-manager.js';
import { agent, toolRegistry, setAgentHub } from './agent/agent.js';
import { clearEnvInfo, refreshSkillsCatalog, getSkillFull, saveSkill, deleteSkill, copyBuiltinToRemote } from './agent/tools.js';
import { toolSettings } from './agent/tool-settings.js';
import { getPromptInject, setPromptInject } from './agent/prompt-inject.js';

export function setupWs(httpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  const termWss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

  // 同一 http server 上有两个 WSS,必须手动路由 upgrade:
  // 若各自自动监听,非匹配路径的 WSS 会对已升级的 socket abortHandshake(400),
  // 把 HTTP 字节写进 WebSocket 流,客户端报 "Invalid WebSocket frame: RSV1 must be clear"
  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = String(req.url || '').split('?')[0];
    if (pathname === '/ws/term') {
      termWss.handleUpgrade(req, socket, head, (ws) => termWss.emit('connection', ws));
    } else if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
    } else {
      socket.destroy();
    }
  });
  let client = null; // 当前唯一前端(本地工具,单客户端)

  const send = (payload) => {
    if (client && client.readyState === 1) {
      try { client.send(JSON.stringify(payload)); } catch {}
    }
  };

  // Agent 事件 -> 前端(agent 的 'log' 是 3 参调用:event=log, level, message)
  setAgentHub({
    emit: (event, payload, extra) => {
      if (event === 'log') send({ type: 'log', level: payload, message: extra });
      else {
        send({ type: 'agent', event, ...payload });
        // 会话级 running/idle 变化会改变"哪些会话在运行"的集合,同步刷新 status 快照
        if (event === 'agent' && payload?.event === 'status') emitStatus();
      }
    }
  });

  // SSH 状态 -> 前端(busySessions:运行中的会话 id 列表,多会话并行的忙碌集合)
  const emitStatus = () => send({
    type: 'status',
    status: ssh.status,
    host: ssh.hostInfo?.host, port: ssh.hostInfo?.port, username: ssh.hostInfo?.username,
    platform: ssh.platform, home: ssh.home, workspace: ssh.workspace,
    agentBusy: agent.busyNow,
    busySessions: agent.busyIds(),
    llmModel: agent.llm ? (agent.llm.isMock ? 'mock' : agent.llm.model) : null
  });
  ssh.on('status', emitStatus);
  ssh.on('connection-lost', () => { agent.stopAll(); emitStatus(); });
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
          case 'get_history':
            reply({ type: 'history', turns: agent.getHistory(), todos: agent.currentTodos() });
            break;
          case 'clear_history':
            agent.clearHistory();
            reply({ type: 'ok' });
            send({ type: 'sessions', sessions: agent.listSessions(), active: agent.sessionId });
            break;
          // 手动压缩当前会话上下文(/compact 命令:无条件把早期对话压缩成摘要)
          case 'compact_now': {
            const r = await agent.compactNow(msg.id);
            reply({ type: 'ok', ...r });
            break;
          }

          case 'session_list':
            reply({ type: 'sessions', sessions: agent.listSessions(), active: agent.sessionId });
            break;
          case 'session_create': {
            // 多会话并行:新建/切换不影响其他会话的运行
            const s = agent.createSession(msg.title);
            reply({ type: 'sessions', sessions: agent.listSessions(), active: agent.sessionId, created: s });
            break;
          }
          case 'session_switch': {
            agent.switchSession(msg.id);
            reply({ type: 'sessions', sessions: agent.listSessions(), active: agent.sessionId });
            break;
          }
          case 'session_delete': {
            agent.deleteSession(msg.id);
            reply({ type: 'sessions', sessions: agent.listSessions(), active: agent.sessionId });
            break;
          }
          case 'session_rename':
            agent.renameSession(msg.id, msg.title);
            reply({ type: 'sessions', sessions: agent.listSessions(), active: agent.sessionId });
            break;
          case 'session_fork': {
            // 从当前活跃会话创建分支(at 为 turns 索引,截断到该条消息为止;
            // 缺省 -1 从尾部整体克隆)并切换
            const forked = agent.forkSession(typeof msg.at === 'number' && msg.at >= 0 ? msg.at : -1);
            reply({ type: 'sessions', sessions: agent.listSessions(), active: agent.sessionId, created: forked });
            break;
          }

          // ---- 技能管理(设置 → 技能;支持本机 local-project/local-user 与远程 project/user) ----
          case 'skills_list': {
            // 管理界面打开/刷新时强制重扫目录,保证看到最新文件状态;未连接时仅返回内置+本机技能
            const skills = await refreshSkillsCatalog();
            reply({ type: 'skills', skills });
            break;
          }
          case 'skill_get': {
            const skill = await getSkillFull(msg.name);
            if (!skill) throw new Error(`技能不存在: ${msg.name}`);
            reply({ type: 'skill', ...skill });
            break;
          }
          case 'skill_save': {
            // 本机目标(local-project/local-user)无需 SSH;远程目标内部会校验连接
            const r = await saveSkill(msg);
            reply({ type: 'ok', file: r.file, skills: r.skills });
            break;
          }
          case 'skill_delete': {
            const skills = await deleteSkill(msg.name);
            reply({ type: 'ok', skills });
            break;
          }
          case 'skill_copy_builtin': {
            // 把内置技能(随工具分发的本地技能库)复制到本机或远程项目级/用户级
            const r = await copyBuiltinToRemote({ name: msg.name, file: `builtin://${msg.name}/SKILL.md` }, msg.target);
            reply({ type: 'ok', ...r, skills: await refreshSkillsCatalog() });
            break;
          }

          // ---- 工具插件管理(设置 → 工具插件;禁用的工具不再暴露给模型) ----
          case 'tools_list':
            reply({ type: 'tools', tools: toolRegistry.listAll() });
            break;
          case 'tool_toggle': {
            const name = String(msg.name || '');
            if (!toolRegistry.get(name)) throw new Error(`工具不存在: ${name}`);
            toolSettings.setEnabled(name, msg.enabled !== false);
            reply({ type: 'tools', tools: toolRegistry.listAll() });
            break;
          }

          // ---- 全局指令注入(移植自 dsh-purge 插件:prompt-inject.md) ----
          case 'prompt_inject_get':
            reply({ type: 'ok', content: getPromptInject(), file: 'server/data/prompt-inject.md' });
            break;
          case 'prompt_inject_set': {
            const content = setPromptInject(msg.content);
            reply({ type: 'ok', content });
            break;
          }
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
            let done = 0;
            let lastEmit = 0;
            // 每删一项回调一次;节流到至少 120ms 一条,避免小目录也刷屏
            const onProgress = (p) => {
              done++;
              const now = Date.now();
              if (now - lastEmit >= 120) {
                lastEmit = now;
                send({ type: 'delete_progress', reqId, path: msg.path, done, current: p });
              }
            };
            if (type === 'dir') await ssh.rmdirRecursive(msg.path, onProgress);
            else { await new Promise((res, rej) => ssh.sftp.unlink(msg.path, (e) => (e ? rej(e) : res()))); onProgress(msg.path); }
            // 收尾一条 final,保证前端一定能看到"删完"(节流可能吞掉最后一条)
            send({ type: 'delete_progress', reqId, path: msg.path, done, final: true, current: msg.path });
            reply({ type: 'deleted', path: msg.path });
            break;
          }
          case 'copy': {
            if (!msg.src || !msg.dst) throw new Error('缺少 src 或 dst');
            const r = await ssh.copyPath(msg.src, msg.dst, { overwrite: msg.overwrite });
            reply({ type: 'copied', ...r });
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
            // 不 await:流式回收,事件经 send 推送;reasoning 为推理等级(default|off|low|high|xhigh|max)
            // 提交到当前活跃会话:该会话空闲时开新轮,运行中自动转为 steer(补充指令注入下一步)
            // 其他会话的运行不受影响(多会话并行)
            Promise.resolve(agent.submit(agent.sessionId, msg.text, { reasoning: msg.reasoning || 'default' }))
              .catch((e) => send({ type: 'agent', event: 'error', message: e.message, sid: agent.sessionId }))
              .finally(() => { emitStatus(); send({ type: 'sessions', sessions: agent.listSessions(), active: agent.sessionId }); });
            emitStatus(); // busy 立即置位,让前端马上显示"停止/暂停"
            reply({ type: 'ok' });
            break;
          }
          case 'stop_agent':
            agent.stop();
            emitStatus();
            reply({ type: 'ok' });
            break;

          case 'run_command': {
            if (!msg.command?.trim()) throw new Error('命令为空');
            const runId = Math.random().toString(36).slice(2, 10);
            send({ type: 'exec', runId, event: 'start', command: msg.command });
            ssh.exec(ssh.cdCommand(msg.command), {
              timeout: (msg.timeout || 300) * 1000,
              runId,
              onOut: (d) => send({ type: 'exec', runId, event: 'output', stream: 'stdout', data: d }),
              onErr: (d) => send({ type: 'exec', runId, event: 'output', stream: 'stderr', data: d })
            }).then((r) => send({ type: 'exec', runId, event: 'exit', code: r.code, signal: r.signal, timedOut: r.timedOut, stopped: r.stopped }))
              .catch((e) => send({ type: 'exec', runId, event: 'exit', code: -1, error: e.message }));
            reply({ type: 'ok' });
            break;
          }
          case 'stop_command': {
            const stopped = ssh.kill(msg.runId);
            reply({ type: 'ok', stopped });
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

  // ---------- 交互式终端通道(/ws/term) ----------
  // 每个连接对应一个远程 PTY shell;连接关闭即关闭 shell。
  // 文本帧(JSON):start {cols,rows} / resize {cols,rows}
  // 二进制帧:客户端键盘输入 -> shell;shell 输出 -> 客户端屏幕
  termWss.on('connection', (ws) => {
    let stream = null; // 当前 shell 通道
    let closed = false;

    const sendJson = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };
    const closeStream = () => {
      if (!stream) return;
      const s = stream; stream = null;
      try { s.close(); } catch {}
      try { s.end?.(); } catch {}
    };

    ws.on('message', (raw, isBinary) => {
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
        ssh.shell({ cols, rows }).then((s) => {
          if (closed || stream) { try { s.close(); } catch {} return; }
          stream = s;
          s.on('data', (d) => { if (ws.readyState === 1) { try { ws.send(d); } catch {} } });
          // PTY shell 输出走 stdout,stderr 一般为空,保险起见也转发
          s.stderr?.on('data', (d) => { if (ws.readyState === 1) { try { ws.send(d); } catch {} } });
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
        }).catch((e) => sendJson({ type: 'error', error: `打开终端失败: ${e.message}` }));
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