// 应用入口:HTTP 静态服务 + WebSocket + 上传/下载 + 本机私钥读取接口
import express from 'express';
import multer from 'multer';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, HOST } from './config.js';
import { setupWs } from './ws.js';
import { sshManager as ssh, normalizeRemote, joinRemote } from './ssh-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../web/dist');

// 上传文件的内存存储(单文件上限 256MB,单次最多 2000 个)
// preservePath: 保留 multipart 里的相对路径(文件夹结构),否则 multer 会截断为 basename
const upload = multer({
  storage: multer.memoryStorage(),
  preservePath: true,
  limits: { fileSize: 256 * 1024 * 1024, files: 2000 }
});

// 相对路径安全归一化:拒绝绝对路径与 ../ 越权,返回 a/b/c 形式
function normalizeRelPath(name) {
  let s = String(name || '').replace(/\\/g, '/').trim().replace(/^\/+/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === '..')) return null;
  return parts.join('/');
}
function remoteDirname(p) {
  const n = normalizeRemote(p);
  const i = n.lastIndexOf('/');
  return i <= 0 ? '/' : n.slice(0, i);
}

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

  // 上传文件/文件夹到远程工作区(multipart,字段名 files;文件 originalname 为相对路径)
  app.post('/api/upload', upload.array('files', 2000), async (req, res) => {
    try {
      if (!ssh.connected) return res.status(400).json({ error: 'SSH 未连接' });
      if (!ssh.workspace) return res.status(400).json({ error: '请先选择远程工作区' });
      const files = req.files || [];
      if (files.length === 0) return res.status(400).json({ error: '没有收到文件' });
      const ws = normalizeRemote(ssh.workspace);
      let uploaded = 0, bytes = 0;
      const errors = [];
      for (const f of files) {
        const rel = normalizeRelPath(f.originalname);
        if (!rel) { errors.push(`${f.originalname || '(未命名)'}: 路径非法(不允许 ../ 或绝对路径)`); continue; }
        const target = joinRemote(ws, rel);
        try {
          await ssh.mkdirp(remoteDirname(target));
          await ssh.writeRemoteFile(target, f.buffer);
          uploaded += 1; bytes += f.buffer.length;
        } catch (e) { errors.push(`${rel}: ${e.message}`); }
      }
      res.json({ uploaded, failed: errors.length, bytes, errors: errors.slice(0, 20) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 从远程工作区下载文件(SFTP 流式)
  app.get('/api/download', async (req, res) => {
    try {
      if (!ssh.connected) return res.status(400).send('SSH 未连接');
      const p = String(req.query.path || '');
      const st = await ssh.stat(p);
      if (!st) return res.status(404).send('文件不存在');
      if (st.isDirectory()) return res.status(400).send('是目录,请选择文件');
      const name = p.split('/').filter(Boolean).pop() || 'download';
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      const stream = ssh.sftp.createReadStream(p);
      stream.on('error', (e) => { try { res.destroy(e); } catch {} });
      stream.pipe(res);
    } catch (e) { res.status(500).send(e.message); }
  });

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