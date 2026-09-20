// 悬浮窗「停止」按钮的急停回调(HTTP,不是 WS RPC):
// 悬浮窗是一个独立的 PowerShell 进程,拿不到前端那条 WebSocket,用本机 HTTP 最直接。
// 语义 = 用户手动关闭:立即关控制 + 中断所有运行中的会话 + userLocked=true(AI 不得自行恢复)。
import type { FastifyInstance } from 'fastify';
import { computerUse } from '../../core/computer-use/index.ts';
import { agent } from '../../agent/agent.ts';

export default async function registerComputerUseHttp(app: FastifyInstance) {
  app.post('/api/computer-use/stop', async () => {
    computerUse.disableByUser();
    for (const id of agent.busyIds()) agent.stop(id);
    return { ok: true, ...computerUse.status() };
  });

  app.get('/api/computer-use/status', async () => ({ ok: true, ...computerUse.status() }));
}
