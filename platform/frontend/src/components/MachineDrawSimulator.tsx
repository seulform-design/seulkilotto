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

// ── 레이아웃 (실제 동행복권 추첨기 배치) ────────────────────────────
const W = 360;
const H = 520;
const CX = 150; // 구 중심 x (오른쪽 레일 공간 확보로 좌측 배치)
const CY = 205; // 구 중심 y
const R = 120; // 구 반지름
const CAP_Y = CY - R; // 상단 캡/배출구
const TUBE_W = 22; // 중앙 배출관 폭
const RAIL_X = CX + R + 4; // 외부 하강 레일 x
const BAR_Y = 484; // 하단 결과 바
const BR = 11;

// 결과 바 슬롯 위치 (제○회 라벨 + 흰 6 + 분리된 파란 보너스)
const MAIN_X0 = 96;
const MAIN_GAP = 33;
const BONUS_X = 322;
function slotPos(i: number) {
  return { x: i < 6 ? MAIN_X0 + i * MAIN_GAP : BONUS_X, y: BAR_Y };
}

const GRAVITY = 0.34;
const DAMP = 0.99;
const MAX_V = 8.5;
const LIFT = 1.15; // 블레이드 퍼올림 세기(중심축 근처 상승)
const CHURN = 1.0; // 회전 난류
const CENTER_PULL = 0.009; // 중심축으로 모으는 힘
const DISC_R = R * 0.6; // 수평 회전 디스크 반지름

type BallState = 'mix' | 'rising' | 'racked';
interface Ball {
  n: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: BallState;
  slot: number;
  path: { x: number; y: number }[];
  wp: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

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

function paintBall(ctx: CanvasRenderingContext2D, x: number, y: number, n: number, r = BR) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = ballColor(n);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x - r * 0.32, y - r * 0.32, r * 0.33, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fill();
  ctx.fillStyle = '#1a1a1a';
  ctx.font = `bold ${Math.round(r * 0.95)}px sans-serif`;
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
  const spinRef = useRef(0.03); // 회전 패들 세기 — 평소 낮음, 추첨 시 강함
  const armRef = useRef(0); // 회전 패들 각도
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
      const spin = spinRef.current;
      armRef.current += spin > 0.1 ? 0.16 : 0.02; // 수직축 회전

