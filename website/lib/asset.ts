/**
 * 静态导出后站点可能被放在子路径下(例如 GitHub Pages 项目页 `/Teleforge/`)。
 * `next build` 会把 `NEXT_PUBLIC_*` 内联进产物,所以这个值在服务端与客户端组件里都可读。
 *
 * 注意:`basePath` 只会自动改写 Next 自己产出的资源(`/_next/**`、字体等),
 * JSX 里手写的 `/shots/x.webp` 这类绝对路径不会被改写,必须过一遍 `asset()`。
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

/** 把 public/ 下的绝对路径拼上部署子路径 */
export function asset(pathname: string): string {
  return `${BASE_PATH}${pathname}`;
}

/** 站点原始地址(GitHub Pages 上是 https://<owner>.github.io) */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3100';

/** 站点完整前缀 = 原始地址 + 子路径 */
export const SITE_ORIGIN = `${SITE_URL}${BASE_PATH}`;
