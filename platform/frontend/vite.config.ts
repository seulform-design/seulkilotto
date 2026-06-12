import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    // 청크 크기 경고 임계값 (KB). 차트 라이브러리가 커서 디폴트 500 KB 는 노이즈.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // 벤더 청크 수동 분리 — 라이브러리는 캐시 친화적으로 별도 청크.
        // 페이지 변경 시 벤더 청크는 재다운로드 안 됨.
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          mui: ['@mui/material', '@emotion/react', '@emotion/styled'],
          charts: ['echarts', 'echarts-for-react', 'recharts'],
          query: ['@tanstack/react-query'],
        },
      },
    },
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
