import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── 모드 파싱 ───────────────────────────────────────────────
function parseMode(argv) {
  const modeIdx = argv.indexOf('--mode');
  if (modeIdx >= 0 && argv[modeIdx + 1]) {
    const m = argv[modeIdx + 1].toLowerCase();
    if (['local', 'tunnel', 'prod'].includes(m)) return m;
  }
  // 하위 호환: --tunnel 단독 사용을 'tunnel' 모드로 매핑
  if (argv.includes('--tunnel')) return 'tunnel';
  return 'local';
}

const MODE = parseMode(process.argv);
const TUNNEL_URL_FILE = path.join(__dirname, '.tunnel-url');

// ── 환경파일 로드: 모드별 우선순위 적용 ─────────────────────
function loadEnvFile(envPath) {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

// 우선순위: process.env > .env.local > .env.<mode> > .env > backend/.env
// loadEnvFile 는 'do not overwrite existing' 정책이므로 위에서부터 호출하면 위 항목이 우선.
loadEnvFile(path.join(ROOT, '.env.local'));
loadEnvFile(path.join(ROOT, `.env.${MODE}`));
loadEnvFile(path.join(ROOT, '.env'));
loadEnvFile(path.join(ROOT, 'backend', '.env'));

console.log(`[mode] ${MODE}`);

// ── 자식 프로세스 관리 ──────────────────────────────────────
const python = process.platform === 'win32' ? 'python' : 'python3';
const children = [];
let shuttingDown = false;

function run(cmd, args, cwd, label) {
  const child = spawn(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });
  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0 && code !== null) {
      console.error(`[${label}] exited with code ${code}`);
    }
  });
  children.push({ child, label });
  return child;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[shutdown] terminating children...');
  for (const { child, label } of children) {
    try {
      child.kill();
      console.log(`  - ${label} (pid ${child.pid}) killed`);
    } catch {
      /* ignore */
    }
  }
  try {
    if (existsSync(TUNNEL_URL_FILE)) unlinkSync(TUNNEL_URL_FILE);
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 250);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught:', err);
  shutdown();
});

// ── 사전 점검 ───────────────────────────────────────────────
const dist = path.join(ROOT, 'platform', 'frontend', 'dist');
if (!existsSync(dist)) {
  console.error('프론트 빌드가 없습니다. 먼저 실행: cd platform/frontend && npm run build');
  process.exit(1);
}

function freePort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split('\n')) {
        if (!line.includes('LISTENING')) continue;
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid)) pids.add(pid);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
          console.log(`[kill] port ${port} pid ${pid}`);
        } catch {
          /* ignore */
        }
      }
    } else {
      execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' });
    }
  } catch {
    /* port already free */
  }
}

function waitForHealth(url, label, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          console.log(`[ready] ${label}`);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error(`${label} health timeout`));
        } else {
          setTimeout(tick, 500);
        }
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`${label} health timeout`));
        } else {
          setTimeout(tick, 500);
        }
      });
    };
    tick();
  });
}

// ── 부팅 ────────────────────────────────────────────────────
for (const port of [8000, 8100, 4173]) freePort(port);

console.log('[start] v1 API :8000');
run(
  python,
  ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'],
  path.join(ROOT, 'backend'),
  'v1'
);

console.log('[start] v2 API :8100');
run(
  python,
  ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8100'],
  path.join(ROOT, 'platform', 'backend'),
  'v2'
);

// ── 터널 URL 자동 추출 ──────────────────────────────────────
const TUNNEL_URL_REGEX = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i;
let tunnelUrlReported = false;

function reportTunnelUrl(url) {
  if (tunnelUrlReported) return;
  tunnelUrlReported = true;
  try {
    writeFileSync(TUNNEL_URL_FILE, `${url}\n`, 'utf8');
  } catch (err) {
    console.error('[tunnel] failed to write url file:', err.message);
  }
  const box = '═'.repeat(url.length + 4);
  console.log(`\n╔${box}╗`);
  console.log(`║  ${url}  ║`);
  console.log(`╚${box}╝`);
  console.log(`[tunnel] url saved to ${TUNNEL_URL_FILE}\n`);
}

function startTunnel() {
  console.log('[tunnel] Cloudflare Quick Tunnel 시작...');
  const cf = spawn(
    'npx',
    [
      '--yes',
      'cloudflared',
      'tunnel',
      '--url',
      `http://localhost:${process.env.PORT || 4173}`,
      '--no-autoupdate',
    ],
    {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      env: process.env,
    }
  );
  const handle = (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    const m = text.match(TUNNEL_URL_REGEX);
    if (m) reportTunnelUrl(m[1]);
  };
  cf.stdout.on('data', handle);
  cf.stderr.on('data', handle);
  cf.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[tunnel] cloudflared exited with code ${code}`);
    }
  });
  children.push({ child: cf, label: 'tunnel' });
}

// ── 메인 시퀀스 ─────────────────────────────────────────────
(async () => {
  try {
    await Promise.all([
      waitForHealth('http://127.0.0.1:8000/health', 'v1'),
      waitForHealth('http://127.0.0.1:8100/health', 'v2'),
    ]);

    console.log('[start] gateway');
    run('node', ['prod-server.mjs'], __dirname, 'gateway');

    if (MODE === 'tunnel') {
      // 게이트웨이가 4173에 바인딩될 시간을 잠시 대기
      setTimeout(startTunnel, 1500);
    } else {
      console.log(`[ready] http://localhost:${process.env.PORT || 4173}`);
    }
  } catch (err) {
    console.error('[start] failed:', err.message);
    shutdown();
  }
})();
