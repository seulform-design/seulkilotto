import { Alert, Box, LinearProgress, Stack, Typography } from '@mui/material';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EngineSection, EngineStatusChip } from './EngineSection';
import { v1Api } from '../api/v1Api';

/**
 * 🗄️ 전체 당첨 이력 워크포워드 백테스트 — 흔한 전략(핫·콜드·미출·최근·페어·회피)이
 * 무작위를 이기는지 수백~1200+ 회차로 검정. 다중검정(Bonferroni) 보정으로 위양성 제거.
 * ⚠️ 로또 i.i.d. — 확률 불변. 큰 표본으로도 우위 없음을 정직하게 확정하는 도구.
 */
export default function FullHistoryBacktestPanel() {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['v1-full-history-backtest'],
    queryFn: v1Api.getFullHistoryBacktest,
    staleTime: 3_600_000,
  });
  const d = q.data;

  return (
    <EngineSection
      tone="info"
      title="🗄️ 전체 이력 백테스트 (모든 회차)"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      defaultOpen={false}
      sx={{ mb: 2 }}
      chips={
        d?.ok ? (
          <EngineStatusChip
            color={d.any_beats_random ? 'warning' : 'success'}
            label={`${d.tested_rounds}회차 · ${d.any_beats_random ? '우위 후보' : '무작위 못 이김(천장)'}`}
          />
        ) : undefined
      }
      intent={
        <>
          <strong>4회차 용지</strong>가 아니라 <strong>전체 당첨 이력 전부</strong>로, 흔한 전략(핫·콜드·미출·최근·페어·회피)이
          무작위를 이기는지 워크포워드(각 회차는 이전 회차만으로 예측→그 회차로 채점, 누수 없음)로 검정합니다.
          큰 표본이라 아주 작은 우위도 잡아낼 검정력이 있습니다.
        </>
      }
    >
      {q.isLoading && <LinearProgress />}
      {q.isError && <Alert severity="warning">전체 이력 백테스트를 불러오지 못했습니다.</Alert>}
      {d && !d.ok && <Alert severity="info">{d.reason ?? '이력이 부족합니다.'}</Alert>}
      {d?.ok && (
        <>
          <Alert severity={d.any_beats_random ? 'warning' : 'success'} sx={{ mb: 1.5, py: 0.5 }}>
            <Typography variant="caption">{d.verdict}</Typography>
          </Alert>

          {d.multiple_testing && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, mb: 1 }}>
              🎲 다중검정: {d.multiple_testing.n_tested}회 검정 → 순수 우연으로도 평균{' '}
              <strong>{d.multiple_testing.expected_false_positives}개</strong>가 'p&lt;0.05'로 보임(위양성).
              실제 미보정 유의 <strong>{d.multiple_testing.raw_significant_count}개</strong> — 진짜 우위는 Bonferroni(p&lt;{d.multiple_testing.bonferroni_alpha}) 통과분만.
            </Typography>
          )}

          <Box sx={{ overflowX: 'auto' }}>
            <Stack spacing={0.3} sx={{ minWidth: 460 }}>
              <Stack direction="row" spacing={1} sx={{ fontWeight: 800, fontSize: 10, color: 'text.secondary', px: 0.5 }}>
                <Box sx={{ width: 150 }}>전략</Box>
                <Box sx={{ width: 130, textAlign: 'right' }}>top6 (기대 {d.random_baseline?.['6']})</Box>
                <Box sx={{ width: 150, textAlign: 'right' }}>top18 (기대 {d.random_baseline?.['18']})</Box>
              </Stack>
              {(d.strategies ?? []).map((s) => {
                const k6 = s.by_k['6'];
                const k18 = s.by_k['18'];
                const cell = (c: typeof k18) => (
                  <span>
                    {c.mean_per_round}{' '}
                    <span style={{ opacity: 0.7 }}>×{c.lift}</span>{' '}
                    <span style={{ fontWeight: 700, color: c.significant ? '#2e7d32' : c.significant_raw ? '#ed6c02' : '#9e9e9e' }}>
                      p={c.p_value}{c.significant ? '✓유의' : c.significant_raw ? '·위양성' : ''}
                    </span>
                  </span>
                );
                return (
                  <Stack key={s.strategy} direction="row" spacing={1} alignItems="center"
                    sx={{ px: 0.5, py: 0.2, borderRadius: 0.5, bgcolor: k18.significant ? 'rgba(46,125,50,0.1)' : 'transparent', fontSize: 10 }}>
                    <Box sx={{ width: 150, fontWeight: 700 }}>{s.label}</Box>
                    <Box sx={{ width: 130, textAlign: 'right' }}>{cell(k6)}</Box>
                    <Box sx={{ width: 150, textAlign: 'right' }}>{cell(k18)}</Box>
                  </Stack>
                );
              })}
            </Stack>
          </Box>

          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', fontSize: 9, mt: 1, fontStyle: 'italic' }}>
            ⚠️ {d.honesty}
          </Typography>
        </>
      )}
    </EngineSection>
  );
}
