import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发模式下代理到本地 Node 服务(server/index.js)
export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: 5173,
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