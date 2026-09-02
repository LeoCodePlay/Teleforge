// 命令执行消息:run_command / stop_command
import { sshManager as ssh } from '../../core/ssh-manager.ts';
import type { RpcModule } from './router.ts';

export function registerExec(rpc: RpcModule) {
  rpc.register('run_command', async (msg, { reply, send }) => {
    // 原 ws.js run_command case(479-492)逐字复制
    if (!msg.command?.trim()) throw new Error('命令为空');
    const runId = Math.random().toString(36).slice(2, 10);
    send({ type: 'exec', runId, event: 'start', command: msg.command });
    ssh.exec(ssh.cdCommand(msg.command), {
      timeout: (msg.timeout || 300) * 1000,
      runId,
      onOut: (d) => send({ type: 'exec', runId, event: 'output', stream: 'stdout', data: d }),
      onErr: (d) => send({ type: 'exec', runId, event: 'output', stream: 'stderr', data: d })
    }).then((r: any) => send({ type: 'exec', runId, event: 'exit', code: r.code, signal: r.signal, timedOut: r.timedOut, stopped: r.stopped }))
      .catch((e: any) => send({ type: 'exec', runId, event: 'exit', code: -1, error: e.message }));
    reply({ type: 'ok' });
  });

  rpc.register('stop_command', async (msg, { reply }) => {
    // 原 ws.js stop_command case(493-497)逐字复制
    const stopped = ssh.kill(msg.runId);
    reply({ type: 'ok', stopped });
  });
}