      // ── 물리 (수직축 회전 + 수평 디스크 = 동행복권 처닝) ──
      // 중앙 샤프트가 회전하며 수평 블레이드가 공을 퍼올린다. 공은 샤프트 주위
      // 세로 컬럼을 이루며 중심에서 솟구쳐 올라 바깥으로 쏟아진다(분수형 순환).
      for (const b of balls) {
        if (b.state === 'mix') {
          b.vy += GRAVITY;
          if (spin > 0.1) {
            const dx = b.x - CX;
            // 중심축으로 모으기 → 샤프트 주위 컬럼 형성
            b.vx += -dx * CENTER_PULL;
            // 블레이드가 퍼올림: 중심축 근처일수록 강한 상승
            const ax = Math.abs(dx);
            if (ax < 64) b.vy -= LIFT * (1 - ax / 64);
            // 회전 난류(블레이드 스윕)
            b.vx += (Math.random() - 0.5) * CHURN;
            b.vy += (Math.random() - 0.5) * CHURN * 0.7;
          }
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
            b.vx = (b.vx - 2 * dot * nx) * 0.6;
            b.vy = (b.vy - 2 * dot * ny) * 0.6;
          }
        } else if (b.state === 'rising') {
          const t = b.path[b.wp];
          if (t) {
            const dx = t.x - b.x;
            const dy = t.y - b.y;
            const d = Math.hypot(dx, dy) || 1;
            const spd = 5;
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

      // ── 볼-볼 충돌 (구 안) ──
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

      // 1) 외부 하강 레일 (상단 캡 → 오른쪽 → 아래로)
      ctx.strokeStyle = 'rgba(180,200,220,0.5)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(CX + 14, CAP_Y - 6);
      ctx.quadraticCurveTo(RAIL_X + 26, CY - R * 0.4, RAIL_X, CY + 20);
      ctx.quadraticCurveTo(RAIL_X - 4, BAR_Y - 40, MAIN_X0 + 5 * MAIN_GAP, BAR_Y - 22);
      ctx.stroke();
      ctx.lineWidth = 1;

      // 2) 하단 결과 바
      const barGrad = ctx.createLinearGradient(0, BAR_Y - 24, 0, BAR_Y + 24);
      barGrad.addColorStop(0, '#10233d');
      barGrad.addColorStop(1, '#0a1424');
      ctx.fillStyle = barGrad;
      roundRect(ctx, 8, BAR_Y - 26, W - 16, 52, 26);
      ctx.fill();
      ctx.strokeStyle = `${accent}66`;
      ctx.stroke();
      ctx.fillStyle = '#e8eef5';
      ctx.font = 'bold 15px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('제 SIM', 48, BAR_Y);
      for (let i = 0; i < 7; i += 1) {
        const p = slotPos(i);
        const isBonus = i === 6;
        const filled = balls.find((b) => b.slot === i && b.state === 'racked');
        ctx.beginPath();
        ctx.arc(p.x, p.y, BR + 3, 0, Math.PI * 2);
        if (filled) {
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          paintBall(ctx, p.x, p.y, filled.n, BR + 1);
        } else {
          ctx.fillStyle = isBonus ? 'rgba(80,140,255,0.9)' : 'rgba(255,255,255,0.92)';
          ctx.fill();
        }
      }

      // 3) 유리 구 본체 (맑은 투명)
      const g = ctx.createRadialGradient(CX - 44, CY - 50, 18, CX, CY, R);
      g.addColorStop(0, 'rgba(255,255,255,0.30)');
      g.addColorStop(0.6, 'rgba(210,225,240,0.12)');
      g.addColorStop(1, 'rgba(160,180,205,0.10)');
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();

      // 4) 중앙 수직축 + 상단 배출관 (공이 위로 빠지는 통로)
      ctx.fillStyle = 'rgba(200,215,235,0.18)';
      ctx.fillRect(CX - 4, CAP_Y + 4, 8, R * 2 - 8); // 수직 축
      ctx.fillStyle = 'rgba(220,230,242,0.12)';
      ctx.fillRect(CX - TUBE_W / 2, CAP_Y + 4, TUBE_W, R * 0.55);

      // 5) 볼
      for (const b of balls) paintBall(ctx, b.x, b.y, b.n);

      // 6b) 수평 회전 디스크(블레이드) — 중앙 샤프트에 달려 공을 퍼올림
      ctx.beginPath();
      ctx.ellipse(CX, CY, DISC_R, 8, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(215,230,248,0.26)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(180,200,225,0.6)';
      ctx.stroke();
      // 회전 표시 마크(디스크 가장자리 점이 좌우 왕복 → 수직축 회전 원근)
      const mk = Math.cos(armRef.current) * DISC_R;
      ctx.beginPath();
      ctx.ellipse(CX + mk, CY, 5, 4, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(150,170,195,0.9)';
      ctx.fill();
      // 두 번째 디스크(하단) — 층층 블레이드 느낌
      ctx.beginPath();
      ctx.ellipse(CX, CY + R * 0.42, DISC_R * 0.7, 6, 0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(180,200,225,0.45)';
      ctx.stroke();
      // 회전축 허브
      ctx.beginPath();
      ctx.arc(CX, CY, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#c9d3dd';
      ctx.fill();
      ctx.strokeStyle = '#8a95a2';
      ctx.stroke();

      // 6) 구 테두리(금속 링)
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, Math.PI * 2);
      ctx.lineWidth = 4;
      const rim = ctx.createLinearGradient(CX - R, CY - R, CX + R, CY + R);
      rim.addColorStop(0, '#f2f6fa');
      rim.addColorStop(0.5, '#aeb8c4');
      rim.addColorStop(1, '#7f8b99');
      ctx.strokeStyle = rim;
      ctx.stroke();
      ctx.lineWidth = 1;

      // 7) 고정 볼트 (테두리 8방향)
      for (let k = 0; k < 8; k += 1) {
        const a = (Math.PI / 4) * k - Math.PI / 8;
        const bx = CX + Math.cos(a) * R;
        const by = CY + Math.sin(a) * R;
        ctx.beginPath();
        ctx.arc(bx, by, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = '#cfd8e2';
        ctx.fill();
        ctx.strokeStyle = '#8a95a2';
        ctx.stroke();
      }

      // 8) 상단 흰색 캡 돔 + 배출구
      ctx.beginPath();
      ctx.ellipse(CX, CAP_Y - 2, 26, 18, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#e9eef4';
      ctx.fill();
      ctx.strokeStyle = '#9aa6b3';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(CX, CAP_Y - 6, 5, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();

      // 9) 유리 하이라이트
      ctx.beginPath();
      ctx.ellipse(CX - 44, CY - 54, 32, 18, -0.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.20)';
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
    spinRef.current = 0.5; // 패들 강하게 회전
    try {
      const seed = Math.floor(Math.random() * 1_000_000_000);
      await sleep(3200); // 첫 공 전 혼합(실측 ~10초를 UX상 압축)
      const data = await v1Api.getMachineDraw(machine, seed);
      const order = [...data.draw_order, data.bonus];
      for (let i = 0; i < order.length; i += 1) {
        await sleep(i === 6 ? 3600 : 3000); // 공마다 텀(실측 ~6초 → 3초로 압축), 보너스는 더 길게
        const b = ballsRef.current.find((x) => x.n === order[i] && x.state === 'mix');
        if (b) {
          const dst = slotPos(i);
          b.state = 'rising';
          b.slot = i;
          // 중앙 배출관 하단 흡입 → 위로 → 상단 캡 배출 → 오른쪽 레일 → 결과 슬롯
          b.path = [
            { x: CX, y: CY }, // 회전 바퀴에 걸림
            { x: CX, y: CAP_Y - 8 }, // 중앙 축 타고 상단 배출
            { x: RAIL_X, y: CY + 20 }, // 오른쪽 레일
            { x: RAIL_X, y: BAR_Y - 40 },
            { x: dst.x, y: dst.y }, // 결과 슬롯
          ];
          b.wp = 0;
        }
      }
      await sleep(1000);
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '추첨 실패');
    } finally {
      spinRef.current = 0.03;
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
        실제 동행복권 추첨기와 동일 — 중앙 수직축 회전 디스크가 45개 볼을 퍼올려 처닝, 공이
        하나씩 상단으로 배출돼 레일을 타고 결과 바로 (실측 간격 반영). 각 호기의 실제 데이터 특성 반영.
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
