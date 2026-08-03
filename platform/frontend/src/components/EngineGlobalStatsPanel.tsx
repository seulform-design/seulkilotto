import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Chip,
  Divider,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { EngineSection, EngineStatusChip } from './EngineSection';
import FrequencyBarChart from './FrequencyBarChart';
import OddEvenBar from './OddEvenBar';
import TemperatureMap from './TemperatureMap';
import CoOccurrencePanel from './CoOccurrencePanel';
import PatternAnalysisPanel from './post/PatternAnalysisPanel';
import { v1Api } from '../api/v1Api';

/**
 * V4. 전역 통계 엔진 — 대시보드/후속출현탭에 흩어져 있던 전역 통계(홀짝·빈도·온도·동반·후속)를
 * 용지분석 학습 엔진으로 통합한다. 각 통계에 full_history_backtest(전체 이력 walk-forward,
 * 이전 회차로만 예측→해당 회차 채점, 누수 없음) 판정을 붙여 '무작위 대비 실제 예측력'을
 * 정직하게 표시한다.
 *
 * ⚠️ 로또는 i.i.d.(균등 독립) — 대부분의 전역 통계는 무작위를 이기지 못한다(백테스트가 증명).
 *    확률(1/8,145,060)은 어떤 통계로도 변하지 않는다. 이 패널의 값어치는 '무엇이 안 통하는지'를
 *    정직하게 보여주는 데 있다.
 */

const VERDICT_K = 18; // 넓은 그물 기준(집중 top6 은 대부분 무작위 근처라 top18 로 판정)

type Verdict = { lift: number; p: number; sig: boolean; mean: number; exp: number };

