import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import App from './App';
import { ApiError } from './api/fetchJson';

const theme = createTheme({
  palette: { mode: 'dark', background: { default: '#1a1d21', paper: '#23272e' } },
});

// 재시도 정책 — 무거운 분석 API 는 타임아웃이 길어(30~60s) 기본 retry(3회)면
// 장애 시 사용자가 분 단위로 대기한다. 4xx/HTTP 오류는 재시도해도 같으므로
// 즉시 실패시키고, 일시적(네트워크/터널/524)만 1회 재시도한다.
const qc = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError) {
          if (error.kind === 'http') return false; // 4xx/5xx 응답 — 재시도 무의미
          return failureCount < 1; // network/tunnel_timeout/disconnected — 1회만
        }
        return failureCount < 1;
      },
      staleTime: 30_000,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <App />
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
