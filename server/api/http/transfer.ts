// 远程上传/下载插件:/api/upload(NDJSON 流式进度)、/api/upload/file(单文件流式并发上传)、
// /api/upload/prepare(批量预建目录)、/api/download、/api/downloaddir(tar.gz 流式打包)
import multer from 'multer';
import middie from '@fastify/middie';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import zlib from 'node:zlib';
import { sshManager as ssh, normalizeRemote, joinRemote } from '../../core/ssh-manager.ts';
import { streamTarToGzip } from './tar.ts';

// 上传文件的内存存储(单文件上限 256MB,单次最多 2000 个)
// preservePath: 保留 multipart 里的相对路径(文件夹结构),否则 multer 会截断为 basename
const upload = multer({
  storage: multer.memoryStorage(),
  preservePath: true,
  limits: { fileSize: 256 * 1024 * 1024, files: 2000 }
});

// 相对路径安全归一化:拒绝绝对路径与 ../ 越权,返回 a/b/c 形式
function normalizeRelPath(name: string) {
  let s = String(name || '').replace(/\\/g, '/').trim().replace(/^\/+/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === '..')) return null;
  return parts.join('/');
}
function remoteDirname(p: string) {
  const n = normalizeRemote(p);
  const i = n.lastIndexOf('/');
  return i <= 0 ? '/' : n.slice(0, i);
}
function remoteBase(p: string) {
  return normalizeRemote(p).split('/').filter(Boolean).pop() || 'upload';
}

