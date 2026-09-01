// 应用入口:HTTP 静态服务 + WebSocket + 上传/下载 + 本机私钥读取接口
import express from 'express';
import multer from 'multer';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PORT, HOST } from './config.js';
import { setupWs } from './ws.js';
import { sshManager as ssh, normalizeRemote, joinRemote } from './ssh-manager.js';
import { aiProviders } from './ai-providers-store.js';
import { uiState } from './ui-state-store.js';

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

// ---- 远程目录打包 tar.gz(node 内置 zlib,不依赖远程 zip;逐文件流式读取,不整目录进内存) ----
function tarOctal(n) {
  const s = Math.floor(n).toString(8);
  return '0000000'.slice(s.length) + s + '\0'; // 7 位八进制 + NUL
}
function tarHeader(relPath, { mode, size, mtimeSec, type, linkname = '' }) {
  const buf = Buffer.alloc(512);
  let name = relPath, prefix = '';
  if (Buffer.byteLength(relPath, 'utf8') > 100) { // ustar prefix 拆分
    const parts = relPath.split('/');
    let p = '', rest = relPath;
    while (Buffer.byteLength(rest, 'utf8') > 100 && parts.length > 1) {
      p = p ? p + '/' + parts[0] : parts[0];
      parts.shift();
      rest = parts.join('/');
    }
    if (Buffer.byteLength(rest, 'utf8') > 100 || Buffer.byteLength(p, 'utf8') > 155) {
      throw new Error(`路径过长,无法打包: ${relPath}`);
    }
    name = rest; prefix = p;
  }
  buf.write(name, 0, 100, 'utf8');
  buf.write(tarOctal(mode), 100, 8, 'ascii');
  buf.write(tarOctal(0), 108, 8, 'ascii');
  buf.write(tarOctal(0), 116, 8, 'ascii');
  buf.write(tarOctal(size), 124, 8, 'ascii');
  buf.write(tarOctal(mtimeSec), 136, 8, 'ascii');
  buf.fill(0x20, 148, 156); // checksum 先置空格
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  buf[156] = type.charCodeAt(0); // '0' 文件 '5' 目录 '2' 符号链接
  buf.write(linkname, 157, 100, 'utf8');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  buf.write(prefix, 345, 155, 'utf8');
  return buf;
}
// 递归收集一组远程路径(文件/目录)为 tar 条目;每个根路径映射到给定相对路径(rel)
async function collectRemotePaths(roots) {
  const out = [];
  const walk = async (dir, rel) => {
    const list = await ssh.listDir(dir);
    for (const e of list) {
      const relPath = rel + '/' + e.name;
      const abs = normalizeRemote(dir === '/' ? '/' + e.name : dir + '/' + e.name);
      const mtimeSec = Math.floor((e.mtime || 0) / 1000);
      if (e.type === 'dir') {
        out.push({ relPath: relPath + '/', type: 'dir', size: 0, mtimeSec, abs });
        await walk(abs, relPath);
      } else if (e.type === 'link') {
        let link = null;
        try { link = await new Promise((res, rej) => ssh.sftp.readlink(abs, (err, t) => (err ? rej(err) : res(t)))); } catch {}
        out.push({ relPath, type: 'link', size: 0, mtimeSec, link });
      } else {
        out.push({ relPath, type: 'file', size: e.size || 0, mtimeSec, abs });
      }
    }
  };
  for (const { abs, rel } of roots) {
    const type = await ssh.atype(abs);
    const mtimeSec = Math.floor(Date.now() / 1000);
    if (type === 'dir') {
      out.push({ relPath: rel + '/', type: 'dir', size: 0, mtimeSec, abs });
      await walk(abs, rel);
    } else if (type === 'link') {
      let link = null;
      try { link = await new Promise((res, rej) => ssh.sftp.readlink(abs, (err, t) => (err ? rej(err) : res(t)))); } catch {}
      out.push({ relPath: rel, type: 'link', size: 0, mtimeSec, link });
    } else {
      const st = await ssh.stat(abs);
      out.push({ relPath: rel, type: 'file', size: st?.size || 0, mtimeSec, abs });
    }
  }
  return out;
}
// 把一个远程文件分块读入 tar 流(512 对齐填充)
async function streamRemoteFileToTar(abs, size, write) {
  if (size <= 0) return;
  const handle = await new Promise((res, rej) => ssh.sftp.open(abs, 'r', (e, h) => (e ? rej(e) : res(h))));
  try {
    const buf = Buffer.alloc(256 * 1024);
    let off = 0, remaining = size;
    while (remaining > 0) {
      const n = Math.min(buf.length, remaining);
      const got = await new Promise((res, rej) => ssh.sftp.read(handle, buf, 0, n, off, (e, b) => (e ? rej(e) : res(b))));
      if (got <= 0) break;
      await write(buf.subarray(0, got));
      off += got; remaining -= got;
    }
    const pad = (512 - (size % 512)) % 512;
    if (pad) await write(Buffer.alloc(pad));
  } finally {
    try { await new Promise((res) => ssh.sftp.close(handle, () => res())); } catch {}
  }
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

  // 「我的 AI 模型提供商」配置文件的操作接口(增删改查)
  // 数据保存在 server/data/ai-providers.json(首次启动自动从 openclaw 导入种子)
  app.get('/api/providers', (req, res) => res.json({ userProviders: aiProviders.list() }));

  // 代理获取某端点的模型列表(浏览器直连外部 API 会被 CORS 拦截,故由服务端转发)
  // OpenAI 兼容端点均为 GET {baseUrl}/models → { data: [{ id }] }
  app.post('/api/providers/fetch-models', async (req, res) => {
    const baseUrl = String(req.body?.baseUrl || '').trim().replace(/\/+$/, '');
    const apiKey = String(req.body?.apiKey || '').trim();
    if (!/^https?:\/\//i.test(baseUrl)) return res.status(400).json({ error: 'Base URL 需以 http:// 或 https:// 开头' });
    try {
      const r = await fetch(baseUrl + '/models', {
        headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {},
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) return res.status(502).json({ error: `提供商返回 HTTP ${r.status},请检查 Base URL 与 API Key` });
      const j = await r.json();
      const raw = Array.isArray(j?.data) ? j.data.map((m) => m?.id)
        : Array.isArray(j?.models) ? j.models.map((m) => m?.id ?? m)
        : [];
      const models = [...new Set(raw.map((m) => String(m || '').trim()).filter(Boolean))].sort();
      res.json({ models });
    } catch (e) {
      res.status(502).json({ error: '获取模型列表失败:' + e.message });
    }
  });

  app.post('/api/providers', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const baseUrl = String(b.baseUrl || '').trim().replace(/\/+$/, '');
    if (!name) return res.status(400).json({ error: '请填写提供商名称' });
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return res.status(400).json({ error: 'Base URL 需以 http:// 或 https:// 开头' });
    const entry = {
      id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      baseUrl,
      models: Array.isArray(b.models) ? b.models.map((m) => String(m)).filter(Boolean) : [],
      apiKey: String(b.apiKey || ''),
      note: '由用户添加'
    };
    aiProviders.add(entry);
    res.json({ userProviders: aiProviders.list() });
  });

  // 更新某个提供商的字段(名称/地址/模型清单/API Key)
  app.patch('/api/providers/:id', (req, res) => {
    const b = req.body || {};
    const patch = {};
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim();
    if (typeof b.baseUrl === 'string') {
      const u = b.baseUrl.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(u)) return res.status(400).json({ error: 'Base URL 需以 http:// 或 https:// 开头' });
      patch.baseUrl = u;
    }
    if (Array.isArray(b.models)) patch.models = b.models.map((m) => String(m)).filter(Boolean);
    if (typeof b.apiKey === 'string') patch.apiKey = b.apiKey;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: '没有可更新的字段' });
    if (!aiProviders.update(req.params.id, patch)) return res.status(404).json({ error: '提供商不存在' });
    res.json({ userProviders: aiProviders.list() });
  });

  app.delete('/api/providers/:id', (req, res) => {
    if (!aiProviders.remove(req.params.id)) return res.status(404).json({ error: '提供商不存在' });
    uiState.remove(req.params.id); // 联动清理该提供方的选择级状态
    res.json({ userProviders: aiProviders.list() });
  });

  // 「LLM 选择级配置」:当前选中提供方 / 各提供方模型 / Key / 自定义模型名 / 迭代上限
  // 数据保存在 server/data/ui-state.json(与 ai-providers.json 同级)
  app.get('/api/ui-state', (req, res) => res.json({ uiState: uiState.get() }));
  app.patch('/api/ui-state', (req, res) => {
    const b = req.body || {};
    uiState.patch({
      providerId: typeof b.providerId === 'string' ? b.providerId : undefined,
      customModel: typeof b.customModel === 'string' ? b.customModel : undefined,
      models: b.models,
      keys: b.keys,
      maxIters: b.maxIters
    });
    res.json({ uiState: uiState.get() });
  });

  // 上传文件/文件夹到远程目录(multipart,字段名 files;文件 originalname 为相对路径)
