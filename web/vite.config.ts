import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json';

// ---- dsh 右侧栏源码搬运(web/src/dsh/)的别名 ----
// 从 deepseek-harness 复制过来的源码内部用 `@deepseek-ai/dsh-*` 互相引用。这里把包名
// 指向复制进来的目录,让**搬运源码保持原样**(一行 import 都不改)。注意:xcopy 复制后
// 每个 `web/src/dsh/<包名>/` 里放的就是该包原来的 `src/` 内容(铺平了一层)。
// Vite 的字符串别名按「精确匹配或 / 前缀」生效,所以 `pkg/client` 这类子路径一并命中。
//
// dsh 专有的那些包(cordis / slots / store / locale / shortcuts / session / brand)指向
// `web/src/dsh-adapters/`,由适配层用 Teleforge 的机制实现(见该目录各文件顶部说明)。
const dsh = (rel: string) => fileURLToPath(new URL(`./src/dsh/${rel}`, import.meta.url));
const adapter = (rel: string) => fileURLToPath(new URL(`./src/dsh-adapters/${rel}`, import.meta.url));

const DSH_ALIAS: { find: string; replacement: string }[] = [
  // 搬运的 dsh 原件
  { find: '@deepseek-ai/dsh-client-ui-dockkit', replacement: dsh('ui-dockkit') },
  { find: '@deepseek-ai/dsh-client-ui-sidebar-right', replacement: dsh('ui-sidebar-right') },
  { find: '@deepseek-ai/dsh-client-ui-sidebar-files', replacement: dsh('ui-sidebar-files') },
  { find: '@deepseek-ai/dsh-client-ui-sidebar-terminal', replacement: dsh('ui-sidebar-terminal') },
  { find: '@deepseek-ai/dsh-client-ui-sidebar-browser', replacement: dsh('ui-sidebar-browser') },
  { find: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview', replacement: dsh('ui-sidebar-documentpreview') },
  { find: '@deepseek-ai/dsh-client-ui-deliverables', replacement: dsh('ui-deliverables') },
  { find: '@deepseek-ai/dsh-workspace-changes', replacement: dsh('ui-deliverables') },
  // primitives 走「按需桶」:只导出侧栏用得到的原件,避免把 markdown/office 依赖链拉进来
  { find: '@deepseek-ai/dsh-client-ui-primitives', replacement: adapter('primitives/index.tsx') },
  // 适配层实现的 dsh 专有包
  { find: '@deepseek-ai/dsh-brand', replacement: adapter('brand/index.ts') },
  { find: '@deepseek-ai/dsh-client-ui-slots', replacement: dsh('client-ui-slots/src/index.ts') },
  { find: '@deepseek-ai/dsh-client-store', replacement: dsh('client-store/src/index.ts') },
  { find: '@deepseek-ai/dsh-client-locale', replacement: adapter('locale/index.ts') },
  { find: '@deepseek-ai/dsh-client-shortcuts', replacement: adapter('shortcuts/index.ts') },
  { find: '@deepseek-ai/dsh-session', replacement: adapter('session/index.ts') },
  { find: '@deepseek-ai/dsh-typert-protocol', replacement: dsh('typert-protocol/src/index.ts') },
  { find: '@deepseek-ai/dsh-util-workspace-path', replacement: dsh('util-workspace-path/src/index.ts') },
  // 这两个包按**构建产物**消费:类型走 lib/types/*.d.ts,运行时走 lib/*.js。
  // 原因:它们的 TS 源码是按 dsh 自己的基础配置写的,进不了本项目的严格编译程序
  // (cordis 源码在本项目选项下 45 个错)。dsh 自己的 exports 也正是这么声明的。
  { find: '@deepseek-ai/cordis', replacement: dsh('cordis/lib/index.js') },
  { find: '@deepseek-ai/cosmokit', replacement: dsh('cosmokit/lib/index.js') }
];

export default defineConfig({
  root: 'web',
  plugins: [react()],
  resolve: { alias: DSH_ALIAS },
  // 注入当前版本号:前端「关于与更新」面板展示 / 与桌面端 Rust 返回的版本号一致
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  server: {
    // 固定 IPv4 回环:Windows 下 WebView2 解析 localhost 可能取 IPv6(::1),
    // 与 vite 绑定的 127.0.0.1 不一致会导致 Tauri dev 窗口黑屏
    host: '127.0.0.1',
    port: 5173,
    strictPort: true, // 端口占用时报错而非换端口,避免与 tauri.conf.json 的 devUrl 失配
    proxy: {
      '/ws/browser': { target: 'ws://127.0.0.1:4000', ws: true },
      '/ws/term': { target: 'ws://127.0.0.1:4000', ws: true },
      '/ws': { target: 'ws://127.0.0.1:4000', ws: true },
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: false }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
