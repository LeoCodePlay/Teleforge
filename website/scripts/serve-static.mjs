/**
 * 纯静态预览服务器:把 `next build` 产出的 out/ 按 GitHub Pages 的方式发出去。
 * 目的不是"再写一个服务器",而是能在本地完整复现 Pages 的部署形态:
 *   - 站点挂在子路径下(默认 /Teleforge,与项目页一致)
 *   - 未知路径回退到 404.html(与 Pages 行为一致)
 *   - 不做任何 Jekyll 处理(public/.nojekyll 保证 _next/ 不被吞掉)
 *
 * 用法:
 *   NEXT_PUBLIC_BASE_PATH=/Teleforge npm run build
 *   NEXT_PUBLIC_BASE_PATH=/Teleforge npm start
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
const base = (process.env.NEXT_PUBLIC_BASE_PATH || '').replace(/\/$/, '');
const port = Number(process.env.PORT || 3100);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

if (!fs.existsSync(root)) {
  console.error(`out/ 不存在,先跑构建:NEXT_PUBLIC_BASE_PATH=${base} npm run build`);
  process.exit(1);
}

const send = (res, file, code = 200) => {
  const ext = path.extname(file).toLowerCase();
  res.writeHead(code, { 'content-type': TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
};

http
  .createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);

    if (base && !url.startsWith(base)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`路径不在站点前缀 ${base} 下`);
      return;
    }

    const rel = url.slice(base.length) || '/';
    let file = path.join(root, rel);
    // 目录 → index.html;再不行试 .html 后缀;都没有就回 404.html
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;

    if (!fs.existsSync(file)) {
      const fallback = path.join(root, '404.html');
      if (fs.existsSync(fallback)) return send(res, fallback, 404);
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    send(res, file);
  })
  .listen(port, () => {
    console.log(`静态预览: http://localhost:${port}${base}/  (产物目录 ${root})`);
  });
