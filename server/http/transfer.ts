// @ts-nocheck
// 远程上传/下载插件:/api/upload(NDJSON 流式进度)、/api/download、/api/downloaddir(tar.gz 流式打包)
import multer from 'multer';
import middie from '@fastify/middie';
import zlib from 'node:zlib';
import { sshManager as ssh, normalizeRemote, joinRemote } from '../ssh-manager.ts';
import { streamTarToGzip } from './tar.ts';

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

export default async function registerTransfer(app) {
  await app.register(middie);

  // multer 经 middie 在 onRequest 消费 multipart 流并填充 request.raw.files;
  // 为绕过 Fastify 对 multipart/form-data 的内置解析(无解析器会直接 415),注册空解析器,
  // 请求体由 multer 全权接管
  app.addContentTypeParser('multipart/form-data', (_req, _payload, done) => done(null));

  // 上传文件/文件夹到远程目录(multipart,字段名 files;文件 originalname 为相对路径)
  // dir 查询参数指定目标目录(默认工作区),越权防护(../、绝对路径)在 normalizeRelPath 里
  // 流程:预建目录(去重按深度排) → 并发多路 SFTP 写入(每完成一个流式回报进度包) → 最终 JSON
  // 校验与 mkdirp 都发生在 hijack 之前,保证 400/500 走正常 Fastify 响应;
  // 确认无误后 hijack,以 NDJSON 流式回报进度(与原 Express 行为一致)。
  app.use('/api/upload', upload.array('files', 10000));
  app.post('/api/upload', async (request, reply) => {
    if (!ssh.connected) return reply.code(400).send({ error: 'SSH 未连接' });
    const base = normalizeRemote(request.query?.dir || ssh.workspace || '');
    if (!base) return reply.code(400).send({ error: '请先选择远程工作区' });
    const files = request.raw.files || [];
    if (files.length === 0) return reply.code(400).send({ error: '没有收到文件' });
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
    try {
      for (const d of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)) {
        await ssh.mkdirp(d);
      }
    } catch (e) { return reply.code(500).send({ error: e.message }); }

    // 2) 并发多路写入(小文件多时比串行快数倍);每完成一个推送一条 NDJSON 进度,前端据此显示真实进度
    reply.hijack();
    const res = reply.raw;
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
    try {
      await Promise.all([...Array(Math.min(CONCURRENCY, total))].map(() => worker()));
      // header 已被进度包发出,不能再用 res.json;以 NDJSON 行收尾,前端解析最后一行为结果
      res.write(JSON.stringify({ type: 'done', uploaded, failed: errors.length, bytes, errors: errors.slice(0, 20), dir: base }) + '\n');
      res.end();
    } catch (e) {
      try { res.write(JSON.stringify({ error: e.message }) + '\n'); } catch {}
      try { res.end(); } catch {}
    }
  });

  // 从远程工作区下载文件(SFTP 流式)
  app.get('/api/download', async (request, reply) => {
    try {
      if (!ssh.connected) return reply.code(400).send('SSH 未连接');
      const p = String(request.query.path || '');
      const st = await ssh.stat(p);
      if (!st) return reply.code(404).send('文件不存在');
      if (st.isDirectory()) return reply.code(400).send('是目录,请选择文件');
      const name = p.split('/').filter(Boolean).pop() || 'download';
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      return ssh.sftp.createReadStream(p);
    } catch (e) { return reply.code(500).send(e.message); }
  });

  // 从远程下载目录/文件/多项选中:流式打包成 tar.gz(不落盘,递归包含子目录)
  // 支持重复 path 参数;多个路径统一打包到 download/ 下(同名自动加序号)
  app.get('/api/downloaddir', async (request, reply) => {
    try {
      if (!ssh.connected) return reply.code(400).send('SSH 未连接');
      const raws = request.query?.path;
      const paths = (Array.isArray(raws) ? raws : [raws]).map((p) => normalizeRemote(String(p || ''))).filter(Boolean);
      if (paths.length === 0) return reply.code(400).send('缺少 path');
      for (const abs of paths) {
        const st = await ssh.stat(abs);
        if (!st) return reply.code(404).send(`路径不存在: ${abs}`);
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
      const name = multi ? 'download' : (paths[0].split('/').filter(Boolean).pop() || 'download');
      reply.header('Content-Type', 'application/gzip');
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name + '.tar.gz')}`);
      const gzip = zlib.createGzip();
      const write = (buf) => new Promise((resolve, reject) => {
        if (gzip.write(buf)) resolve();
        else { gzip.once('drain', resolve); gzip.once('error', reject); }
      });
      // 异步把 tar 条目写进 gzip;处理器立即返回 gzip,由 Fastify 接管管道(流式送达客户端)
      streamTarToGzip(gzip, roots, write).catch((e) => { try { gzip.destroy(); } catch {} });
      return gzip;
    } catch (e) { return reply.code(500).send(e.message); }
  });
}
