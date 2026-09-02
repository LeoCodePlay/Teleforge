// 生产模式静态托管插件:托管前端构建产物 + SPA 回退(非 /api、/ws 的路径全部落到 index.html)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../../web/dist');

export default async function registerStatic(app: FastifyInstance) {
  if (!fs.existsSync(distDir)) return; // 未构建时跳过静态托管(与之前行为一致)

  await app.register(fastifyStatic, { root: distDir, index: false });

  // SPA 回退:静态文件未命中且不是 API/WS 路径时,回退到 index.html
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith('/api') || request.url.startsWith('/ws')) return reply.code(404).send();
    return reply.sendFile('index.html');
  });
}
