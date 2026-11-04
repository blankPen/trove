import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 前端产物落在 ../dist/public —— 根 package.json 的 files: ["dist"] 原样覆盖,
// npm 包自带界面。emptyOutDir 只清 dist/public,不碰 tsc 的产物。
export default defineConfig({
  root: '.',
  plugins: [react()],
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
