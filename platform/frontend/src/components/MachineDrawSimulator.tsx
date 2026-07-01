import { useMemo, useRef, useState } from 'react';
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 챔버 안에서 떠다니는 장식용 볼들 (고정 배치 + 부유 애니메이션). */
function ChamberBalls({ spinning }: { spinning: boolean }) {
  const balls = useMemo(
    () =>
      Array.from({ length: 22 }, (_, i) => {
        const n = ((i * 37 + 7) % 45) + 1;
        const left = 8 + ((i * 29) % 76);
        const top = 10 + ((i * 53) % 72);
        const delay = (i % 10) * 0.18;
        const dur = 1.6 + (i % 5) * 0.35;
        return { n, left, top, delay, dur };
      }),
    []
  );
  return (
    <>
      {balls.map((b, i) => (
        <Box
          key={i}
          sx={{
            position: 'absolute',
            left: `${b.left}%`,
            top: `${b.top}%`,
            width: 22,
            height: 22,
            borderRadius: '50%',
            bgcolor: ballColor(b.n),
            color: '#1a1a1a',
            fontSize: 10,
            fontWeight: 800,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: 'inset -2px -2px 3px rgba(0,0,0,0.25)',
            animation: `${spinning ? 'chamberSpin' : 'chamberFloat'} ${
              spinning ? b.dur * 0.4 : b.dur
            }s ease-in-out ${b.delay}s infinite`,
            '@keyframes chamberFloat': {
              '0%,100%': { transform: 'translate(0,0)' },
              '50%': { transform: 'translate(-4px,-8px)' },
            },
            '@keyframes chamberSpin': {
              '0%': { transform: 'translate(0,0) rotate(0deg)' },
              '25%': { transform: 'translate(14px,-12px)' },
              '50%': { transform: 'translate(-10px,10px)' },
              '75%': { transform: 'translate(8px,12px)' },
              '100%': { transform: 'translate(0,0) rotate(360deg)' },
            },
          }}
        >
          {b.n}
        </Box>
      ))}
    </>
  );
}

/** 추첨된 볼 하나 (팝인 애니메이션). */
function DrawnBall({ n, bonus }: { n: number; bonus?: boolean }) {
  return (
    <Box
      sx={{
        width: 46,
        height: 46,
        borderRadius: '50%',
        bgcolor: ballColor(n),
        color: '#1a1a1a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 800,
        fontSize: 18,
        position: 'relative',
        boxShadow: 'inset -3px -3px 5px rgba(0,0,0,0.25), 0 2px 4px rgba(0,0,0,0.3)',
        border: bonus ? '2px dashed #333' : 'none',
        animation: 'ballPop 0.45s cubic-bezier(.17,.89,.32,1.28)',
        '@keyframes ballPop': {
          '0%': { transform: 'scale(0) translateY(-30px)', opacity: 0 },
          '60%': { transform: 'scale(1.15) translateY(4px)', opacity: 1 },
          '100%': { transform: 'scale(1) translateY(0)', opacity: 1 },
        },
      }}
    >
      {n}
    </Box>
  );
}

export default function MachineDrawSimulator() {
  const [machine, setMachine] = useState<1 | 2 | 3>(3);
  const [drawing, setDrawing] = useState(false);
  const [revealed, setRevealed] = useState<number[]>([]);
  const [result, setResult] = useState<MachineDrawResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const accent = MACHINE_ACCENT[machine];

  const draw = async () => {
    if (busy.current) return;
    busy.current = true;
    setDrawing(true);
    setRevealed([]);
    setResult(null);
    setError(null);
    try {
      const seed = Math.floor(Math.random() * 1_000_000_000);
      await sleep(1100); // 챔버 스핀 연출
      const data = await v1Api.getMachineDraw(machine, seed);
      const order = [...data.draw_order, data.bonus];
      for (let i = 0; i < order.length; i += 1) {
        await sleep(650);
        setRevealed((prev) => [...prev, order[i]]);
      }
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '추첨 실패');
    } finally {
      setDrawing(false);
      busy.current = false;
    }
  };

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
        🎰 {machine}호기 추첨기 시뮬레이터
      </Typography>
      <Typography variant="caption" sx={{ color: '#cbd5e1', display: 'block', mb: 1.5 }}>
        각 호기의 실제 추첨 데이터 성향을 반영해 볼을 뽑습니다. (연출 — 실제 확률 1/8,145,060 불변)
      </Typography>

      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={machine}
          onChange={(_, v) => {
            if (v && !drawing) {
              setMachine(v);
              setRevealed([]);
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

      {/* 추첨 챔버 */}
      <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
        <Box
          sx={{
            position: 'relative',
            width: 240,
            height: 240,
            borderRadius: '50%',
            background: 'radial-gradient(circle at 35% 30%, #ffffff30, #1e293b 70%)',
            border: `4px solid ${accent}`,
            overflow: 'hidden',
            boxShadow: `0 0 30px ${accent}55, inset 0 0 30px rgba(0,0,0,0.5)`,
          }}
        >
          <ChamberBalls spinning={drawing && revealed.length === 0} />
          {/* 유리 하이라이트 */}
          <Box
            sx={{
              position: 'absolute',
              top: '12%',
              left: '18%',
              width: '30%',
              height: '18%',
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.25)',
              filter: 'blur(6px)',
            }}
          />
        </Box>
      </Box>

      {/* 추첨된 볼 */}
      <Box
        sx={{
          minHeight: 60,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 1,
          flexWrap: 'wrap',
          mb: 2,
        }}
      >
        {revealed.length === 0 && !drawing && (
          <Typography variant="body2" sx={{ color: '#94a3b8' }}>
            아래 버튼을 눌러 {machine}호기 추첨을 시작하세요
          </Typography>
        )}
        {revealed.map((n, i) => (
          <Stack key={i} direction="row" alignItems="center" spacing={1}>
            {i === 6 && (
              <Typography sx={{ color: '#fff', fontWeight: 800, fontSize: 22 }}>+</Typography>
            )}
            <DrawnBall n={n} bonus={i === 6} />
          </Stack>
        ))}
        {drawing && revealed.length < 7 && (
          <Typography variant="body2" sx={{ color: accent, fontWeight: 700, ml: 1 }}>
            추첨 중…
          </Typography>
        )}
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
            <Chip size="small" variant="outlined" label={`합 ${result.sum_total}`} sx={{ color: '#e2e8f0', borderColor: '#475569' }} />
            <Chip size="small" variant="outlined" label={`홀 ${result.odd_count}:${result.even_count} 짝`} sx={{ color: '#e2e8f0', borderColor: '#475569' }} />
          </Stack>
          <Typography variant="caption" sx={{ color: '#cbd5e1', display: 'block' }}>
            📊 {machine}호기 특징 — 실측 {result.draw_count}회 · 평균합 {result.avg_sum} · 평균 홀 {result.avg_odd} ·
            시그니처 번호 {result.signature_numbers.join(', ')}
          </Typography>
          <Typography variant="caption" sx={{ color: '#64748b', display: 'block', mt: 0.5, fontStyle: 'italic' }}>
            {result.disclaimer}
          </Typography>
        </Box>
      )}
    </Box>
  );
}
