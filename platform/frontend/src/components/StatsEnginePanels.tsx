/**
 * 회차 통계 엔진(stats_engine) 화면 — 모두 실제 백엔드 API 결과만 표시한다(샘플 데이터 없음).
 *
 *  - IntegrityProbabilityPanel : 데이터 무결성 + 수학적 기준값(1/8,145,060)
 *  - WindowStatsPanel          : 표본 크기별 통계 + 균등성 검정 + 다중비교 보정
 *  - TicketBacktestPanel       : 6개 1장 walk-forward 백테스트 + 무작위 기준선
 *
 * 수치 종류를 섞지 않는다: 수학적 확률(kind=mathematical) / 백테스트(backtest) /
 * 시뮬레이션(simulation) 을 각각 다른 블록·라벨로 표기한다.
 */
import {
  Alert,
  Box,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EngineSection, EngineStatusChip } from './EngineSection';
import { v1Api } from '../api/v1Api';

const cellSx = { py: 0.4, px: 0.75, fontSize: 11 } as const;

function KindChip({ kind }: { kind: 'mathematical' | 'backtest' | 'simulation' | 'statistics' }) {
  const map = {
    mathematical: { label: '수학적 확률', color: 'primary' as const },
    backtest: { label: '과거 백테스트', color: 'secondary' as const },
    simulation: { label: '무작위 시뮬레이션', color: 'default' as const },
    statistics: { label: '관측 통계', color: 'info' as const },
  }[kind];
  return <EngineStatusChip label={map.label} color={map.color} variant="outlined" />;
}

// ─────────────────────────────────────────────────────────────────────────────

