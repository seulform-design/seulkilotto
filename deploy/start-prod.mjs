import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const withTunnel = process.argv.includes('--tunnel');

const python = process.platform === 'win32' ? 'python' : 'python3';
const children = [];

function run(cmd, args, cwd, label) {
  const child = spawn(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[${label}] exited with code ${code}`);
    }
  });
  children.push(child);
  return child;
}

function shutdown() {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const dist = path.join(ROOT, 'platform', 'frontend', 'dist');
if (!existsSync(dist)) {
  console.error('프론트 빌드가 없습니다. 먼저 실행: cd platform/frontend && npm run build');
  process.exit(1);
}

console.log('[start] v1 API :8000');
run(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'], path.join(ROOT, 'backend'), 'v1');

console.log('[start] v2 API :8100');
run(
  python,
  ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8100'],
  path.join(ROOT, 'platform', 'backend'),
  'v2'
);

setTimeout(() => {
  console.log('[start] gateway');
  run('node', ['prod-server.mjs'], __dirname, 'gateway');

  if (withTunnel) {
    setTimeout(() => {
      const port = Number(process.env.PORT || 4173);
      console.log('[tunnel] Cloudflare Quick Tunnel 시작...');
      const cf = spawn(
        'npx',
        ['--yes', 'cloudflared', 'tunnel', '--url', `http://localhost:${port}`],
        { cwd: __dirname, stdio: 'inherit', shell: true, env: process.env }
      );
      children.push(cf);
    }, 2000);
  }
}, 2500);
