import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Grid,
  Paper,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../../api/fetchJson';

function Panel({
  title,
  loading,
  error,
  children,
}: {
  title: string;
  loading?: boolean;
  error?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Paper sx={{ p: 2, height: '100%' }}>
      <Typography variant="h6" gutterBottom>
        {title}
      </Typography>
      {loading && <CircularProgress size={22} />}
      {error && <Typography color="error">로드 실패</Typography>}
      {children}
    </Paper>
  );
}

export function SurvivalPanel() {
  const q = useQuery({
    queryKey: ['survival'],
    queryFn: () =>
      fetchJson<{ numbers?: Record<string, Record<string, number>> }>('/api/survival'),
  });
  const entries = q.data?.numbers
    ? Object.entries(q.data.numbers)
        .map(([n, lags]) => ({ n: Number(n), lag1: lags.lag_1 ?? 0 }))
        .sort((a, b) => b.lag1 - a.lag1)
        .slice(0, 6)
    : [];
  return (
    <Panel title="번호 생존 통계" loading={q.isLoading} error={q.isError}>
      <Typography variant="caption" color="text.secondary">
        다음 회차 재출현 확률(lag_1) 상위
      </Typography>
      {entries.map((x) => (
        <Typography key={x.n} variant="body2">
          {x.n}번 — {x.lag1}
        </Typography>
      ))}
    </Panel>
  );
}

export function MarkovPanel() {
  const q = useQuery({
    queryKey: ['markov'],
    queryFn: () =>
      fetchJson<{ evidence?: string; transition_sample?: Record<string, Record<string, number>> }>(
        '/api/markov'
      ),
  });
  return (
    <Panel title="마르코프 전이" loading={q.isLoading} error={q.isError}>
      <Typography variant="body2" color="text.secondary" gutterBottom>
        {q.data?.evidence}
      </Typography>
      {q.data?.transition_sample &&
        Object.entries(q.data.transition_sample)
          .slice(0, 3)
          .map(([state, next]) => (
            <Typography key={state} variant="caption" display="block">
              {state} → {Object.keys(next)[0]}
            </Typography>
          ))}
    </Panel>
  );
}

export function PatternDecayPanel() {
  const q = useQuery({
    queryKey: ['pattern-decay'],
    queryFn: () =>
      fetchJson<{
        status?: string;
        full?: number;
        recent_30?: number;
        delta?: number;
      }>('/api/pattern-decay?window=30'),
  });
  const d = q.data;
  return (
    <Panel title="패턴 감쇠 (이월수)" loading={q.isLoading} error={q.isError}>
      {d && (
        <>
          <Typography variant="body2">
            상태: <strong>{d.status}</strong>
          </Typography>
          <Typography variant="caption" color="text.secondary">
            전체 {d.full} · 최근30 {d.recent_30} · Δ{d.delta}
          </Typography>
        </>
      )}
    </Panel>
  );
}

export function StatsValidationPanel() {
  const q = useQuery({
    queryKey: ['statistics'],
    queryFn: () =>
      fetchJson<{
        test?: string;
        p_value?: number;
        is_random_like?: boolean;
        interpretation?: string;
      }>('/api/statistics'),
  });
  const d = q.data;
  return (
    <Panel title="통계 검증 (χ²)" loading={q.isLoading} error={q.isError}>
      {d && (
        <>
          <Typography variant="body2">
            p-value: {d.p_value} · {d.is_random_like ? '균등에 가까움' : '편향 감지'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {d.interpretation}
          </Typography>
        </>
      )}
    </Panel>
  );
}

export function SimulationPanel() {
  const q = useQuery({
    queryKey: ['simulation'],
    queryFn: () =>
      fetchJson<{
        simulations?: number;
        sum_mean?: number;
        sum_std?: number;
        evidence?: string;
      }>('/api/simulation?n=50000'),
    enabled: false,
  });
  return (
    <Panel title="몬테카를로 기준선" loading={q.isFetching} error={q.isError}>
      <Button size="small" variant="outlined" onClick={() => q.refetch()} disabled={q.isFetching}>
        5만 회 시뮬레이션
      </Button>
      {q.data && (
        <Box sx={{ mt: 1 }}>
          <Typography variant="body2">
            총합 μ={q.data.sum_mean} σ={q.data.sum_std}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {q.data.evidence}
          </Typography>
        </Box>
      )}
    </Panel>
  );
}

export function AdvancedResearchGrid() {
  return (
    <Grid container spacing={2} sx={{ mt: 1 }}>
      <Grid item xs={12} md={6}>
        <SurvivalPanel />
      </Grid>
      <Grid item xs={12} md={6}>
        <MarkovPanel />
      </Grid>
      <Grid item xs={12} md={4}>
        <PatternDecayPanel />
      </Grid>
      <Grid item xs={12} md={4}>
        <StatsValidationPanel />
      </Grid>
      <Grid item xs={12} md={4}>
        <SimulationPanel />
      </Grid>
    </Grid>
  );
}