export function IntegrityProbabilityPanel() {
  const [open, setOpen] = useState(true);
  const integ = useQuery({ queryKey: ['v1-stats-integrity'], queryFn: v1Api.getDataIntegrity, staleTime: 300_000 });
  const prob = useQuery({ queryKey: ['v1-stats-probability', 5], queryFn: () => v1Api.getProbability(5), staleTime: Infinity });
  const d = integ.data;
  const p = prob.data;
  const issues = d?.csv?.issues ? Object.entries(d.csv.issues as Record<string, unknown[]>).filter(([, v]) => v.length) : [];

  return (
    <EngineSection
      tone="primary"
      title="🧮 데이터 무결성 · 수학적 기준값"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      chips={
        d ? (
          <EngineStatusChip
            color={d.ok ? 'success' : 'error'}
            label={d.ok ? `무결성 OK · ${d.loaded_rounds}회차` : '무결성 문제'}
          />
        ) : undefined
      }
      intent={<>모든 통계의 입력인 당첨 이력이 온전한지(누락·중복·범위·보너스 혼입·날짜 순서·집계 합계) 검사하고, 시스템의 수학적 기준값을 표시합니다.</>}
    >
      {(integ.isLoading || prob.isLoading) && <LinearProgress />}
      {integ.isError && <Alert severity="warning">무결성 정보를 불러오지 못했습니다.</Alert>}
      {d && (
        <Stack spacing={0.5} sx={{ mb: 1.5 }}>
          <Typography variant="caption">
            데이터 소스 <strong>{d.data_source}</strong> · 회차 {d.csv?.first_round ?? '-'}~{d.latest_round} ({d.loaded_rounds}개) ·
            누락 회차 {d.loaded_missing_rounds?.length ?? 0}개 · 본번호 합계 {d.sums?.main_total}/{d.sums?.main_expected} · 보너스 합계{' '}
            {d.sums?.bonus_total}/{d.sums?.bonus_expected} · 시그니처 <code>{d.data_signature}</code>
          </Typography>
          {issues.length > 0 ? (
            <Alert severity="error" sx={{ py: 0.25 }}>
              {issues.map(([k, v]) => `${k}: ${(v as unknown[]).slice(0, 10).join(', ')}`).join(' · ')}
            </Alert>
          ) : (
            <Typography variant="caption" color="success.main">원본 CSV 검사 항목 이상 없음.</Typography>
          )}
          {d.cache && (
            <Typography variant="caption" color="text.secondary">
              통계 캐시: 항목 {d.cache.entries} · 히트 {d.cache.hits} · 미스 {d.cache.misses} · 오류 {d.cache.errors}
            </Typography>
          )}
        </Stack>
      )}
      {p && (
        <Box>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
            <KindChip kind="mathematical" />
            <Typography variant="caption">
              전체 조합 C(45,6) = <strong>{Number(p.total_combinations).toLocaleString()}</strong> · 1장 1등 확률{' '}
              <strong>{p.single_ticket_jackpot}</strong> · 서로 다른 5장 <strong>{p.n_tickets_jackpot}</strong> (중복 조합은 1장으로 계산)
            </Typography>
          </Stack>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={cellSx}>등수</TableCell>
                <TableCell sx={cellSx}>조건</TableCell>
                <TableCell sx={cellSx} align="right">경우의 수 / 8,145,060</TableCell>
                <TableCell sx={cellSx} align="right">1 / N</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {Object.entries(p.prize_probabilities as Record<string, { exact: string; one_in: number }>).map(([rank, v]) => (
                <TableRow key={rank}>
                  <TableCell sx={cellSx}>{rank}등</TableCell>
                  <TableCell sx={cellSx}>
                    {{ '1': '6개 일치', '2': '5개 + 보너스', '3': '5개 일치', '4': '4개 일치', '5': '3개 일치' }[rank]}
                  </TableCell>
                  <TableCell sx={cellSx} align="right">{v.exact}</TableCell>
                  <TableCell sx={cellSx} align="right">{v.one_in.toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {p.separation}
          </Typography>
        </Box>
      )}
    </EngineSection>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function WindowStatsPanel() {
  const [open, setOpen] = useState(false);
  const [win, setWin] = useState<string>('all');
  const q = useQuery({ queryKey: ['v1-stats-windows'], queryFn: v1Api.getWindowStats, staleTime: 600_000, enabled: open });
  const d = q.data;
  const w = (d?.windows as any[] | undefined)?.find((x) => String(x.window) === win);

  return (
    <EngineSection
      tone="info"
      title="📐 표본 크기별 통계 · 균등성 검정"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      defaultOpen={false}
      chips={
        d ? (
          <EngineStatusChip
            color={d.multiple_testing?.any_significant ? 'warning' : 'success'}
            label={d.multiple_testing?.any_significant ? '보정 후 이탈 있음' : '보정 후 균등과 구분 불가'}
          />
        ) : undefined
      }
      intent={
        <>
          전체·최근 100/50/30/10회의 번호 빈도·미출현·구간·홀짝·저고·연속번호·합계를 원본에서 재계산하고, 균등 추첨 이론 분포와
          카이제곱 검정(효과크기 w)·다중비교 보정(Bonferroni·BH)으로 비교합니다. 기대도수 5 미만인 소표본 검정은 유의성을 주장하지 않습니다.
        </>
      }
    >
      {q.isLoading && <LinearProgress />}
      {q.isError && <Alert severity="warning">윈도우 통계를 불러오지 못했습니다.</Alert>}
      {d && (
        <>
          <Alert severity={d.multiple_testing?.any_significant ? 'warning' : 'success'} sx={{ mb: 1, py: 0.25 }}>
            <Typography variant="caption">{d.verdict}</Typography>
          </Alert>
          <ToggleButtonGroup size="small" exclusive value={win} onChange={(_, v) => v && setWin(v)} sx={{ mb: 1, flexWrap: 'wrap' }}>
            {(d.windows as any[]).map((x) => (
              <ToggleButton key={String(x.window)} value={String(x.window)} sx={{ py: 0.25, fontSize: 11 }}>
                {x.window === 'all' ? '전체' : `최근 ${x.window}회`}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          {w?.ok && (
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <KindChip kind="statistics" />
                <Typography variant="caption">
                  {w.first_round}~{w.last_round}회 · 표본 {w.sample_size.rounds}회({w.sample_size.main_numbers}개 번호) · 합계 평균{' '}
                  {w.sum.mean}(이론 {w.sum.theoretical_mean}) · 범위 {w.sum.min}~{w.sum.max} · 최다 {w.hot_top.join(',')} · 최소{' '}
                  {w.cold_top.join(',')}
                </Typography>
              </Stack>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={cellSx}>검정</TableCell>
                    <TableCell sx={cellSx} align="right">χ²</TableCell>
                    <TableCell sx={cellSx} align="right">df</TableCell>
                    <TableCell sx={cellSx} align="right">p</TableCell>
                    <TableCell sx={cellSx} align="right">효과크기 w</TableCell>
                    <TableCell sx={cellSx}>신뢰 가능</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {Object.entries(w.tests as Record<string, any>).map(([k, t]) => (
                    <TableRow key={k}>
                      <TableCell sx={cellSx}>{t.label}</TableCell>
                      <TableCell sx={cellSx} align="right">{t.test.statistic}</TableCell>
                      <TableCell sx={cellSx} align="right">{t.test.dof}</TableCell>
                      <TableCell sx={cellSx} align="right">{t.test.p_value}</TableCell>
                      <TableCell sx={cellSx} align="right">{t.test.effect_size_w} ({t.test.effect_label})</TableCell>
                      <TableCell sx={cellSx}>{t.test.reliable ? '예' : `아니오(기대 ${t.test.min_expected}<5)`}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: 0.5 }}>
                {(w.numbers as any[]).map((n) => (
                  <Box key={n.number} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, px: 0.75, py: 0.25 }}>
                    <Typography variant="caption" sx={{ fontWeight: 700 }}>{n.number}</Typography>
                    <Typography variant="caption" sx={{ display: 'block', fontSize: 10 }}>
                      {n.count}회 · 기대 {n.expected}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10 }}>
                      미출 {n.gap ?? '구간 내 없음'} · 보너스 {n.bonus_count}
                    </Typography>
                  </Box>
                ))}
              </Box>
            </Stack>
          )}
          {d.co_occurrence && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              동시출현: 쌍당 기대 {d.co_occurrence.expected_per_pair}회 · 최다{' '}
              {(d.co_occurrence.top_pairs as any[]).slice(0, 3).map((t) => `${t.pair.join('-')}(${t.count}, p=${t.p_value})`).join(' · ')} ·{' '}
              Bonferroni 유의 {d.co_occurrence.any_significant ? '있음' : '없음'}. {d.co_occurrence.note}
            </Typography>
          )}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {d.small_sample_policy}
          </Typography>
        </>
      )}
    </EngineSection>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function TicketBacktestPanel() {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['v1-stats-ticket-backtest'], queryFn: () => v1Api.getTicketBacktest(200), staleTime: 3_600_000, enabled: open });
  const d = q.data;

  return (
    <EngineSection
      tone="secondary"
      title="🎫 6개 1장 백테스트 · 무작위 기준선"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      defaultOpen={false}
      chips={
        d?.ok ? (
          <EngineStatusChip
            color={d.any_beats_random ? 'warning' : 'success'}
            label={`${d.tested_rounds}회차 · ${d.any_beats_random ? '우위 후보' : '무작위와 구분 불가'}`}
          />
        ) : undefined
      }
      intent={
        <>
          각 회차마다 전략 상위 6개를 1장 샀다고 가정하고(그 회차 이전 데이터만 사용) 일치 개수·3/4/5/5+보너스/6개 일치 횟수를 셉니다. 이론
          초기하 분포와, 같은 회차·같은 규칙의 무작위 1장을 반복한 Monte Carlo 기준선과 비교합니다.
        </>
      }
    >
      {q.isLoading && <LinearProgress />}
      {q.isError && <Alert severity="warning">티켓 백테스트를 불러오지 못했습니다.</Alert>}
      {d && !d.ok && <Alert severity="info">{d.reason}</Alert>}
      {d?.ok && (
        <>
          <Alert severity={d.any_beats_random ? 'warning' : 'success'} sx={{ mb: 1, py: 0.25 }}>
            <Typography variant="caption">{d.verdict}</Typography>
          </Alert>
          <Stack spacing={0.5} sx={{ mb: 1 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <KindChip kind="mathematical" />
              <Typography variant="caption">
                1장 기대 일치 {d.theoretical.expected_mean_matches}개 · {d.tested_rounds}회 기대 횟수: 3개 {d.theoretical.expected_counts['3']} · 4개{' '}
                {d.theoretical.expected_counts['4']} · 5개 {d.theoretical.expected_counts['5']} · 6개 {d.theoretical.expected_counts['6']}
              </Typography>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center">
              <KindChip kind="simulation" />
              <Typography variant="caption">
                무작위 {d.random_baseline.reps}회 반복({Number(d.random_baseline.tickets).toLocaleString()}장): 평균 일치{' '}
                {d.random_baseline.mean_matches} · 반복 평균 95% 범위 {d.random_baseline.rep_mean_p2_5}~{d.random_baseline.rep_mean_p97_5}
              </Typography>
            </Stack>
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
            <KindChip kind="backtest" />
            <Typography variant="caption" color="text.secondary">
              검증 {d.first_tested_round}~{d.last_tested_round}회 · 다중검정 {d.multiple_testing.n_tested}개 → Bonferroni α={d.multiple_testing.bonferroni_alpha}
            </Typography>
          </Stack>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={cellSx}>전략</TableCell>
                  <TableCell sx={cellSx} align="right">평균 일치</TableCell>
                  <TableCell sx={cellSx} align="right">95% CI</TableCell>
                  <TableCell sx={cellSx} align="right">lift</TableCell>
                  <TableCell sx={cellSx} align="right">p</TableCell>
                  <TableCell sx={cellSx} align="right">3개</TableCell>
                  <TableCell sx={cellSx} align="right">4개</TableCell>
                  <TableCell sx={cellSx} align="right">5개</TableCell>
                  <TableCell sx={cellSx} align="right">5+B</TableCell>
                  <TableCell sx={cellSx} align="right">6개</TableCell>
                  <TableCell sx={cellSx}>기간별 lift(1~4)</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(d.strategies as any[]).map((s) => (
                  <TableRow key={s.strategy}>
                    <TableCell sx={cellSx}>{s.label}</TableCell>
                    <TableCell sx={cellSx} align="right">{s.mean_matches}</TableCell>
                    <TableCell sx={cellSx} align="right">{s.ci95_mean_matches?.join('~')}</TableCell>
                    <TableCell sx={cellSx} align="right">{s.effect_size_lift}</TableCell>
                    <TableCell sx={{ ...cellSx, color: s.significant_bonferroni ? 'warning.main' : undefined }} align="right">{s.p_value}</TableCell>
                    <TableCell sx={cellSx} align="right">{s.match_counts['3']}</TableCell>
                    <TableCell sx={cellSx} align="right">{s.match_counts['4']}</TableCell>
                    <TableCell sx={cellSx} align="right">{s.match_counts.prize_3}</TableCell>
                    <TableCell sx={cellSx} align="right">{s.match_counts.five_plus_bonus}</TableCell>
                    <TableCell sx={cellSx} align="right">{s.match_counts['6']}</TableCell>
                    <TableCell sx={cellSx}>{(s.periods as any[]).map((p) => p.lift).join(' / ')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {d.honesty}
          </Typography>
        </>
      )}
    </EngineSection>
  );
}