// dir 查询参数指定目标目录(默认工作区),越权防护(../、绝对路径)在 normalizeRelPath 里
// 流程:预建目录(去重按深度排) → 并发多路 SFTP 写入(每完成一个流式回报进度包) → 最终 JSON
app.post('/api/upload', upload.array('files', 10000), async (req, res) => {
  try {
    if (!ssh.connected) return res.status(400).json({ error: 'SSH 未连接' });
    const base = normalizeRemote(req.query?.dir || ssh.workspace || '');
    if (!base) return res.status(400).json({ error: '请先选择远程工作区' });
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: '没有收到文件' });
    // 1) 一次性预建所有目标目录:去重后按深度从小到大排,避免每个文件重复逐级探测父目录
    const lineups = [];
    const dirs = new Set();
    const errors = [];
    for (const f of files) {
      const rel = normalizeRelPath(f.originalname);
      if (!rel) {
        errors.push(`${f.originalname || '(未命名)'}: 路径非法(不允许 ../ 或绝对路径)`);
        continue;
      }
      lineups.push({ rel, buf: f.buffer });
      dirs.add(remoteDirname(joinRemote(base, rel)));
    }
    for (const d of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)) {
      await ssh.mkdirp(d);
    }
    // 2) 并发多路写入(小文件多时比串行快数倍);每完成一个推送一条 NDJSON 进度,前端据此显示真实进度
    let uploaded = 0, bytes = 0;
    const CONCURRENCY = 8;
    const total = lineups.length;
    const pushProgress = () => {
      if (res.writableEnded) return;
      res.write(JSON.stringify({ type: 'progress', done: uploaded, total, bytes }) + '\n');
    };
    let idx = 0;
    const worker = async () => {
      while (idx < lineups.length) {
        const item = lineups[idx++];
        const target = joinRemote(base, item.rel);
        try {
          // maxBytes:0 不限制单文件大小(批次上传不受 2MB 编辑器限制);目录已预建,跳过重复探测
          await ssh.writeRemoteFile(target, item.buf, { maxBytes: 0, mkdir: false });
          uploaded += 1; bytes += item.buf.length;
        } catch (e) { errors.push(`${item.rel}: ${e.message}`); }
        pushProgress();
      }
    };
    await Promise.all([...Array(Math.min(CONCURRENCY, total))].map(() => worker()));
    // header 已被进度包发出,不能再用 res.json;以 NDJSON 行收尾,前端解析最后一行为结果
    res.write(JSON.stringify({ type: 'done', uploaded, failed: errors.length, bytes, errors: errors.slice(0, 20), dir: base }) + '\n');
    res.end();
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

  // 从远程下载目录/文件/多项选中:流式打包成 tar.gz(不落盘,递归包含子目录)
  // 支持重复 path 参数;多个路径统一打包到 download/ 下(同名自动加序号)
  app.get('/api/downloaddir', async (req, res) => {
    try {
      if (!ssh.connected) return res.status(400).send('SSH 未连接');
      const raws = req.query?.path;
      const paths = (Array.isArray(raws) ? raws : [raws]).map((p) => normalizeRemote(String(p || ''))).filter(Boolean);
      if (paths.length === 0) return res.status(400).send('缺少 path');
      for (const abs of paths) {
        const st = await ssh.stat(abs);
        if (!st) return res.status(404).send(`路径不存在: ${abs}`);
      }
      const multi = paths.length > 1;
      const used = new Set();
      const relFor = (abs) => {
        const base = abs.split('/').filter(Boolean).pop() || 'item';
        let rel = base, n = 2;
        while (used.has(rel)) { rel = `${base} (${n})`; n++; }
        used.add(rel);
        return (multi ? 'download/' : '') + rel;
      };
      const roots = paths.map((abs) => ({ abs, rel: relFor(abs) }));
      const entries = await collectRemotePaths(roots);
      const name = multi ? 'download' : (paths[0].split('/').filter(Boolean).pop() || 'download');
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name + '.tar.gz')}`);
      const gzip = zlib.createGzip();
      gzip.pipe(res);
      const write = (buf) => new Promise((resolve, reject) => {
        if (gzip.write(buf)) resolve();
        else { gzip.once('drain', resolve); gzip.once('error', reject); }
      });
      try {
        for (const e of entries) {
          if (e.type === 'dir') {
            await write(tarHeader(e.relPath, { mode: 0o755, size: 0, mtimeSec: e.mtimeSec, type: '5' }));
          } else if (e.type === 'link' && e.link) {
            await write(tarHeader(e.relPath, { mode: 0o777, size: 0, mtimeSec: e.mtimeSec, type: '2', linkname: e.link }));
          } else {
            await write(tarHeader(e.relPath, { mode: 0o644, size: e.size, mtimeSec: e.mtimeSec, type: '0' }));
            await streamRemoteFileToTar(e.abs, e.size, write);
          }
        }
        await write(Buffer.alloc(1024)); // tar 结束标记:两个 512 零块
        gzip.end();
      } catch (e) {
        try { res.destroy(); } catch {}
      }
    } catch (e) { try { res.status(500).send(e.message); } catch {} }
  });

  // 生产模式托管前端构建产物
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir, { index: false }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const { wss, termWss } = setupWs(server);

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
      resolve({ app, server, wss, termWss, port });
    });
  });
}

// 直接运行时启动
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startApp().then(({ server, wss, termWss }) => {
    const shutdown = () => {
      console.log('\n正在退出…');
      try { wss.close(); } catch {}
      try { termWss.close(); } catch {}
      ssh.disconnect().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch((e) => { console.error(e); process.exit(1); });
}