export default function EngineGlobalStatsPanel() {
  const [open, setOpen] = useState(false);

  // ⚠️ 네트워크 요청 폭주 방지 — 이 패널의 모든 쿼리는 패널을 실제로 펼쳤을 때(open)만
  // 발화한다. ④ 학습 엔진에는 이미 ~10개 패널이 동시에 무거운 백엔드를 치는데, 여기서
  // 무겁고(full-history) 부수적인(빈도·후속·분석) 요청까지 마운트 즉시 얹으면 브라우저
  // 동시 연결 한도를 넘겨 '네트워크 요청 초과'(ERR_INSUFFICIENT_RESOURCES)가 난다.
  const bt = useQuery({
    queryKey: ['v1-full-history-backtest'],
    queryFn: v1Api.getFullHistoryBacktest,
    staleTime: 900_000,
    retry: 1,
  });
  const freq = useQuery({
    queryKey: ['v1-frequency-all'],
    queryFn: () => v1Api.getFrequency(undefined),
    staleTime: 300_000,
  });
  const latest = useQuery({ queryKey: ['v1-latest'], queryFn: v1Api.getLatestDraw });
  const analysis = useQuery({
    queryKey: ['v1-analyze-latest', latest.data?.round],
    queryFn: () => v1Api.analyzeCombination(latest.data!.numbers),
    enabled: !!latest.data?.numbers,
    staleTime: 300_000,
  });
  const post = useQuery({
    queryKey: ['v1-post-occurrence-engine', latest.data?.round],
    queryFn: () =>
      v1Api.getPostOccurrenceAnalysis({
        roundNo: latest.data?.round,
        numbers: latest.data?.numbers,
        bonus: latest.data?.bonus,
      }),
    enabled: !!latest.data?.numbers,
    staleTime: 300_000,
  });

  const stratMap = useMemo(() => {
    const m: Record<string, Verdict> = {};
    for (const s of bt.data?.strategies ?? []) {
      const b = s.by_k?.[String(VERDICT_K)];
      if (b) m[s.strategy] = { lift: b.lift, p: b.p_value, sig: b.significant, mean: b.mean_per_round, exp: b.expected_per_round };
    }
    return m;
  }, [bt.data]);

  const VerdictChip = ({ keys }: { keys: string[] }) => {
    const vs = keys.map((k) => stratMap[k]).filter(Boolean) as Verdict[];
    if (!vs.length) return null;
    const best = vs.reduce((a, b) => (b.mean > a.mean ? b : a));
    const anySig = vs.some((v) => v.sig);
    return (
      <Chip
        size="small"
        color={anySig ? 'success' : 'default'}
        variant={anySig ? 'filled' : 'outlined'}
        label={`백테스트: 평균 ${best.mean}/${VERDICT_K} · 무작위 ${best.exp} · lift ${best.lift}${anySig ? ' · ✓유의' : ' · 무작위와 구분 안 됨'}`}
        sx={{ height: 20, fontSize: 10, fontWeight: 700, mb: 0.75 }}
      />
    );
  };

  const hot = useMemo(
    () => [...(freq.data?.items ?? [])].sort((a, b) => b.count - a.count).slice(0, 5),
    [freq.data],
  );
  const cold = useMemo(
    () => [...(freq.data?.items ?? [])].sort((a, b) => a.count - b.count).slice(0, 5),
    [freq.data],
  );

  return (
    <EngineSection
      tone="secondary"
      title="V4. 전역 통계 엔진 (walk-forward 백테스트)"
      id="engine-global-stats"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      defaultOpen={false}
      sx={{ mb: 2 }}
      chips={
        <EngineStatusChip
          color={bt.data?.any_beats_random ? 'success' : 'default'}
          label={
            bt.isLoading
              ? '백테스트 로딩'
              : bt.data?.ok
                ? bt.data.any_beats_random
                  ? '일부 유의(주의)'
                  : '전부 무작위 이하'
                : '—'
          }
        />
      }
      intent={
        <>
          대시보드·후속출현에 흩어져 있던 전역 통계(<strong>홀짝·빈도·온도·동반·후속</strong>)를 이 엔진으로
          통합했습니다. 각 통계에 <strong>전체 이력 walk-forward 백테스트</strong>(이전 회차로만 예측 →
          해당 회차 채점, 누수 없음 · 다중검정 Bonferroni 보정)를 붙여 예측력을 정직하게 표시합니다.
        </>
      }
    >
      {bt.isLoading && <LinearProgress sx={{ mb: 1 }} />}
      {bt.data?.honesty && (
        <Alert severity="warning" sx={{ mb: 1.5, py: 0.5 }}>
          <Typography variant="caption">{bt.data.honesty}</Typography>
        </Alert>
      )}

      {/* 전략별 백테스트 요약표 */}
      {bt.data?.ok && (bt.data.strategies?.length ?? 0) > 0 && (
        <Box sx={{ overflowX: 'auto', mb: 2 }}>
          <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
            전체 이력 백테스트 ({bt.data.tested_rounds ?? '?'}회 채점 · 무작위 대비)
          </Typography>
          <Table size="small" sx={{ minWidth: 480 }}>
            <TableHead>
              <TableRow>
                <TableCell>전략</TableCell>
                <TableCell align="right">평균/{VERDICT_K}</TableCell>
                <TableCell align="right">무작위</TableCell>
                <TableCell align="right">lift</TableCell>
                <TableCell align="right">p</TableCell>
                <TableCell align="right">판정</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(bt.data.strategies ?? []).map((s) => {
                const b = s.by_k?.[String(VERDICT_K)];
                if (!b) return null;
                return (
                  <TableRow key={s.strategy}>
                    <TableCell sx={{ fontSize: 11 }}>{s.label}</TableCell>
                    <TableCell align="right" sx={{ fontSize: 11 }}>{b.mean_per_round}</TableCell>
                    <TableCell align="right" sx={{ fontSize: 11, color: 'text.disabled' }}>{b.expected_per_round}</TableCell>
                    <TableCell align="right" sx={{ fontSize: 11 }}>{b.lift}</TableCell>
                    <TableCell align="right" sx={{ fontSize: 11 }}>{b.p_value}</TableCell>
                    <TableCell align="right">
                      <Chip
                        size="small"
                        color={b.significant ? 'success' : 'default'}
                        variant="outlined"
                        label={b.significant ? '유의' : '무작위'}
                        sx={{ height: 16, fontSize: 8, fontWeight: 700 }}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 9, mt: 0.5 }}>
            {bt.data.verdict ?? '전 전략을 다중검정 보정 후 판정. 유의=무작위를 정말로 넘음, 무작위=구분 안 됨.'}
          </Typography>
        </Box>
      )}

      {/* 홀짝 비율 — 분포 통계(랭킹 전략 아님) */}
      <Divider textAlign="left" sx={{ my: 1.5 }}>
        <Typography variant="caption" fontWeight={800}>홀짝 비율</Typography>
      </Divider>
      <Chip
        size="small"
        variant="outlined"
        label="분포 통계 — 각 번호 홀/짝은 고정, 특정 비율이 확률을 바꾸지 않음(무작위)"
        sx={{ height: 20, fontSize: 10, mb: 0.75 }}
      />
      {analysis.data && (
        <OddEvenBar odd={analysis.data.odd_count} even={analysis.data.even_count} />
      )}

      {/* 번호 출현 빈도 — hot/cold */}
      <Divider textAlign="left" sx={{ my: 1.5 }}>
        <Typography variant="caption" fontWeight={800}>번호 출현 빈도</Typography>
      </Divider>
      <VerdictChip keys={['hot', 'cold']} />
      {freq.data && (
        <>
          <FrequencyBarChart items={freq.data.items} totalRounds={freq.data.total_rounds} />
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mt: 1 }}>
            <Box sx={{ flex: 1 }}>
              <Typography variant="caption" color="warning.main" sx={{ fontWeight: 700 }}>🔥 HOT TOP 5</Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                {hot.map((h) => (
                  <Chip key={`hot-${h.number}`} size="small" label={`${h.number} · ${h.count}회`} color="warning" variant="outlined" />
                ))}
              </Stack>
            </Box>
            <Box sx={{ flex: 1 }}>
              <Typography variant="caption" color="info.main" sx={{ fontWeight: 700 }}>❄ COLD TOP 5</Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                {cold.map((c) => (
                  <Chip key={`cold-${c.number}`} size="small" label={`${c.number} · ${c.count}회`} color="info" variant="outlined" />
                ))}
              </Stack>
            </Box>
          </Stack>
        </>
      )}

      {/* 번호 온도 — 최근 30회 */}
      <Divider textAlign="left" sx={{ my: 1.5 }}>
        <Typography variant="caption" fontWeight={800}>번호 온도 (최근 30회)</Typography>
      </Divider>
      <VerdictChip keys={['recent', 'overdue']} />
      <TemperatureMap initialLookback={30} />

      {/* 동반 출현 */}
      <Divider textAlign="left" sx={{ my: 1.5 }}>
        <Typography variant="caption" fontWeight={800}>동반 출현 분석</Typography>
      </Divider>
      <VerdictChip keys={['pair_hot']} />
      <CoOccurrencePanel />

      {/* 후속 출현 통계 */}
      <Divider textAlign="left" sx={{ my: 1.5 }}>
        <Typography variant="caption" fontWeight={800}>후속 출현 통계</Typography>
      </Divider>
      <VerdictChip keys={['pair_hot']} />
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, mb: 0.75 }}>
        직전 {latest.data?.round ?? '?'}회 당첨번호 다음 회차 후속 패턴. (동반/후속은 백테스트상 pair 전략으로 검증됨)
      </Typography>
      {post.isLoading && <LinearProgress sx={{ mb: 1 }} />}
      {post.data && (
        <PatternAnalysisPanel pattern={post.data.pattern_analysis} bonus={post.data.bonus_analysis} />
      )}

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 9, mt: 1.5, fontStyle: 'italic' }}>
        ⚠️ 로또는 i.i.d. — 위 통계 대부분은 walk-forward 백테스트에서 무작위와 구분되지 않습니다. 확률(1/8,145,060)은
        어떤 통계로도 변하지 않으며, 이 엔진은 '무엇이 통하고 무엇이 안 통하는지'를 정직하게 검증해 보여줄 뿐입니다.
      </Typography>
    </EngineSection>
  );
}
