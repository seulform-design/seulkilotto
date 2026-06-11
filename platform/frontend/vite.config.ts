import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 5173,
    proxy: {
      // v1 일반 앱 API (더 구체적인 경로를 먼저 매칭)
      '/api/v1': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      // v2 연구 플랫폼 API
      '/api': { target: 'http://127.0.0.1:8100', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:8100', changeOrigin: true },
    },
  },
});
