// 应用入口:Fastify HTTP 服务 + WebSocket + 各领域插件
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { PORT, HOST } from './config.ts';
import { setupWs } from './core/ws.ts';
import { sshManager as ssh } from './core/ssh-manager.ts';
import registerBasic from './api/http/basic.ts';
import registerProviders from './api/http/providers.ts';
import registerUiState from './api/http/ui-state.ts';
import registerTransfer from './api/http/transfer.ts';
import registerStatic from './api/http/static.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../web/dist');

export async function startApp({ port = PORT, host = HOST, quiet = false } = {}) {
  // serverFactory 包住自建 http.Server,供 setupWs 在 app.server 上挂 /ws、/ws/term 的 upgrade 路由
  const app = Fastify({
    serverFactory: (handler) => http.createServer(handler),
    bodyLimit: 16 * 1024 * 1024, // 与原先 express.json({ limit: '16mb' }) 一致
    logger: quiet ? false : { level: 'info' }
  });

  await app.register(registerBasic);
  await app.register(registerProviders);
  await app.register(registerUiState);
  await app.register(registerTransfer);
  await app.register(registerStatic); // 最后注册:静态通配不能影响 API 路由

  const { wss, termWss } = setupWs(app.server);

  await app.listen({ port, host });
  if (!quiet) {
    console.log('==============================================');
    console.log('  SSH 远程 AI 编程工具已启动');
    console.log(`  http://${host}:${port}`);
    if (!fs.existsSync(distDir)) {
      console.log('  (未找到 web/dist,请先执行 npm run build 构建前端)');
    }
    console.log('==============================================');
  }
  return { app, server: app.server, wss, termWss, port };
}

// 直接运行时启动
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startApp().then(({ wss, termWss }) => {
    const shutdown = () => {
      console.log('\n正在退出…');
      try { wss.close(); } catch {}
      try { termWss.close(); } catch {}
      ssh.disconnectAll().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch((e) => { console.error(e); process.exit(1); });
}
