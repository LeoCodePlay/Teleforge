import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from '../package.json';

// 开发模式下代理到本地 Node 服务(server/index.js)
export default defineConfig({
  root: 'web',
  plugins: [react()],
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