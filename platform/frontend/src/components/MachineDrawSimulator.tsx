import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import LottoBall from './LottoBall';
import { v1Api, type MachineDrawResult } from '../api/v1Api';

const MACHINE_ACCENT: Record<number, string> = {
  1: '#E8570D',
  2: '#0D8A3E',
  3: '#2952CC',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function MachineDrawSimulator() {
  const [machine, setMachine] = useState<1 | 2 | 3>(3);
  const [result, setResult] = useState<MachineDrawResult | null>(null);
  const [revealed, setRevealed] = useState<number[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accent = MACHINE_ACCENT[machine];

  const draw = async () => {
    if (drawing) return;
    setDrawing(true);
    setResult(null);
    setRevealed([]);
    setError(null);
    try {
      const seed = Math.floor(Math.random() * 1_000_000_000);
      const data = await v1Api.getMachineDraw(machine, seed);
      const order = [...data.draw_order, data.bonus];
      for (let i = 0; i < order.length; i += 1) {
        await sleep(i === 0 ? 700 : 1400);
        setRevealed((prev) => [...prev, order[i]]);
      }
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '추첨 실패');
    } finally {
      setDrawing(false);
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
        🎰 로또 추첨기 (Editec Venus VIII 재현)
      </Typography>
      <Typography variant="caption" sx={{ color: '#cbd5e1', display: 'block', mb: 1.5 }}>
        Matter.js 물리엔진 기반 — 1·2·3호기 각각 드럼 크기·송풍세기·추첨시간이 다릅니다. 45개 볼이
        공기압으로 사방으로 튕기며 섞이고, 하단 게이트로 낙하해 레일로 추출됩니다(번호는 물리 결과로 결정).
      </Typography>

      {/* Matter.js 물리 추첨기 (1/2/3호기, 하단 배출식) */}
      <Box
        sx={{
          borderRadius: 2,
          overflow: 'hidden',
          border: `1px solid ${accent}44`,
          mb: 2,
          bgcolor: '#111622',
        }}
      >
        <iframe
          title="동행복권 로또 추첨기 (1/2/3호기)"
          src="/venus-machine.html?v=2"
          style={{ display: 'block', width: '100%', height: 820, border: 0 }}
          scrolling="no"
        />
      </Box>

      {/* 호기별 특성 추첨 (실측 데이터 가중) */}
      <Typography variant="subtitle2" fontWeight={800} sx={{ color: '#fff', mb: 0.5 }}>
        호기별 특성 추첨
      </Typography>
      <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block', mb: 1 }}>
        각 호기(1/2/3)의 실제 추첨 데이터 성향을 반영한 번호 추첨입니다.
      </Typography>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={machine}
          onChange={(_, v) => {
            if (v && !drawing) {
              setMachine(v);
              setResult(null);
              setRevealed([]);
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
        <Button
          variant="contained"
          onClick={draw}
          disabled={drawing}
          sx={{ bgcolor: accent, fontWeight: 800, '&:hover': { bgcolor: accent, filter: 'brightness(1.1)' } }}
        >
          {drawing ? <CircularProgress size={22} color="inherit" /> : `${machine}호기 추첨`}
        </Button>
      </Stack>

      <Box sx={{ minHeight: 52, display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap', mb: 1 }}>
        {revealed.length === 0 && !drawing && (
          <Typography variant="body2" sx={{ color: '#94a3b8' }}>
            {machine}호기 추첨 버튼을 눌러보세요
          </Typography>
        )}
        {revealed.map((n, i) => (
          <Stack key={i} direction="row" alignItems="center" spacing={0.75}>
            {i === 6 && (
              <Typography sx={{ color: '#fff', fontWeight: 800, fontSize: 20, mx: 0.25 }}>+</Typography>
            )}
            <LottoBall number={n} size={40} />
          </Stack>
        ))}
        {drawing && revealed.length < 7 && (
          <Typography variant="body2" sx={{ color: accent, fontWeight: 700, ml: 0.5 }}>
            추첨 중…
          </Typography>
        )}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}

      {result && !drawing && (
        <Box sx={{ mt: 1 }}>
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
            📊 {machine}호기 특성 — 실측 {result.draw_count}회 · 평균합 {result.avg_sum} ·
            평균 홀 {result.avg_odd} · 시그니처 번호 {result.signature_numbers.join(', ')}
          </Typography>
          <Typography variant="caption" sx={{ color: '#64748b', display: 'block', mt: 0.5, fontStyle: 'italic' }}>
            {result.disclaimer}
          </Typography>
        </Box>
      )}
    </Box>
  );
}
