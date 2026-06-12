import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControlLabel,
  Grid,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import ReactECharts from 'echarts-for-react';
import { useMemo, useState } from 'react';
import {
  v1Api,
  type WalkForwardResponse,
  type WalkForwardStrategy,
  type WalkForwardStrategyResult,
} from '../api/v1Api';

const STRATEGY_LABELS: Record<WalkForwardStrategy, string> = {
  uniform: '균등 무작위',
  frequency: '빈도 가중',
  epo: 'EPO 파이프라인',
};
const STRATEGY_COLORS: Record<WalkForwardStrategy, string> = {
  uniform: '#9CA3AF',
  frequency: '#69C8F2',
  epo: '#FBC400',
};

interface RunParams {
  startRound: number;
  endRound: number | undefined;
  setsPerRound: number;
  includeEpo: boolean;
  seed: number;
}

const DEFAULT_PARAMS: RunParams = {
  startRound: 1128,
  endRound: undefined,
  setsPerRound: 5,
  includeEpo: false,
  seed: 42,
};

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

function StrategySummary({
  result,
  baseline,
}: {
  result: WalkForwardStrategyResult;
  baseline: number;
}) {
  const isFavorable = result.avg_hits_per_set > baseline;
  return (
    <Paper sx={{ p: 1.5, bgcolor: 'action.hover' }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
        <Typography variant="subtitle2" fontWeight={700}>
          {STRATEGY_LABELS[result.strategy] ?? result.strategy}
        </Typography>
        <Chip
          size="small"
          label={`${result.sets_generated} 세트`}
          variant="outlined"
        />
      </Stack>
      <Stack spacing={0.3}>
        <Stack direction="row" justifyContent="space-between">
          <Typography variant="caption" color="text.secondary">
            평균 적중
          </Typography>
          <Typography variant="body2" fontWeight={700} color={isFavorable ? 'success.main' : 'text.primary'}>
            {result.avg_hits_per_set.toFixed(3)} / 6
          </Typography>
        </Stack>
        <Stack direction="row" justifyContent="space-between">
          <Typography variant="caption" color="text.secondary">
            5등 (3+)
          </Typography>
          <Typography variant="body2">{pct(result.hit_rate_3plus)}</Typography>
        </Stack>
        <Stack direction="row" justifyContent="space-between">
          <Typography variant="caption" color="text.secondary">
            4등 (4+)
          </Typography>
          <Typography variant="body2">{pct(result.hit_rate_4plus)}</Typography>
        </Stack>
        <Stack direction="row" justifyContent="space-between">
          <Typography variant="caption" color="text.secondary">
            3등 (5+)
          </Typography>
          <Typography variant="body2">{pct(result.hit_rate_5plus)}</Typography>
        </Stack>
        <Stack direction="row" justifyContent="space-between">
          <Typography variant="caption" color="text.secondary">
            1등 (6)
          </Typography>
          <Typography variant="body2">{pct(result.hit_rate_6)}</Typography>
        </Stack>
      </Stack>
    </Paper>
  );
}

export default function WalkForwardPanel() {
  const [params, setParams] = useState<RunParams>(DEFAULT_PARAMS);
  const [data, setData] = useState<WalkForwardResponse | null>(null);

  const run = useMutation({
    mutationFn: () =>
      v1Api.getWalkForward({
        startRound: params.startRound,
        endRound: params.endRound,
        setsPerRound: params.setsPerRound,
        includeEpo: params.includeEpo,
        seed: params.seed,
      }),
    onSuccess: (res) => setData(res),
  });

  const cumulativeChartOption = useMemo(() => {
    if (!data) return null;
    const allRounds = data.strategies[0]?.rounds_axis ?? [];
    return {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis' as const },
      legend: {
        data: [
          ...data.strategies.map((s) => STRATEGY_LABELS[s.strategy] ?? s.strategy),
          '베이스라인 0.8',
        ],
        textStyle: { color: '#9BA1A9' },
        top: 0,
      },
      grid: { left: 50, right: 20, top: 40, bottom: 40 },
      xAxis: {
        type: 'category' as const,
        data: allRounds,
        name: '회차',
        nameTextStyle: { color: '#9BA1A9' },
        axisLine: { lineStyle: { color: '#33383F' } },
        axisLabel: { color: '#9BA1A9' },
      },
      yAxis: {
        type: 'value' as const,
        name: '누적 평균 적중',
        nameTextStyle: { color: '#9BA1A9' },
        axisLine: { lineStyle: { color: '#33383F' } },
        axisLabel: { color: '#9BA1A9' },
        splitLine: { lineStyle: { color: '#262A30' } },
      },
      series: [
        ...data.strategies.map((s) => ({
          name: STRATEGY_LABELS[s.strategy] ?? s.strategy,
          type: 'line' as const,
          smooth: true,
          symbol: 'none',
          data: s.cumulative_avg.map((v) => Number(v.toFixed(4))),
          lineStyle: { color: STRATEGY_COLORS[s.strategy], width: 2 },
          itemStyle: { color: STRATEGY_COLORS[s.strategy] },
        })),
        {
          name: '베이스라인 0.8',
          type: 'line' as const,
          smooth: false,
          symbol: 'none',
          data: allRounds.map(() => data.baseline_avg_hits),
          lineStyle: { color: '#FF7272', width: 1.5, type: 'dashed' as const },
          itemStyle: { color: '#FF7272' },
        },
      ],
    };
  }, [data]);

  const distChartOption = useMemo(() => {
    if (!data) return null;
    const hits = [0, 1, 2, 3, 4, 5, 6];
    return {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } },
      legend: {
        data: data.strategies.map((s) => STRATEGY_LABELS[s.strategy] ?? s.strategy),
        textStyle: { color: '#9BA1A9' },
        top: 0,
      },
      grid: { left: 50, right: 20, top: 40, bottom: 40 },
      xAxis: {
        type: 'category' as const,
        data: hits.map((h) => `${h}개`),
        name: '적중 개수',
        nameTextStyle: { color: '#9BA1A9' },
        axisLine: { lineStyle: { color: '#33383F' } },
        axisLabel: { color: '#9BA1A9' },
      },
      yAxis: {
        type: 'value' as const,
        name: '세트 수',
        nameTextStyle: { color: '#9BA1A9' },
        axisLine: { lineStyle: { color: '#33383F' } },
        axisLabel: { color: '#9BA1A9' },
        splitLine: { lineStyle: { color: '#262A30' } },
      },
      series: data.strategies.map((s) => ({
        name: STRATEGY_LABELS[s.strategy] ?? s.strategy,
        type: 'bar' as const,
        data: hits.map((h) => s.hit_distribution[String(h)] ?? 0),
        itemStyle: { color: STRATEGY_COLORS[s.strategy] },
      })),
    };
  }, [data]);

  return (
    <Paper sx={{ p: 2 }}>
      <Box sx={{ mb: 1.5 }}>
        <Typography variant="subtitle1" fontWeight={700}>
          Walk-Forward 백테스트
        </Typography>
        <Typography variant="caption" color="text.secondary">
          회차 R 시점에 R 이전 데이터만으로 학습한 추천 → 실제 R 결과 비교 ·
          베이스라인 = 6×6/45 ≈ 0.8개
        </Typography>
      </Box>

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        flexWrap="wrap"
        useFlexGap
        sx={{ mb: 1.5 }}
      >
        <TextField
          size="small"
          label="시작 회차"
          type="number"
          value={params.startRound}
          onChange={(e) =>
            setParams((p) => ({ ...p, startRound: Math.max(10, Number(e.target.value) || 10) }))
          }
          sx={{ width: 110 }}
        />
        <TextField
          size="small"
          label="종료 회차 (생략=최신)"
          type="number"
          value={params.endRound ?? ''}
          onChange={(e) =>
            setParams((p) => ({
              ...p,
              endRound: e.target.value === '' ? undefined : Number(e.target.value),
            }))
          }
          sx={{ width: 170 }}
        />
        <TextField
          size="small"
          label="회차당 세트"
          type="number"
          value={params.setsPerRound}
          onChange={(e) =>
            setParams((p) => ({
              ...p,
              setsPerRound: Math.max(1, Math.min(20, Number(e.target.value) || 5)),
            }))
          }
          sx={{ width: 110 }}
        />
        <TextField
          size="small"
          label="시드"
          type="number"
          value={params.seed}
          onChange={(e) => setParams((p) => ({ ...p, seed: Number(e.target.value) || 42 }))}
          sx={{ width: 90 }}
        />
        <FormControlLabel
          control={
            <Switch
              checked={params.includeEpo}
              onChange={(e) => setParams((p) => ({ ...p, includeEpo: e.target.checked }))}
            />
          }
          label="EPO 포함 (느림)"
        />
        <Button
          variant="contained"
          color="primary"
          onClick={() => run.mutate()}
          disabled={run.isPending}
          sx={{ fontWeight: 700 }}
        >
          {run.isPending ? <CircularProgress size={20} color="inherit" /> : '시뮬레이션 실행'}
        </Button>
      </Stack>

      {run.isError && (
        <Alert severity="error" sx={{ mb: 1.5 }}>
          {run.error instanceof Error ? run.error.message : '실행 실패'}
        </Alert>
      )}

      {!data && !run.isPending && (
        <Alert severity="info">
          파라미터를 조정한 뒤 「시뮬레이션 실행」 을 누르세요. 기본값(시작 1128, 5세트/회차)
          으로 약 1~3초 소요됩니다.
        </Alert>
      )}

      {data && (
        <>
          <Alert severity="info" sx={{ mb: 1.5 }}>
            {data.rounds_evaluated} 회차 평가 ({data.start_round} ~ {data.end_round}) ·
            회차당 {data.sets_per_round} 세트 · 베이스라인{' '}
            <strong>{data.baseline_avg_hits.toFixed(3)}</strong>
          </Alert>

          <Grid container spacing={1.5} sx={{ mb: 2 }}>
            {data.strategies.map((s) => (
              <Grid item xs={12} sm={6} md={4} key={s.strategy}>
                <StrategySummary result={s} baseline={data.baseline_avg_hits} />
              </Grid>
            ))}
          </Grid>

          {cumulativeChartOption && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 0.5 }}>
                회차별 누적 평균 적중
              </Typography>
              <ReactECharts option={cumulativeChartOption} style={{ height: 280 }} />
            </Box>
          )}

          {distChartOption && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 0.5 }}>
                적중 개수 분포
              </Typography>
              <ReactECharts option={distChartOption} style={{ height: 260 }} />
            </Box>
          )}
        </>
      )}

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ mt: 1, display: 'block', fontStyle: 'italic' }}
      >
        {data?.disclaimer ??
          'Walk-forward 백테스트는 각 전략의 시계열 적중을 측정합니다. 독립시행 정의상 모든 전략의 평균은 베이스라인 0.8 에 수렴합니다.'}
      </Typography>
    </Paper>
  );
}
