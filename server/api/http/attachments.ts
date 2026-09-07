// 聊天附件 HTTP 插件:
// - POST /api/attachments  multipart 上传(字段 files,可多选),返回服务端权威元数据数组
// - GET  /api/attachments/:id  内联字节流(消息缩略图/预览用),支持 Range(视频拖动进度条)
// 与 transfer.ts 同款模式:middie + 空 multipart 解析器,multer 全权接管请求体
import multer from 'multer';
import middie from '@fastify/middie';
import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { saveAttachment, getAttachment, attachmentPath, type AttachmentMeta } from '../../store/attachments-store.ts';

// 单文件上限 100MB(视频),一次最多 10 个
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 10 }
});

// 图片单独收紧:过大的图片既拖垮上下文也容易被提供方拒绝
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function publicMeta(m: AttachmentMeta) {
  return { id: m.id, name: m.name, mime: m.mime, size: m.size, kind: m.kind, url: `/api/attachments/${m.id}` };
}

// multer 1.x 按 latin1 解码 multipart 文件名,中文/非 ASCII 名会乱码;
// busboy 收到的原始字节是 UTF-8,这里还原(与浏览器 FormData 发送行为一致)
function fixName(name: unknown): string {
  const s = String(name || '');
  try { return Buffer.from(s, 'latin1').toString('utf8'); } catch { return s; }
}

export default async function registerAttachments(app: FastifyInstance) {
  await app.register(middie);
  app.addContentTypeParser('multipart/form-data', (_req: any, _payload: any, done: (e?: any) => void) => done(null));
  app.use('/api/attachments', upload.array('files', 10) as any);

  app.post('/api/attachments', async (request: FastifyRequest, reply: FastifyReply) => {
    const files = (request.raw as any).files || [];
    if (files.length === 0) return reply.code(400).send({ error: '没有收到文件' });
    const saved: AttachmentMeta[] = [];
    for (const f of files) {
      if (!f.buffer || !f.buffer.length) continue;
      const name = fixName(f.originalname);
      const kind = String(f.mimetype || '').toLowerCase().startsWith('image/') ? 'image' : 'other';
      if (kind === 'image' && f.buffer.length > MAX_IMAGE_BYTES) {
        return reply.code(400).send({ error: `图片 ${name} 超过 20MB,请压缩后再发送` });
      }
      saved.push(await saveAttachment(f.buffer, name, f.mimetype));
    }
    if (saved.length === 0) return reply.code(400).send({ error: '没有收到有效文件' });
    return { attachments: saved.map(publicMeta) };
  });

  app.get('/api/attachments/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = String((request.params as any)?.id || '');
    // id 由服务端生成(att_<base36>),白名单校验同时阻断路径注入
    if (!/^att_[a-z0-9]+$/.test(id)) return reply.code(400).send('附件 id 非法');
    const meta = getAttachment(id);
    if (!meta) return reply.code(404).send('附件不存在');
    const p = attachmentPath(id);
    if (!p || !fs.existsSync(p)) return reply.code(404).send('附件文件缺失');
    const size = fs.statSync(p).size;
    // Range:视频/音频拖动进度条必需;越界按 416 拒绝
    let start = 0, end = Math.max(0, size - 1), code = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range || ''));
    if (m && size > 0) {
      if (m[1]) start = Number(m[1]);
      if (m[2]) end = Number(m[2]);
      if (!m[2] || end >= size) end = size - 1;
      if (start > end || start >= size) return reply.code(416).send('Range 越界');
      code = 206;
    }
    reply.code(code);
    reply.header('Content-Type', meta.mime || 'application/octet-stream');
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'private, max-age=86400'); // 内容不可变(id 寻址),允许缓存
    if (code === 206) reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
    reply.header('Content-Length', Math.max(0, end - start + 1));
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
    return fs.createReadStream(p, { start, end });
  });
}
