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

// 실제 동행복권/MBC 생방송 추첨 방송 — 추첨기 구간(약 5분40초)부터 시작.
const DRAW_VIDEO_ID = 'id2a3I1VBvk';
const DRAW_START = 344;

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
      // 실제 방송처럼 텀을 두고 하나씩 공개
      for (let i = 0; i < order.length; i += 1) {
        await sleep(i === 0 ? 700 : 1500);
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
        🎰 실제 추첨기 (동행복권 생방송)
      </Typography>
      <Typography variant="caption" sx={{ color: '#cbd5e1', display: 'block', mb: 1.5 }}>
        아래는 실제 동행복권 로또 추첨 방송(진짜 추첨기)입니다. 그 아래에서 1/2/3호기의 실제 데이터
        특성을 반영한 추첨을 돌려볼 수 있습니다.
      </Typography>

      {/* 실제 추첨 방송 영상 (16:9) */}
      <Box
        sx={{
          position: 'relative',
          pt: '56.25%',
          borderRadius: 2,
          overflow: 'hidden',
          border: `1px solid ${accent}55`,
          mb: 0.5,
        }}
      >
        <iframe
          title="실제 동행복권 로또 추첨 방송"
          src={`https://www.youtube.com/embed/${DRAW_VIDEO_ID}?start=${DRAW_START}&rel=0&modestbranding=1`}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
          allow="accelerometer; encrypted-media; picture-in-picture"
          allowFullScreen
        />
      </Box>
      <Typography variant="caption" sx={{ color: '#64748b', display: 'block', mb: 2, fontStyle: 'italic' }}>
        ※ 영상은 실제 방송(제1221회) 원본으로 진짜 추첨기 작동 모습입니다. 아래 호기별 추첨은 그와 별개로
        각 호기의 과거 데이터 특성을 반영합니다.
      </Typography>

      {/* 호기별 추첨 */}
      <Typography variant="subtitle2" fontWeight={800} sx={{ color: '#fff', mb: 1 }}>
        호기별 특성 추첨
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

      {/* 추첨된 볼 (텀 두고 공개) */}
      <Box
        sx={{
          minHeight: 52,
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          flexWrap: 'wrap',
          mb: 1,
        }}
      >
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
