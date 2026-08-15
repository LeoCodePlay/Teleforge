// 应用入口:HTTP 静态服务 + WebSocket + 本机私钥读取接口
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, HOST } from './config.js';
import { setupWs } from './ws.js';
import { sshManager as ssh } from './ssh-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../web/dist');

export function startApp({ port = PORT, host = HOST, quiet = false } = {}) {
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  const server = http.createServer(app);

  // 读取本机私钥文件内容(仅供本地前端使用;服务默认只监听 127.0.0.1)
  app.post('/api/readkey', (req, res) => {
    const p = req.body?.path;
    if (!p) return res.status(400).json({ error: '缺少 path' });
    let st;
    try { st = fs.statSync(p); } catch { return res.status(404).json({ error: `无法读取文件: ${p}` }); }
    if (!st.isFile() || st.size > 1024 * 1024) return res.status(400).json({ error: '仅支持 1MB 以内的文件' });
    try { res.json({ content: fs.readFileSync(p, 'utf8'), path: p }); }
    catch (e) { res.status(500).json({ error: `读取失败: ${e.message}` }); }
  });
  app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now(), connected: ssh.connected, workspace: ssh.workspace }));

  // 生产模式托管前端构建产物
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir, { index: false }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const wss = setupWs(server);

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      if (!quiet) {
        console.log('==============================================');
        console.log('  SSH 远程 AI 编程工具已启动');
        console.log(`  http://${host}:${port}`);
        if (!fs.existsSync(distDir)) {
          console.log('  (未找到 web/dist,请先执行 npm run build 构建前端)');
        }
        console.log('==============================================');
      }
      resolve({ app, server, wss, port });
    });
  });
}

// 直接运行时启动
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startApp().then(({ server, wss }) => {
    const shutdown = () => {
      console.log('\n正在退出…');
      try { wss.close(); } catch {}
      ssh.disconnect().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch((e) => { console.error(e); process.exit(1); });
}