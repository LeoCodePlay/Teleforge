// 应用入口:Fastify HTTP 服务 + WebSocket + 各领域插件
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { PORT, HOST } from './config.ts';
import { initNetwork, networkSummary } from './core/net.ts';
import { setupWs } from './core/ws.ts';
import { sshManager as ssh } from './core/ssh-manager.ts';
import { computerUse } from './core/computer-use/index.ts';
import { browserManager } from './core/browser-manager.ts';
import { closeTunnels } from './core/port-tunnel.ts';
import { markCleanQuit } from './store/clean-quit.ts';
import { scheduleService } from './schedule/index.ts';
import { mcpManager } from './mcp/manager.ts';
import * as sessions from './store/session-store.ts';
import registerBasic from './api/http/basic.ts';
import registerProviders from './api/http/providers.ts';
import registerUiState from './api/http/ui-state.ts';
import registerTransfer from './api/http/transfer.ts';
import registerMedia from './api/http/media.ts';
import registerComputerUseHttp from './api/http/computer-use.ts';
import registerAttachments from './api/http/attachments.ts';
import registerBrowserBridgeHttp from './api/http/browser-bridge.ts';
import registerStatic from './api/http/static.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../web/dist');

// 进程级兜底:后端一旦静默退出,界面就会看到「与本地服务的连接已断开」(WS 关闭),正在跑的
// 那一轮连 turn/end 都来不及写,重启后只剩「上一轮对话没有正常结束」——而桌面端的外壳只在
// 启动时拉一次后端,进程没了就不会再拉,用户只能重启应用。所以这类错误必须"记录下来并活下来",
// 绝不能让它无声带走整个进程(默认行为:Node 15+ 未处理的 rejection 直接退出进程)。
// 说明:uncaughtException 之后进程状态不保证干净,但本工具的代价对比很明确——继续跑最多是
// 某个功能异常,直接退出则是"正在干的长任务全丢 + 界面卡在断连提示"。
function logFatalGuard(what: string, err: unknown): void {
  const e = err as any;
  const detail = e instanceof Error ? (e.stack || e.message) : String(e);
  // 同步写 stderr:桌面端把它重定向到 backend.log,崩溃现场必须落盘才可排查
  try {
    console.error(`\n[致命兜底] ${what} @ ${new Date().toISOString()}\n${detail}\n(后端继续运行;若随后出现异常行为,请把这段日志一并提供)\n`);
  } catch { /* 日志写不出去也不能再抛 */ }
}
process.on('unhandledRejection', (reason) => logFatalGuard('未处理的 Promise 拒绝', reason));
process.on('uncaughtException', (err) => logFatalGuard('未捕获异常', err));

// 预览浏览器状态里要带上"归属会话标题"(前端左下角显示已连接的会话)。
// 查询函数在启动时注入浏览器内核,避免 core → store 的模块循环依赖。
browserManager.setSessionTitleLookup((sid: string) => {
  const hit = sessions.list().find((s) => s.id === sid);
  return hit ? (hit.title || '未命名会话') : null;
});

export async function startApp({ port = PORT, host = HOST, quiet = false } = {}) {
  // 出站网络:固定 DNS 顺序(默认 IPv4 优先)+ 探测系统代理,详见 core/net.ts
  await initNetwork();
  // serverFactory 包住自建 http.Server,供 setupWs 在 app.server 上挂 /ws、/ws/term、/ws/browser 的 upgrade 路由
  const app = Fastify({
    serverFactory: (handler) => http.createServer(handler),
    bodyLimit: 16 * 1024 * 1024, // 与原先 express.json({ limit: '16mb' }) 一致
    // 默认 warn:逐请求的 info 日志(每条请求 2 行)在桌面端会一直追加进 backend.log,
    // 实测一个前端自激循环就写出一份 525MB 的日志文件。排查时用 TELEFORGE_LOG_LEVEL=info 打开。
    logger: quiet ? false : { level: process.env.TELEFORGE_LOG_LEVEL || 'warn' }
  });

  await app.register(registerBasic);
  await app.register(registerProviders);
  await app.register(registerUiState);
  await app.register(registerTransfer);
  await app.register(registerMedia);
  await app.register(registerComputerUseHttp);
  await app.register(registerAttachments);
  await app.register(registerBrowserBridgeHttp);
  await app.register(registerStatic); // 最后注册:静态通配不能影响 API 路由

  const { wss, termWss, browserWss, extWss } = setupWs(app.server);

  // 自动化任务:载入任务表后立刻 requestDrive(迁移自 dsh schedule 包的 ScheduleRuntime,
  // 见 server/schedule/)。必须在 setupWs 之后启动 —— 广播 hub 是在那里注入的。
  void scheduleService.start();

  // AI 电脑操控:把实际监听端口交给控制器,悬浮窗「停止」按钮要回调本机 HTTP 急停接口
  computerUse.configure({ port });
  await app.listen({ port, host });
  // MCP 外部服务器:按 data/mcp-servers.json 连接并注册其工具。
  // 不 await:连接与工具发现异步进行(慢/挂掉的 server 不该拖住宿主启动),
  // 状态由「设置 → MCP 服务」面板查询;与 harness"工具在首个回合前就位"的差别仅此一处。
  void mcpManager.start().catch((e) => console.error('[mcp] 启动失败:', e?.message || e));
  if (!quiet) {
    console.log('==============================================');
    console.log('  SSH 远程 AI 编程工具已启动');
    console.log(`  http://${host}:${port}`);
    console.log(`  出站网络:${networkSummary()}`);
    if (!fs.existsSync(distDir)) {
      console.log('  (未找到 web/dist,请先执行 npm run build 构建前端)');
    }
    console.log('==============================================');
  }
  return { app, server: app.server, wss, termWss, browserWss, extWss, port };
}

// 直接运行时启动
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startApp().then(({ wss, termWss, browserWss, extWss }) => {
    const shutdown = () => {
      // 先落"主动退出"标记:下次启动据此判断"不该自动续跑"(见 store/clean-quit.ts)。
      // 桌面端走的是 TerminateProcess(收不到 SIGTERM),标记由外壳在 kill 前写(见 backend.rs)。
      markCleanQuit('signal');
      console.log('\n正在退出…');
      void scheduleService.dispose(); // 停表 + 等在途投递收尾,别在退出过程中再投递任务
      void mcpManager.dispose(); // 关掉全部 MCP 连接(含 stdio 子进程),别把子进程留成孤儿
      try { wss.close(); } catch {}
      try { termWss.close(); } catch {}
      try { browserWss.close(); } catch {}
      try { extWss.close(); } catch {}
      computerUse.shutdown(); // 关掉「AI 操控中」悬浮窗与常驻控制助手进程
      closeTunnels();
      browserManager.closeAll().catch(() => {}).finally(() => {
        ssh.disconnectAll().finally(() => process.exit(0));
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch((e) => { console.error(e); process.exit(1); });
}
