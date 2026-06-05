import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 4173);
const DIST = path.join(ROOT, 'platform', 'frontend', 'dist');

const app = express();

app.use(
  '/api/v1',
  createProxyMiddleware({
    target: 'http://127.0.0.1:8000',
    changeOrigin: true,
    pathRewrite: (p) => `/api/v1${p}`,
  })
);
app.use(
  '/api',
  createProxyMiddleware({
    target: 'http://127.0.0.1:8100',
    changeOrigin: true,
    pathRewrite: (p) => `/api${p}`,
  })
);
app.use(
  '/health',
  createProxyMiddleware({
    target: 'http://127.0.0.1:8100',
    changeOrigin: true,
  })
);

app.use(express.static(DIST));
app.get('*', (_req, res) => {
  res.sendFile(path.join(DIST, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[gateway] http://0.0.0.0:${PORT}`);
});
