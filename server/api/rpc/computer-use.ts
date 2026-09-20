// AI 电脑操控 RPC:查询状态 / 用户手动开关。
// 悬浮窗「停止」按钮不走这里(它是独立 PowerShell 进程,回调 HTTP 接口,见 api/http/computer-use.ts);
// 这里服务的是应用界面里的开关与状态指示。
import { computerUse } from '../../core/computer-use/index.ts';
import { agent } from '../../agent/agent.ts';
import type { RpcModule } from './router.ts';

export function registerComputerUse(rpc: RpcModule) {
  rpc.register('computer_use_status', async (_msg, { reply }) => {
    reply({ type: 'computer_use', ...computerUse.status() });
  });

  // 用户手动开启/关闭。关闭时同时中断所有运行中的会话(AI 正在动电脑却关不掉会很危险),
  // 并置 userLocked=true —— AI 之后调用 computer_control(action="start") 会被拒绝。
  rpc.register('computer_use_set', async (msg, { reply, send }) => {
    const enabled = msg?.enabled === true;
    if (enabled) {
      computerUse.enableByUser();
    } else {
      computerUse.disableByUser();
      for (const id of agent.busyIds()) agent.stop(id);
    }
    const st = { type: 'computer_use', ...computerUse.status() };
    send(st);   // 广播给所有已打开界面
    reply(st);  // 同时作为本次请求的应答
  });
}
