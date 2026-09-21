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
    logger: quiet ? false : { level: 'info' }
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

  // AI 电脑操控:把实际监听端口交给控制器,悬浮窗「停止」按钮要回调本机 HTTP 急停接口
  computerUse.configure({ port });
  await app.listen({ port, host });
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
      console.log('\n正在退出…');
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
