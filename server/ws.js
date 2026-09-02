// WebSocket 服务层:统一协议转发
// 客户端 -> 服务端: connect/disconnect/conn_switch/conn_disconnect/llm/list_dir/read_file/write_file/create_dir/delete/
//                    set_workspace/speak/stop_agent/run_command/stop_command/get_status/ssh_profiles_*
// 服务端 -> 客户端: status/dir_list/file_content/file_saved/dir_created/deleted/workspace/
//                    agent(事件流)/exec(命令输出流)/log/error/ssh_profiles
//
// 另有 /ws/term 交互式终端通道(真实 PTY shell):文本帧 = JSON 控制消息
// (start/resize),二进制帧 = 终端原始数据(键盘输入上行 / 屏幕输出下行)
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { WS_MAX_PAYLOAD } from './config.js';
import { sshManager as ssh } from './ssh-manager.js';
import { localFs } from './local-fs.js';
import { localToRemote, remoteToLocal } from './transfer.js';
import { agent, toolRegistry, setAgentHub } from './agent/agent.js';
import { clearEnvInfo, clearLocalEnvInfo, clearSearchEngine, ensureSearchTools, refreshSkillsCatalog, getSkillFull, saveSkill, deleteSkill, copyBuiltinToRemote } from './agent/tools.js';
import { answerAskUser, rejectAskUser, rejectAllAskUser } from './agent/ask-user.js';
import { toolSettings } from './agent/tool-settings.js';
import { getPromptInject, setPromptInject } from './agent/prompt-inject.js';
import { sshProfiles, sanitizeProfile } from './ssh-profiles-store.js';
import { migrateLegacy } from './session-store.js';

// 解析 connect 消息:优先按已保存配置(仅凭 profileId 即可取回密码/密钥),否则用消息内的 ssh 原始参数
function resolveConnectOpts(msg) {
  if (msg.profileId) {
    const p = sshProfiles.get(String(msg.profileId));
    if (!p) throw new Error('保存的服务器不存在,请刷新列表后重试');
    return {
      profileId: p.id, host: p.host, port: Number(p.port) || 22, username: p.username,
      autoReconnect: p.autoReconnect !== false,
      auth: profileAuth(p)
    };
  }
  const { host, port, username, auth, autoReconnect } = msg.ssh || {};
  if (!host || !username) throw new Error('缺少 host 或 username');
  return { host, port: Number(port) || 22, username, autoReconnect: autoReconnect !== false, auth: { type: 'password', ...auth } };
}

