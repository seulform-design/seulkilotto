import { useEffect, useState } from 'react';
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
import { v1Api, type MachineDrawResult, type MachineProfile } from '../api/v1Api';

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
  const [profile, setProfile] = useState<MachineProfile | null>(null);

  const accent = MACHINE_ACCENT[machine];

  // 호기 선택 즉시 실측 성향 프로파일 로드 (추첨과 무관)
  useEffect(() => {
    let alive = true;
    setProfile(null);
    v1Api
      .getMachineProfile(machine)
      .then((p) => {
        if (alive) setProfile(p);
      })
      .catch(() => {
        if (alive) setProfile(null);
      });
    return () => {
      alive = false;
    };
  }, [machine]);

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
        Matter.js 물리엔진 기반 — 3대 모두 동일 기종(같은 크기·구조), 호기별 송풍·추첨간격만 다릅니다.
        구조: 하단 송풍으로 45개 볼이 격렬히 순환 → 중앙 수직관을 타고 올라온 공이 12시에서 회전 테두리의 4개 포켓 중 하나에 담겨 → 테두리가 돌며 좌하단으로 배출됩니다. 회전속도는 실측 추첨간격(~5초)에서 역산합니다(번호는 물리 결과로 결정).
      </Typography>

      {/* Matter.js 물리 추첨기 (1/2/3호기, 상단 배출식) */}
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
          src="/venus-machine.html?v=19"
          style={{ display: 'block', width: '100%', height: 800, border: 0 }}
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

      {/* 호기별 실측 성향 프로파일 (969회 누적 역산) */}
      {profile && profile.persona && (
        <Box
          sx={{
            mb: 2,
            p: 1.5,
            borderRadius: 2,
            border: `1px solid ${accent}55`,
            background: `linear-gradient(180deg, ${accent}14, transparent)`,
          }}
        >
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75 }}>
            <Chip
              size="small"
              label={`${machine}호기 · ${profile.persona}`}
              sx={{ bgcolor: accent, color: '#fff', fontWeight: 800 }}
            />
            <Typography variant="caption" sx={{ color: '#94a3b8' }}>
              실측 {profile.confirmed_count}회 역산
            </Typography>
          </Stack>
          <Typography variant="body2" sx={{ color: '#e2e8f0', mb: 1 }}>
            {profile.tagline}
          </Typography>

          {/* 번호대 점유 막대 */}
          <Stack direction="row" spacing={0.5} sx={{ mb: 1 }}>
            {profile.decade_pct.map((pct, i) => {
              const max = Math.max(...profile.decade_pct);
              return (
                <Box key={i} sx={{ flex: 1, textAlign: 'center' }}>
                  <Box
                    sx={{
                      height: 34,
                      display: 'flex',
                      alignItems: 'flex-end',
                      justifyContent: 'center',
                    }}
                  >
                    <Box
                      sx={{
                        width: '70%',
                        height: `${(pct / max) * 100}%`,
                        borderRadius: '3px 3px 0 0',
                        bgcolor: pct === max ? accent : `${accent}66`,
                      }}
                    />
                  </Box>
                  <Typography sx={{ color: '#cbd5e1', fontSize: 10, fontWeight: 700 }}>
                    {pct}%
                  </Typography>
                  <Typography sx={{ color: '#64748b', fontSize: 9 }}>
                    {profile.decade_labels[i]}
                  </Typography>
                </Box>
              );
            })}
          </Stack>

          {/* 대표 성향 지표 (편차 큰 순 상위 3) */}
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
            {profile.traits.slice(0, 3).map((t) => {
              const up = t.delta > 0;
              return (
                <Chip
                  key={t.key}
                  size="small"
                  variant="outlined"
                  label={`${t.label} ${t.value}${t.unit} (${up ? '▲' : '▼'}${Math.abs(
                    t.delta
                  )})`}
                  sx={{
                    color: '#e2e8f0',
                    borderColor: up ? `${accent}aa` : '#475569',
                    fontSize: 11,
                  }}
                />
              );
            })}
          </Stack>

          {/* 다출 번호(핫) */}
          <Stack direction="row" alignItems="center" spacing={0.5} flexWrap="wrap" useFlexGap>
            <Typography variant="caption" sx={{ color: '#94a3b8', mr: 0.25 }}>
              다출 번호
            </Typography>
            {profile.hot.map((h) => (
              <LottoBall key={h.number} number={h.number} size={26} />
            ))}
          </Stack>

          <Typography
            variant="caption"
            sx={{ color: '#64748b', display: 'block', mt: 1, fontStyle: 'italic' }}
          >
            {profile.honesty}
          </Typography>
        </Box>
      )}

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
