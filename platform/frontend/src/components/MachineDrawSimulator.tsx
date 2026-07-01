import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { v1Api, type MachineDrawResult } from '../api/v1Api';

/** 로또 공식 볼 색상 (구간별). */
function ballColor(n: number): string {
  if (n <= 10) return '#FBC400';
  if (n <= 20) return '#69C8F2';
  if (n <= 30) return '#FF7272';
  if (n <= 40) return '#AAAAAA';
  return '#B0D840';
}

const MACHINE_ACCENT: Record<number, string> = {
  1: '#E8570D',
  2: '#0D8A3E',
  3: '#2952CC',
};

// ── 캔버스 / 물리 상수 ──────────────────────────────────────────────
const W = 340;
const H = 440;
const CX = 170;
const CY = 300;
const R = 125; // 챔버 반지름
const BR = 12; // 볼 반지름
const RACK_Y = 30;
const RACK_X0 = 30;
const RACK_GAP = (W - 2 * RACK_X0) / 6;
const TUBE_TOP = 66;

const GRAVITY = 0.28;
const DAMP = 0.992;
const MAX_V = 7;

type BallState = 'mix' | 'rising' | 'racked';
interface Ball {
  n: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: BallState;
  path: { x: number; y: number }[];
  wp: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

function slotPos(i: number) {
  return { x: RACK_X0 + i * RACK_GAP, y: RACK_Y };
}

function initBalls(): Ball[] {
  const balls: Ball[] = [];
  for (let n = 1; n <= 45; n += 1) {
    const ang = Math.random() * Math.PI * 2;
    const rr = Math.random() * (R - BR - 4);
    balls.push({
      n,
      x: CX + Math.cos(ang) * rr,
      y: CY + Math.sin(ang) * rr * 0.7,
      vx: rand(-2, 2),
      vy: rand(-2, 2),
      state: 'mix',
      path: [],
      wp: 0,
    });
  }
  return balls;
}

export default function MachineDrawSimulator() {
  const [machine, setMachine] = useState<1 | 2 | 3>(3);
  const [drawing, setDrawing] = useState(false);
  const [result, setResult] = useState<MachineDrawResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ballsRef = useRef<Ball[]>(initBalls());
  const airRef = useRef(0.06); // 공기 세기 — 평소엔 낮아 볼이 바닥에 가라앉음
  const rafRef = useRef<number>(0);
  const busyRef = useRef(false);
  const accentRef = useRef(MACHINE_ACCENT[3]);
  accentRef.current = MACHINE_ACCENT[machine];

  // ── 물리 + 렌더 루프 ──────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const step = () => {
      const balls = ballsRef.current;
      const air = airRef.current;

      // 물리 (섞이는 볼만)
      for (const b of balls) {
        if (b.state === 'mix') {
          b.vy += GRAVITY;
          // 공기 송풍: 위로 밀어올리고 좌우 난류
          b.vy -= Math.random() * air;
          b.vx += (Math.random() - 0.5) * air * 1.6;
          b.vx *= DAMP;
          b.vy *= DAMP;
          const sp = Math.hypot(b.vx, b.vy);
          if (sp > MAX_V) {
            b.vx = (b.vx / sp) * MAX_V;
            b.vy = (b.vy / sp) * MAX_V;
          }
          b.x += b.vx;
          b.y += b.vy;
          // 원형 벽 충돌
          const dx = b.x - CX;
          const dy = b.y - CY;
          const d = Math.hypot(dx, dy);
          const lim = R - BR;
          if (d > lim) {
            const nx = dx / d;
            const ny = dy / d;
            b.x = CX + nx * lim;
            b.y = CY + ny * lim;
            const dot = b.vx * nx + b.vy * ny;
            b.vx = (b.vx - 2 * dot * nx) * 0.72;
            b.vy = (b.vy - 2 * dot * ny) * 0.72;
          }
        } else if (b.state === 'rising') {
          const t = b.path[b.wp];
          if (t) {
            const dx = t.x - b.x;
            const dy = t.y - b.y;
            const d = Math.hypot(dx, dy) || 1;
            const spd = 5.2;
            b.x += (dx / d) * Math.min(spd, d);
            b.y += (dy / d) * Math.min(spd, d);
            if (d < 3) {
              b.wp += 1;
              if (b.wp >= b.path.length) b.state = 'racked';
            }
          } else {
            b.state = 'racked';
          }
        }
      }

      // 볼-볼 충돌 (섞이는 볼끼리)
      for (let i = 0; i < balls.length; i += 1) {
        const a = balls[i];
        if (a.state !== 'mix') continue;
        for (let j = i + 1; j < balls.length; j += 1) {
          const c = balls[j];
          if (c.state !== 'mix') continue;
          const dx = c.x - a.x;
          const dy = c.y - a.y;
          const d = Math.hypot(dx, dy);
          const min = BR * 2;
          if (d > 0 && d < min) {
            const nx = dx / d;
            const ny = dy / d;
            const overlap = (min - d) / 2;
            a.x -= nx * overlap;
            a.y -= ny * overlap;
            c.x += nx * overlap;
            c.y += ny * overlap;
            const va = a.vx * nx + a.vy * ny;
            const vc = c.vx * nx + c.vy * ny;
            const diff = vc - va;
            a.vx += diff * nx;
            a.vy += diff * ny;
            c.vx -= diff * nx;
            c.vy -= diff * ny;
          }
        }
      }

      // ── 렌더 ──
      const accent = accentRef.current;
      ctx.clearRect(0, 0, W, H);

      // 거치대(rack)
      for (let i = 0; i < 7; i += 1) {
        const p = slotPos(i);
        ctx.beginPath();
        ctx.arc(p.x, p.y, BR + 2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.stroke();
        if (i === 6) {
          ctx.fillStyle = 'rgba(255,255,255,0.4)';
          ctx.font = 'bold 12px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('+', p.x - BR - 10, p.y + 4);
        }
      }

      // 관(tube)
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(CX - BR - 3, TUBE_TOP, (BR + 3) * 2, CY - R - TUBE_TOP + 6);
      ctx.strokeStyle = `${accent}66`;
      ctx.strokeRect(CX - BR - 3, TUBE_TOP, (BR + 3) * 2, CY - R - TUBE_TOP + 6);

      // 챔버(유리)
      const grad = ctx.createRadialGradient(CX - 40, CY - 50, 20, CX, CY, R);
      grad.addColorStop(0, 'rgba(255,255,255,0.16)');
      grad.addColorStop(1, 'rgba(20,30,48,0.55)');
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = accent;
      ctx.stroke();
      ctx.lineWidth = 1;

      // 볼
      for (const b of balls) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, BR, 0, Math.PI * 2);
        ctx.fillStyle = ballColor(b.n);
        ctx.fill();
        // 하이라이트
        ctx.beginPath();
        ctx.arc(b.x - 4, b.y - 4, BR * 0.35, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fill();
        ctx.fillStyle = '#1a1a1a';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(b.n), b.x, b.y + 0.5);
      }

      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── 추첨 실행 ────────────────────────────────────────────────────
  const draw = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setDrawing(true);
    setResult(null);
    setError(null);
    // 볼 리셋 (모두 챔버로)
    ballsRef.current = initBalls();
    airRef.current = 0.85; // 송풍 강화
    try {
      const seed = Math.floor(Math.random() * 1_000_000_000);
      await sleep(1800); // 공기 혼합 연출
      const data = await v1Api.getMachineDraw(machine, seed);
      const order = [...data.draw_order, data.bonus];
      for (let i = 0; i < order.length; i += 1) {
        await sleep(1250);
        const b = ballsRef.current.find((x) => x.n === order[i] && x.state === 'mix');
        if (b) {
          const slot = slotPos(i);
          b.state = 'rising';
          b.path = [
            { x: CX, y: CY - R + BR }, // 챔버 상단 출구
            { x: CX, y: TUBE_TOP + 10 }, // 관 상단
            { x: slot.x, y: slot.y }, // 거치대
          ];
          b.wp = 0;
        }
      }
      await sleep(900);
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '추첨 실패');
    } finally {
      airRef.current = 0.06;
      setDrawing(false);
      busyRef.current = false;
    }
  };

  const accent = MACHINE_ACCENT[machine];

  return (
    <Box
      sx={{
        p: 2,
        mb: 2,
        borderRadius: 2,
        background: `linear-gradient(160deg, ${accent}18, #0d1b2a 80%)`,
        border: `1px solid ${accent}55`,
      }}
    >
      <Typography variant="subtitle1" fontWeight={800} sx={{ color: '#fff', mb: 0.5 }}>
        🎰 {machine}호기 추첨기 (실제 공기순환식)
      </Typography>
      <Typography variant="caption" sx={{ color: '#cbd5e1', display: 'block', mb: 1.5 }}>
        실제 방송 추첨기 방식 — 45개 볼을 공기로 섞어 하나씩 추첨. 각 호기의 실제 데이터 특성(번호 출현 성향)을 반영합니다.
      </Typography>

      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={machine}
          onChange={(_, v) => {
            if (v && !drawing) {
              setMachine(v);
              setResult(null);
            }
          }}
        >
          {([1, 2, 3] as const).map((m) => (
            <ToggleButton
              key={m}
              value={m}
              sx={{
                color: '#cbd5e1',
                fontWeight: 800,
                '&.Mui-selected': {
                  bgcolor: MACHINE_ACCENT[m],
                  color: '#fff',
                  '&:hover': { bgcolor: MACHINE_ACCENT[m] },
                },
              }}
            >
              {m}호기
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Stack>

      <Box sx={{ display: 'flex', justifyContent: 'center', mb: 1.5 }}>
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          style={{ maxWidth: '100%', touchAction: 'none' }}
        />
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'center', mb: 1 }}>
        <Button
          variant="contained"
          onClick={draw}
          disabled={drawing}
          sx={{
            bgcolor: accent,
            fontWeight: 800,
            px: 4,
            '&:hover': { bgcolor: accent, filter: 'brightness(1.1)' },
          }}
        >
          {drawing ? '추첨 중…' : `${machine}호기 추첨 시작`}
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}

      {result && !drawing && (
        <Box sx={{ mt: 1.5 }}>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
            <Chip
              size="small"
              label={`정렬 ${result.numbers.join(', ')} + ${result.bonus}`}
              sx={{ bgcolor: '#ffffff', fontWeight: 700 }}
            />
            <Chip
              size="small"
              variant="outlined"
              label={`합 ${result.sum_total}`}
              sx={{ color: '#e2e8f0', borderColor: '#475569' }}
            />
            <Chip
              size="small"
              variant="outlined"
              label={`홀 ${result.odd_count}:${result.even_count} 짝`}
              sx={{ color: '#e2e8f0', borderColor: '#475569' }}
            />
          </Stack>
          <Typography variant="caption" sx={{ color: '#cbd5e1', display: 'block' }}>
            📊 {machine}호기 특성 — 실측 {result.draw_count}회 · 평균합 {result.avg_sum} ·
            평균 홀 {result.avg_odd} · 시그니처 번호 {result.signature_numbers.join(', ')}
          </Typography>
          <Typography
            variant="caption"
            sx={{ color: '#64748b', display: 'block', mt: 0.5, fontStyle: 'italic' }}
          >
            {result.disclaimer}
          </Typography>
        </Box>
      )}
    </Box>
  );
}