// 从已保存配置构造 ssh2 认证参数;密钥只存 keyPath 时由服务端本地读取(换浏览器/页面刷新也能连接)
function profileAuth(p) {
  if (p.authType === 'key') {
    let privateKey = p.keyText;
    if (!privateKey && p.keyPath) {
      try { privateKey = fs.readFileSync(p.keyPath, 'utf8'); }
      catch (e) { throw new Error(`读取私钥失败(${p.keyPath}): ${e.message}`); }
    }
    return { type: 'privateKey', privateKey, passphrase: p.passphrase || undefined };
  }
  return { type: 'password', password: p.password };
}

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
  ssh.on('connection-lost', (key) => {
    clearSearchEngine();
    const lost = key != null ? ssh.conns.get(String(key)) : null;
    if (lost) agent.stopForConn(lost); else agent.stopAll();
    syncAgentScope();
    emitStatus();
  });
  ssh.on('log', (level, message) => send({ type: 'log', level, message }));

  // ---- 会话作用域:会话按"当前活动连接"隔离(连接 = username@host:port;无连接 = 本地工作区模式) ----
  const LOCAL_CONN_KEY = 'local';
  const connKeyOf = (conn) => {
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

  wss.on('connection', (ws) => {
    client = ws;
    send({ type: 'log', level: 'info', message: '前端已连接' });
    syncAgentScope();
    emitStatus();

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return send({ type: 'error', error: '消息不是合法 JSON' }); }
      const { type, reqId } = msg;
      const reply = (payload) => send({ ...payload, reqId });

      try {
        switch (type) {
          case 'connect': {
            // 支持两种入参:msg.profileId(已保存配置)或 msg.ssh(原始连接参数)
            await ssh.connect(resolveConnectOpts(msg));
            clearSearchEngine(); // 换服务器后旧探测结果失效,下次搜索重新探测
            ensureSearchTools({ force: true }).catch(() => {}); // 连接后后台自检,缺失的搜索工具自动安装(不阻塞连接应答)
            syncAgentScope();    // 连接成功后会话作用域切到该服务器
            reply({ type: 'ok' });
            emitStatus();
            break;
          }
          case 'disconnect':   // 旧协议:断开活动连接
          case 'conn_disconnect': { // 新协议:断开指定连接(缺省 = 活动连接)
            const conn = (msg.id ? ssh.conns.get(String(msg.id)) : ssh.active) || null;
            await ssh.disconnect(msg.id);
            clearSearchEngine();
            // 断开的是该会话所属服务器:其后台运行被中断(部分已生成内容会保留);
            // 其他服务器上的运行不受影响。
            agent.stopForConn(conn);
            syncAgentScope(); // 活动连接变化:回落到其他连接或本地模式
            reply({ type: 'ok' });
            emitStatus();
            break;
          }
          case 'conn_switch': {
            // 快速切换活动连接:不重新连接,只切换操作对象。
            // 不停止任何会话:正在回答的会话绑定其所属服务器的连接,继续后台运行,
            // 会话列表里会保留它(标「运行中」),切回该服务器即可查看。
            const ok = ssh.switchActive(String(msg.id || ''));
            if (!ok) throw new Error('连接不存在或已被移除');
            clearEnvInfo(); clearSearchEngine(); // 环境快照按服务器隔离
            syncAgentScope(); // 会话列表切到新服务器的会话
            reply({ type: 'ok' });
            emitStatus();
            break;
          }
          // ---- SSH 服务器配置管理(存后端,换浏览器/刷新共享) ----
          case 'ssh_profiles_list':
            reply({ type: 'ssh_profiles', profiles: sshProfiles.list() });
            break;
          case 'ssh_profile_save': {
            const entry = sanitizeProfile(msg.profile);
            if (!entry) throw new Error('请填写主机与用户名');
            sshProfiles.upsert(entry);
            reply({ type: 'ssh_profiles', profiles: sshProfiles.list() });
            break;
          }
          case 'ssh_profile_delete': {
            if (!sshProfiles.remove(String(msg.id || ''))) throw new Error('配置不存在');
            reply({ type: 'ssh_profiles', profiles: sshProfiles.list() });
            break;
          }
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
            send({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
            break;
          // 手动压缩当前会话上下文(/compact 命令:无条件把早期对话压缩成摘要)
          case 'compact_now': {
            const r = await agent.compactNow(msg.id);
            reply({ type: 'ok', ...r });
            break;
          }

          case 'session_list':
            reply({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
            break;
          case 'session_create': {
            // 多会话并行:新建/切换不影响其他会话的运行
            const s = agent.createSession(msg.title);
            reply({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId, created: s });
            break;
          }
          case 'session_switch': {
            agent.switchSession(msg.id);
            reply({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
            break;
          }
          case 'session_delete': {
            agent.deleteSession(msg.id);
            reply({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
            break;
          }
          case 'session_rename':
            agent.renameSession(msg.id, msg.title);
            reply({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId });
            break;
          case 'session_fork': {
            // 从当前活跃会话创建分支(at 为 turns 索引,截断到该条消息为止;
            // 缺省 -1 从尾部整体克隆)并切换
            const forked = agent.forkSession(typeof msg.at === 'number' && msg.at >= 0 ? msg.at : -1);
            reply({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId, created: forked });
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

          // ---- 本地文件操作(服务端直读写宿主机,无需 SSH)----
          case 'list_local_dir': {
            // 空串/root: = "我的电脑"根视图(Windows 盘符 / POSIX 根);其余为真实路径
            const raw = String(msg.path || '').trim();
            const isRoot = raw === '' || raw === 'root:';
            const entries = await localFs.listDir(isRoot ? '' : raw);
            reply({ type: 'local_dir_list', path: isRoot ? 'root:' : raw, entries });
            break;
          }
          case 'read_local_file': {
            const { buffer, size, truncated } = await localFs.readFileChunk(msg.path, { maxBytes: msg.maxBytes });
            if (localFs.isProbablyBinary(buffer)) reply({ type: 'local_file_content', path: msg.path, binary: true, size, truncated });
            else reply({ type: 'local_file_content', path: msg.path, content: buffer.toString('utf8'), size, truncated });
            break;
          }
          case 'write_local_file': {
            const bytes = await localFs.writeFile(msg.path, msg.content);
            reply({ type: 'local_file_saved', path: msg.path, size: bytes });
            break;
          }
          case 'create_local_dir': {
            await localFs.mkdirp(msg.path);
            reply({ type: 'local_dir_created', path: msg.path });
            break;
          }
          case 'local_delete': {
            const type = await localFs.atype(msg.path);
            if (!type) throw new Error(`路径不存在: ${msg.path}`);
            let done = 0, lastEmit = 0;
            const onProgress = (p) => { done++; const now = Date.now(); if (now - lastEmit >= 120) { lastEmit = now; send({ type: 'local_delete_progress', reqId, path: msg.path, done, current: p }); } };
            await localFs.rmdirRecursive(msg.path, onProgress);
            send({ type: 'local_delete_progress', reqId, path: msg.path, done, final: true, current: msg.path });
            reply({ type: 'local_deleted', path: msg.path });
            break;
          }
          case 'local_copy': {
            if (!msg.src || !msg.dst) throw new Error('缺少 src 或 dst');
            const r = await localFs.copyPath(msg.src, msg.dst, { overwrite: msg.overwrite });
            reply({ type: 'local_copied', ...r });
            break;
          }
          case 'local_to_remote': {
            const paths = (Array.isArray(msg.paths) ? msg.paths : [msg.paths]).filter(Boolean);
            if (!paths.length) throw new Error('缺少本地路径');
            const r = await localToRemote(paths, msg.dir, {
              onProgress: (p) => send({ type: 'transfer_progress', reqId, ...p })
            });
            reply({ type: 'transfer_done', ...r });
            break;
          }
          case 'remote_to_local': {
            const paths = (Array.isArray(msg.paths) ? msg.paths : [msg.paths]).filter(Boolean);
            if (!paths.length) throw new Error('缺少远程路径');
            const r = await remoteToLocal(paths, msg.dir, {
              onProgress: (p) => send({ type: 'transfer_progress', reqId, ...p })
            });
            reply({ type: 'transfer_done', ...r });
            break;
          }
          case 'set_local_workspace': {
            const st = await localFs.stat(msg.path);
            if (!st) throw new Error(`目录不存在: ${msg.path}`);
            if (!st.isDirectory()) throw new Error(`不是目录: ${msg.path}`);
            localFs.workspace = msg.path;
            clearLocalEnvInfo(); // 本地工作区变化,旧本地环境快照失效
            reply({ type: 'local_workspace', path: msg.path });
            emitStatus();
            break;
          }

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
            // 可连服务器对话(操作远程+本地),也可不连服务器仅操作本地工作区
            if (!ssh.workspace && !localFs.workspace) throw new Error('请先选择远程工作区或本地工作区');
            // 不 await:流式回收,事件经 send 推送;reasoning 为推理等级(default|off|low|high|xhigh|max)
            // 提交到当前活跃会话:该会话空闲时开新轮,运行中自动转为 steer(补充指令注入下一步)
            // 其他会话的运行不受影响(多会话并行)
            Promise.resolve(agent.submit(agent.sessionId, msg.text, { reasoning: msg.reasoning || 'default' }))
              .catch((e) => send({ type: 'agent', event: 'error', message: e.message, sid: agent.sessionId }))
              .finally(() => { emitStatus(); send({ type: 'sessions', sessions: agent.listVisible(), active: agent.sessionId }); });
            emitStatus(); // busy 立即置位,让前端马上显示"停止/暂停"
            reply({ type: 'ok' });
            break;
          }
          case 'stop_agent':
            agent.stop();
            emitStatus();
            reply({ type: 'ok' });
            break;

          // ---- 用户提问(ask_user_question):前端作答回传 / 取消 ----
          // 模型调用 ask_user_question 时会广播 agent 事件 ask_user(含 askId+题面),
          // 前端作答后回传;挂起的提问由 ask-user.js 管理,超时/中止/断开自动作废。
          case 'ask_user_answer': {
            if (!answerAskUser(msg.askId, msg.answers)) throw new Error('提问不存在或已过期');
            reply({ type: 'ok' });
            break;
          }
          case 'ask_user_cancel': {
            if (!rejectAskUser(msg.askId, '用户取消了提问')) throw new Error('提问不存在或已过期');
            reply({ type: 'ok' });
            break;
          }

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