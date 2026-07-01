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

// ── 캔버스 / 레이아웃 상수 (실제 방송 추첨기 배치) ──────────────────
const W = 340;
const H = 480;
const CX = 170;
const CY = 240; // 유리 구 중심
const R = 112; // 유리 구 반지름
const CAP_Y = CY - R; // 구 상단 배출구 y
const RAIL_Y = 46; // 상단 레일(추첨된 볼 정렬)
const SLOT_X0 = 32;
const SLOT_GAP = (W - 2 * SLOT_X0) / 6;
const BAR_Y = 442; // 하단 결과 바 중심
const BR = 12; // 볼 반지름

const GRAVITY = 0.28;
const DAMP = 0.992;
const MAX_V = 7.5;

type BallState = 'mix' | 'rising' | 'racked';
interface Ball {
  n: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: BallState;
  slot: number; // 추첨 순번(-1=미추첨)
  path: { x: number; y: number }[];
  wp: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

function slotX(i: number) {
  return SLOT_X0 + i * SLOT_GAP;
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
      slot: -1,
      path: [],
      wp: 0,
    });
  }
  return balls;
}

function drawBall(ctx: CanvasRenderingContext2D, x: number, y: number, n: number, r = BR) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = ballColor(n);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x - r * 0.32, y - r * 0.32, r * 0.34, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fill();
  ctx.fillStyle = '#1a1a1a';
  ctx.font = `bold ${Math.round(r * 0.92)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), x, y + 0.5);
}

export default function MachineDrawSimulator() {
  const [machine, setMachine] = useState<1 | 2 | 3>(3);
  const [drawing, setDrawing] = useState(false);
  const [result, setResult] = useState<MachineDrawResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ballsRef = useRef<Ball[]>(initBalls());
  const airRef = useRef(0.06);
  const rafRef = useRef<number>(0);
  const busyRef = useRef(false);
  const accentRef = useRef(MACHINE_ACCENT[3]);
  accentRef.current = MACHINE_ACCENT[machine];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const step = () => {
      const balls = ballsRef.current;
      const air = airRef.current;

      // ── 물리 ──
      for (const b of balls) {
        if (b.state === 'mix') {
          b.vy += GRAVITY;
          b.vy -= Math.random() * air; // 공기 송풍(위로)
          b.vx += (Math.random() - 0.5) * air * 1.6; // 좌우 난류
          b.vx *= DAMP;
          b.vy *= DAMP;
          const sp = Math.hypot(b.vx, b.vy);
          if (sp > MAX_V) {
            b.vx = (b.vx / sp) * MAX_V;
            b.vy = (b.vy / sp) * MAX_V;
          }
          b.x += b.vx;
          b.y += b.vy;
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
            const spd = 5.4;
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

      // ── 볼-볼 충돌 (구 안에서) ──
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
            const ov = (min - d) / 2;
            a.x -= nx * ov;
            a.y -= ny * ov;
            c.x += nx * ov;
            c.y += ny * ov;
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

      // 하단 결과 바 (제○회 스타일)
      const barGrad = ctx.createLinearGradient(0, BAR_Y - 22, 0, BAR_Y + 22);
      barGrad.addColorStop(0, '#0f2038');
      barGrad.addColorStop(1, '#0a1526');
      ctx.fillStyle = barGrad;
      roundRect(ctx, 8, BAR_Y - 24, W - 16, 48, 12);
      ctx.fill();
      ctx.strokeStyle = `${accent}66`;
      ctx.stroke();
      for (let i = 0; i < 7; i += 1) {
        const x = slotX(i);
        const isBonus = i === 6;
        const filled = balls.find((b) => b.slot === i && b.state === 'racked');
        ctx.beginPath();
        ctx.arc(x, BAR_Y, BR + 2, 0, Math.PI * 2);
        if (filled) {
          ctx.fillStyle = ballColor(filled.n);
          ctx.fill();
          ctx.fillStyle = '#1a1a1a';
          ctx.font = 'bold 13px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(filled.n), x, BAR_Y + 0.5);
        } else {
          ctx.fillStyle = isBonus ? 'rgba(80,140,255,0.25)' : 'rgba(255,255,255,0.12)';
          ctx.fill();
        }
        ctx.strokeStyle = isBonus ? '#4f8cff' : 'rgba(255,255,255,0.35)';
        ctx.lineWidth = isBonus ? 2 : 1;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      // 보너스 '+' 표시
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('+', slotX(6) - BR - 8, BAR_Y + 5);

      // 상단 레일 가이드
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.moveTo(SLOT_X0 - 4, RAIL_Y + BR + 5);
      ctx.lineTo(W - SLOT_X0 + 4, RAIL_Y + BR + 5);
      ctx.stroke();

      // 구 상단 금속 캡 + 배출관
      ctx.fillStyle = '#c9d3dd';
      roundRect(ctx, CX - 20, CAP_Y - 20, 40, 26, 6);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(CX - BR - 2, RAIL_Y, (BR + 2) * 2, CAP_Y - RAIL_Y);
      ctx.strokeStyle = `${accent}44`;
      ctx.strokeRect(CX - BR - 2, RAIL_Y, (BR + 2) * 2, CAP_Y - RAIL_Y);

      // 유리 구 본체
      const g = ctx.createRadialGradient(CX - 42, CY - 48, 16, CX, CY, R);
      g.addColorStop(0, 'rgba(255,255,255,0.22)');
      g.addColorStop(0.7, 'rgba(120,150,190,0.14)');
      g.addColorStop(1, 'rgba(15,25,45,0.5)');
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();

      // 볼 (구 안 + 상승 중 + 레일)
      for (const b of balls) drawBall(ctx, b.x, b.y, b.n);

      // 유리 테두리(금속 링) + 하이라이트
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, Math.PI * 2);
      ctx.lineWidth = 5;
      const rim = ctx.createLinearGradient(CX - R, CY - R, CX + R, CY + R);
      rim.addColorStop(0, '#eef3f8');
      rim.addColorStop(0.5, accent);
      rim.addColorStop(1, '#8894a4');
      ctx.strokeStyle = rim;
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(CX - 40, CY - 52, 34, 20, -0.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.fill();

      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const draw = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setDrawing(true);
    setResult(null);
    setError(null);
    ballsRef.current = initBalls();
    airRef.current = 0.92; // 송풍 강화
    try {
      const seed = Math.floor(Math.random() * 1_000_000_000);
      await sleep(1900); // 공기 혼합 연출
      const data = await v1Api.getMachineDraw(machine, seed);
      const order = [...data.draw_order, data.bonus];
      for (let i = 0; i < order.length; i += 1) {
        await sleep(1200);
        const b = ballsRef.current.find((x) => x.n === order[i] && x.state === 'mix');
        if (b) {
          b.state = 'rising';
          b.slot = i;
          b.path = [
            { x: CX, y: CAP_Y - 6 }, // 구 상단 배출구
            { x: CX, y: RAIL_Y }, // 관 상단
            { x: slotX(i), y: RAIL_Y }, // 상단 레일 슬롯
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
        🎰 {machine}호기 추첨기 (실제 방송 방식)
      </Typography>
      <Typography variant="caption" sx={{ color: '#cbd5e1', display: 'block', mb: 1.5 }}>
        실제 로또 추첨기와 동일 — 유리 구 안 45개 볼을 공기로 섞어 상단으로 하나씩 추첨.
        각 호기의 실제 데이터 특성(번호 출현 성향)을 반영합니다.
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
              ballsRef.current = initBalls();
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

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
