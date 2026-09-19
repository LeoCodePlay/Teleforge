// 基础接口插件:/api/readkey(读本机私钥文件)与 /api/health
import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sshManager as ssh } from '../../core/ssh-manager.ts';
import { agent } from '../../agent/agent.ts';

export default async function registerBasic(app: FastifyInstance) {
  // 读取本机私钥文件内容(仅供本地前端使用;服务默认只监听 127.0.0.1)
  app.post('/api/readkey', (request: FastifyRequest, reply: FastifyReply) => {
    const p = (request.body as any)?.path;
    if (!p) return reply.code(400).send({ error: '缺少 path' });
    let st;
    try { st = fs.statSync(p); } catch { return reply.code(404).send({ error: `无法读取文件: ${p}` }); }
    if (!st.isFile() || st.size > 1024 * 1024) return reply.code(400).send({ error: '仅支持 1MB 以内的文件' });
    try { return reply.send({ content: fs.readFileSync(p, 'utf8'), path: p }); }
    catch (e: any) { return reply.code(500).send({ error: `读取失败: ${e.message}` }); }
  });

  // agentBusy:是否有会话正在跑一轮对话。开发模式的热重启脚本据此在"对话进行中"延后重启 ——
  // 中途杀掉服务进程会让这一轮直接从对话里消失(用户看到的就是毫无征兆地停住)。
  app.get('/api/health', () => ({ ok: true, ts: Date.now(), connected: ssh.connected, workspace: ssh.workspace, agentBusy: agent.busyNow }));
}
