import type { NextConfig } from 'next';

/**
 * 官网只做站点,与桌面端(Tauri)完全无关:
 * - 桌面端打包只取 src-tauri/resources(见 scripts/build.mjs),不会碰 website/
 * - 根 tsconfig 的 include 只覆盖 web/src,这里的 TS 代码不参与根仓库 typecheck
 *
 * 部署目标:GitHub Pages 只能托管静态文件,所以这里用 `output: 'export'`
 * 让 `next build` 直接把整站预渲染成 out/ 下的 HTML。
 * 站点本身没有任何动态数据,预渲染产物就是完整内容(关掉 JS 也能读到全部文案)。
 *
 * 项目页(https://<owner>.github.io/<repo>/)需要在构建时注入子路径:
 * 工作流会把 NEXT_PUBLIC_BASE_PATH=/<repo> 传进来;用户页(<owner>.github.io)则为空。
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'export',
  basePath,
  // 目录式 URL:Pages 上是 /<repo>/index.html,少一层路径猜测
  trailingSlash: true,
  // 静态导出不能走 next/image 的按需优化
  images: { unoptimized: true },
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
