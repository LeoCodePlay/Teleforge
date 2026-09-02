// 服务器连接与配置消息:connect / disconnect / conn_disconnect / conn_switch / ssh_profiles_*
import fs from 'node:fs';
import { sshManager as ssh } from '../ssh-manager.ts';
import type { ConnectOpts } from '../ssh-manager.ts';
import { sshProfiles, sanitizeProfile } from '../ssh-profiles-store.ts';
import type { SshProfile } from '../ssh-profiles-store.ts';
import { clearSearchEngine, ensureSearchTools, clearEnvInfo } from '../agent/tools.ts';
import { agent } from '../agent/agent.ts';

// 解析 connect 消息:优先按已保存配置(仅凭 profileId 即可取回密码/密钥),否则用消息内的 ssh 原始参数
function resolveConnectOpts(msg: any): ConnectOpts {
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
  return { host, port: Number(port) || 22, username, autoReconnect: autoReconnect !== false, auth: { type: 'password', ...auth } as ConnectOpts['auth'] };
}

// 从已保存配置构造 ssh2 认证参数;密钥只存 keyPath 时由服务端本地读取(换浏览器/页面刷新也能连接)
function profileAuth(p: SshProfile): ConnectOpts['auth'] {
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

export function registerSsh(rpc) {
  rpc.register('connect', async (msg, { reply, emitStatus, syncAgentScope }) => {
    // 原 ws.js connect case(154-163)逐字复制
    await ssh.connect(resolveConnectOpts(msg));
    clearSearchEngine(); // 换服务器后旧探测结果失效,下次搜索重新探测
    ensureSearchTools({ force: true }).catch(() => {}); // 连接后后台自检,缺失的搜索工具自动安装(不阻塞连接应答)
    syncAgentScope();    // 连接成功后会话作用域切到该服务器
    reply({ type: 'ok' });
    emitStatus();
  });

  const disconnectHandler = async (msg, { reply, emitStatus, syncAgentScope }) => {
    // 原 ws.js disconnect/conn_disconnect 共享 case(164-176)逐字复制
    const conn = (msg.id ? ssh.conns.get(String(msg.id)) : ssh.active) || null;
    await ssh.disconnect(msg.id);
    clearSearchEngine();
    // 断开的是该会话所属服务器:其后台运行被中断(部分已生成内容会保留);
    // 其他服务器上的运行不受影响。
    agent.stopForConn(conn);
    syncAgentScope(); // 活动连接变化:回落到其他连接或本地模式
    reply({ type: 'ok' });
    emitStatus();
  };
  rpc.register('disconnect', disconnectHandler);       // 旧协议:断开活动连接
  rpc.register('conn_disconnect', disconnectHandler);  // 新协议:断开指定连接(缺省 = 活动连接)

  rpc.register('conn_switch', async (msg, { reply, emitStatus, syncAgentScope }) => {
    // 原 ws.js conn_switch case(177-188)逐字复制
    const ok = ssh.switchActive(String(msg.id || ''));
    if (!ok) throw new Error('连接不存在或已被移除');
    clearEnvInfo(); clearSearchEngine(); // 环境快照按服务器隔离
    syncAgentScope(); // 会话列表切到新服务器的会话
    reply({ type: 'ok' });
    emitStatus();
  });

  rpc.register('ssh_profiles_list', async (msg, { reply }) => {
    // 原 ws.js ssh_profiles_list case(190-192)逐字复制
    reply({ type: 'ssh_profiles', profiles: sshProfiles.list() });
  });

  rpc.register('ssh_profile_save', async (msg, { reply }) => {
    // 原 ws.js ssh_profile_save case(193-199)逐字复制
    const entry = sanitizeProfile(msg.profile);
    if (!entry) throw new Error('请填写主机与用户名');
    sshProfiles.upsert(entry);
    reply({ type: 'ssh_profiles', profiles: sshProfiles.list() });
  });

  rpc.register('ssh_profile_delete', async (msg, { reply }) => {
    // 原 ws.js ssh_profile_delete case(200-204)逐字复制
    if (!sshProfiles.remove(String(msg.id || ''))) throw new Error('配置不存在');
    reply({ type: 'ssh_profiles', profiles: sshProfiles.list() });
  });
}
