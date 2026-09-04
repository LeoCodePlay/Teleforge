// 媒体预览插件:/api/media — 图片/视频/音频/PDF 的内联字节流
// 远程文件走 SFTP 流,本机文件走 fs 流;按扩展名返回正确 Content-Type,
// 支持 Range 请求(视频/音频拖动进度条必需);download=1 时改为附件下载
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sshManager as ssh } from '../../core/ssh-manager.ts';

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
  pdf: 'application/pdf'
};

export function mediaMime(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return MIME[ext] || null;
}

export default async function registerMedia(app: FastifyInstance) {
  app.get('/api/media', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = (request.query || {}) as any;
    const p = String(q.path || '');
    const isLocal = q.local === '1' || q.local === 'true';
    if (!p) return reply.code(400).send('缺少 path');
    const mime = mediaMime(p);
    if (!mime) return reply.code(400).send('不支持的媒体格式');
    try {
      let size: number;
      let open: (o: { start: number; end: number }) => NodeJS.ReadableStream;
      if (isLocal) {
        const st = await fsp.stat(p);
        if (!st.isFile()) return reply.code(400).send('不是文件');
        size = st.size;
        open = (o) => fs.createReadStream(p, o);
      } else {
        if (!ssh.connected) return reply.code(400).send('SSH 未连接');
        const st = await ssh.stat(p);
        if (!st) return reply.code(404).send('文件不存在');
        if (st.isDirectory()) return reply.code(400).send('是目录');
        size = Number(st.size) || 0;
        open = (o) => ssh.sftp!.createReadStream(p, o);
      }
      // Range:浏览器首次请求常带 bytes=0-,拖动进度条时带任意区间;越界按 416 拒绝
      let start = 0, end = Math.max(0, size - 1), code = 200;
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range || ''));
      if (m && size > 0) {
        if (m[1]) start = Number(m[1]);
        if (m[2]) end = Number(m[2]);
        if (!m[2] || end >= size) end = size - 1;
        if (start > end || start >= size) return reply.code(416).send('Range 越界');
        code = 206;
      }
      const name = p.split(/[\\/]/).filter(Boolean).pop() || 'file';
      reply.code(code);
      reply.header('Content-Type', mime);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Cache-Control', 'no-cache');
      if (code === 206) reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
      reply.header('Content-Length', Math.max(0, end - start + 1));
      reply.header('Content-Disposition', `${q.download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`);
      return open({ start, end });
    } catch (e: any) { return reply.code(500).send(e.message); }
  });
}