export default async function registerTransfer(app: FastifyInstance) {
  await app.register(middie);

  // multer 经 middie 在 onRequest 消费 multipart 流并填充 request.raw.files;
  // 为绕过 Fastify 对 multipart/form-data 的内置解析(无解析器会直接 415),注册空解析器,
  // 请求体由 multer 全权接管
  app.addContentTypeParser('multipart/form-data', (_req: any, _payload: any, done: (e?: any) => void) => done(null));

  // ---- 新版上传通道:多文件并发 + 单文件流式 ----
  // 旧的一次性 multipart 上传有两个硬伤:① 整批文件先全部驻留内存(multer memoryStorage),
  // 大文件/多文件把进程内存顶爆,表现就是"传一半就断";② 服务端逐文件串行 SFTP 写,
  // 每个写请求都要等 ack,吞吐被 RTT 钉死(几十 ~ 几百 KB/s)。
  // 现在拆成两步:一次预建目录 → 每个文件一条请求,流式并发写入。
  // 请求体同时是文件原始字节(application/octet-stream),这里只需声明"不解析",由处理器自己消费。
  app.addContentTypeParser('application/octet-stream', (_req: any, _payload: any, done: (e?: any) => void) => done(null));

  // 1) 预建目录:去重后按深度从小到大建好本次要写的全部父目录。
  //    逐文件建目录会让几百个文件重复探测同一串父目录(SFTP stat × N),这里只做一轮。
  app.post('/api/upload/prepare', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ssh.connected) return reply.code(400).send({ error: 'SSH 未连接' });
    const body = (request.body || {}) as any;
    const base = normalizeRemote(body.dir || ssh.workspace || '');
    if (!base) return reply.code(400).send({ error: '请先选择远程工作区' });
    const rels = Array.isArray(body.rels) ? body.rels : [];
    const errors: string[] = [];
    const dirs = new Set<string>();
    for (const raw of rels) {
      const rel = normalizeRelPath(String(raw || ''));
      if (!rel) { errors.push(`${raw || '(未命名)'}: 路径非法(不允许 ../ 或绝对路径)`); continue; }
      dirs.add(remoteDirname(joinRemote(base, rel)));
    }
    try {
      for (const d of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)) await ssh.mkdirp(d);
    } catch (e: any) { return reply.code(500).send({ error: e.message }); }
    return { dir: base, failed: errors.length, errors: errors.slice(0, 20) };
  });

  // 2) 单文件上传:请求体是文件的原始字节,dir/rel/size 走 query。
  //    请求体直接灌进 SFTP(并发流水线写),既不落盘也不整文件驻留内存——内存占用与文件大小无关。
  //    落盘顺序:先写同目录下的临时文件 .<文件名>.part-<随机>,字节数与声明的 size 一致才 rename 成目标名。
  //    于是「目标路径上看到这个文件」= 它一定是完整的;中途失败/断开只会留下临时文件,由本接口自己删掉。
  //    前端按文件并发多路调用本接口,单文件失败只重传它自己,不再连累整批。
  app.post('/api/upload/file', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = (request.query || {}) as any;
    if (!ssh.connected) return reply.code(400).send({ error: 'SSH 未连接' });
    const base = normalizeRemote(q.dir || ssh.workspace || '');
    if (!base) return reply.code(400).send({ error: '请先选择远程工作区' });
    const rel = normalizeRelPath(String(q.rel || ''));
    if (!rel) return reply.code(400).send({ error: '路径非法(不允许 ../ 或绝对路径)' });
    const expect = Number(q.size); // 前端声明的文件大小;缺失(NaN)则跳过校验
    const target = joinRemote(base, rel);
    const tmp = joinRemote(remoteDirname(target), `.${remoteBase(target)}.part-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
    // 只把「请求体没读完就断了」当作取消。不能只看 'close':请求体**正常读完**时 Node 同样会触发
    // 'close'(此时 request.raw.complete === true)。按'close'判取消,就会把"数据收完了、还在落最后几个包"
    // 误判成用户取消 —— 现象正是本函数以前那种「文件已经出现在服务器上,却报上传失败」。
    const signal = { aborted: false };
    const onAbort = () => { if (!request.raw.complete) signal.aborted = true; };
    request.raw.on('aborted', onAbort);
    request.raw.on('close', onAbort);
    try {
      const written = await ssh.writeRemoteStream(tmp, request.raw, { signal });
      if (Number.isFinite(expect) && expect >= 0 && written !== expect) {
        throw new Error(`收到的字节数(${written})与文件大小(${expect})不一致`);
      }
      await ssh.replaceByRename(tmp, target); // 原子改名:目标名只在完整时才出现
      return { rel, size: written };
    } catch (e: any) {
      await ssh.unlinkQuiet(tmp);
      return reply.code(500).send({ error: e?.message || String(e) });
    } finally {
      request.raw.off('aborted', onAbort);
      request.raw.off('close', onAbort);
    }
  });


  // 上传文件/文件夹到远程目录(multipart,字段名 files;文件 originalname 为相对路径)
  // dir 查询参数指定目标目录(默认工作区),越权防护(../、绝对路径)在 normalizeRelPath 里
  // 流程:预建目录(去重按深度排) → 并发多路 SFTP 写入(每完成一个流式回报进度包) → 最终 JSON
  // 校验与 mkdirp 都发生在 hijack 之前,保证 400/500 走正常 Fastify 响应;
  // 确认无误后 hijack,以 NDJSON 流式回报进度(与原 Express 行为一致)。
  app.use('/api/upload', upload.array('files', 10000) as any);
  app.post('/api/upload', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ssh.connected) return reply.code(400).send({ error: 'SSH 未连接' });
    const base = normalizeRemote((request.query as any)?.dir || ssh.workspace || '');
    if (!base) return reply.code(400).send({ error: '请先选择远程工作区' });
    const files = (request.raw as any).files || [];
    if (files.length === 0) return reply.code(400).send({ error: '没有收到文件' });
    // 1) 一次性预建所有目标目录:去重后按深度从小到大排,避免每个文件重复逐级探测父目录
    const lineups: Array<{ rel: string; buf: Buffer }> = [];
    const dirs = new Set<string>();
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
    } catch (e: any) { return reply.code(500).send({ error: e.message }); }

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
        } catch (e: any) { errors.push(`${item.rel}: ${e.message}`); }
        pushProgress();
      }
    };
    try {
      await Promise.all([...Array(Math.min(CONCURRENCY, total))].map(() => worker()));
      // header 已被进度包发出,不能再用 res.json;以 NDJSON 行收尾,前端解析最后一行为结果
      res.write(JSON.stringify({ type: 'done', uploaded, failed: errors.length, bytes, errors: errors.slice(0, 20), dir: base }) + '\n');
      res.end();
    } catch (e: any) {
      try { res.write(JSON.stringify({ error: e.message }) + '\n'); } catch {}
      try { res.end(); } catch {}
    }
  });

  // 从远程工作区下载文件(SFTP 流式)
  app.get('/api/download', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      if (!ssh.connected) return reply.code(400).send('SSH 未连接');
      const p = String((request.query as any).path || '');
      const st = await ssh.stat(p);
      if (!st) return reply.code(404).send('文件不存在');
      if (st.isDirectory()) return reply.code(400).send('是目录,请选择文件');
      const name = p.split('/').filter(Boolean).pop() || 'download';
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      return ssh.sftp!.createReadStream(p);
    } catch (e: any) { return reply.code(500).send(e.message); }
  });

  // 从远程下载目录/文件/多项选中:流式打包成 tar.gz(不落盘,递归包含子目录)
  // 支持重复 path 参数;多个路径统一打包到 download/ 下(同名自动加序号)
  app.get('/api/downloaddir', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      if (!ssh.connected) return reply.code(400).send('SSH 未连接');
      const raws = (request.query as any)?.path;
      const paths = (Array.isArray(raws) ? raws : [raws]).map((p) => normalizeRemote(String(p || ''))).filter(Boolean);
      if (paths.length === 0) return reply.code(400).send('缺少 path');
      for (const abs of paths) {
        const st = await ssh.stat(abs);
        if (!st) return reply.code(404).send(`路径不存在: ${abs}`);
      }
      const multi = paths.length > 1;
      const used = new Set();
      const relFor = (abs: string) => {
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
      const write = (buf: Buffer) => new Promise<void>((resolve, reject) => {
        if (gzip.write(buf)) resolve();
        else { gzip.once('drain', resolve); gzip.once('error', reject); }
      });
      // 异步把 tar 条目写进 gzip;处理器立即返回 gzip,由 Fastify 接管管道(流式送达客户端)
      streamTarToGzip(gzip, roots, write).catch((e) => { try { gzip.destroy(); } catch {} });
      return gzip;
    } catch (e: any) { return reply.code(500).send(e.message); }
  });
}
