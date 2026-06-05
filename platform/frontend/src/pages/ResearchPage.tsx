import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Grid,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import CopyButton from '../components/CopyButton';
import PairHeatmap from '../components/PairHeatmap';
import TriplePanel from '../components/TriplePanel';
import RulesPanel from '../components/RulesPanel';
import { AdvancedResearchGrid } from '../components/research/AdvancedPanels';
import { fetchJson } from '../api/fetchJson';

function KpiCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h5">{value}</Typography>
    </Paper>
  );
}

export default function ResearchPage() {
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => fetchJson<{ ok: boolean; row_count: number; source: string }>('/api/data/status'),
  });
  const kpi = useQuery({
    queryKey: ['kpi'],
    queryFn: () => fetchJson<Record<string, unknown>>('/api/dashboard/kpi'),
  });
  const score = useQuery({
    queryKey: ['score'],
    queryFn: () =>
      fetchJson<{ ranking?: { number: number; score: number; reasons: string[] }[] }>('/api/score'),
  });
  const rec = useQuery({
    queryKey: ['recommend'],
    queryFn: () =>
      fetchJson<{ combinations?: { numbers: number[]; reasons: string[] }[] }>(
        '/api/recommend?n_sets=5'
      ),
    enabled: false,
  });
  const backtest = useQuery({
    queryKey: ['backtest'],
    queryFn: () =>
      fetchJson<{
        hit_rate_top6?: number;
        hit_rate_top4?: number;
        disclaimer?: string;
        rounds_tested?: number;
      }>('/api/backtest'),
    enabled: false,
  });
  const cond = useQuery({
    queryKey: ['cond'],
    queryFn: () =>
      fetchJson<{
        evidence?: string;
        top_next_numbers?: { number: number; probability: number }[];
      }>('/api/conditional/pair?a=7&b=11'),
  });

  const k = kpi.data as {
    latest_round?: number;
    ac?: number;
    repeat_count?: number;
    neighbor_count?: number;
    machine_no?: number;
    numbers?: number[];
    bonus?: number;
  } | undefined;

  return (
    <Box>
      <Typography variant="h5" fontWeight={800} gutterBottom>
        패턴 연구 · 검증
      </Typography>
      <Alert severity="info" sx={{ mb: 2 }}>
        독립시행 확률 게임 — 모든 수치는 과거 데이터 기반이며 당첨을 보장하지 않습니다.
        {status.data?.ok && (
          <> (데이터 {status.data.row_count}건 · {status.data.source})</>
        )}
      </Alert>

      {status.isError && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          v2 API 연결 실패 — 연구 백엔드(포트 8100)가 실행 중인지 확인하세요.
        </Alert>
      )}

      {kpi.isLoading && <CircularProgress size={24} sx={{ mb: 2 }} />}

      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={6} md={2}>
          <KpiCard label="최신 회차" value={k?.latest_round ?? '—'} />
        </Grid>
        <Grid item xs={6} md={2}>
          <KpiCard label="AC" value={k?.ac ?? '—'} />
        </Grid>
        <Grid item xs={6} md={2}>
          <KpiCard label="이월수" value={k?.repeat_count ?? '—'} />
        </Grid>
        <Grid item xs={6} md={2}>
          <KpiCard label="이웃수" value={k?.neighbor_count ?? '—'} />
        </Grid>
        <Grid item xs={6} md={2}>
          <KpiCard label="호기" value={k?.machine_no ?? '—'} />
        </Grid>
      </Grid>

      {k?.numbers && (
        <Paper sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle1">최신 당첨</Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {k.numbers.map((n) => (
              <Chip key={n} label={n} color="primary" />
            ))}
            <Chip label={`+${k.bonus}`} variant="outlined" />
          </Stack>
        </Paper>
      )}

      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="h6" gutterBottom>
          45×45 Pair 히트맵
        </Typography>
        <PairHeatmap />
      </Paper>

      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="h6" gutterBottom>
          Triple 패턴
        </Typography>
        <TriplePanel />
      </Paper>

      <Grid container spacing={2}>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6">조건부 확률 (7-11)</Typography>
            {cond.isLoading && <CircularProgress size={20} />}
            {cond.isError && <Typography color="error">로드 실패</Typography>}
            <Typography variant="body2" color="text.secondary">
              {cond.data?.evidence}
            </Typography>
            {cond.data?.top_next_numbers?.slice(0, 5).map((t) => (
              <Typography key={t.number}>
                {t.number}번 P={t.probability}
              </Typography>
            ))}
          </Paper>
        </Grid>
        <Grid item xs={12} md={6}>
          <RulesPanel />
        </Grid>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6">번호 점수 TOP 8</Typography>
            {score.isLoading && <CircularProgress size={20} />}
            {score.data?.ranking?.slice(0, 8).map((r) => (
              <Typography key={r.number} variant="body2">
                {r.number}: {r.score} — {r.reasons.join(', ')}
              </Typography>
            ))}
          </Paper>
        </Grid>
      </Grid>

      <AdvancedResearchGrid />

      <Stack direction="row" spacing={2} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
        <Button variant="contained" onClick={() => rec.refetch()} disabled={rec.isFetching}>
          {rec.isFetching ? <CircularProgress size={20} /> : '추천 5조합'}
        </Button>
        <Button variant="outlined" onClick={() => backtest.refetch()} disabled={backtest.isFetching}>
          {backtest.isFetching ? <CircularProgress size={20} /> : '백테스트'}
        </Button>
      </Stack>

      {rec.data?.combinations && (
        <Paper sx={{ p: 2, mt: 2 }}>
          <Typography variant="h6">추천 조합</Typography>
          {rec.data.combinations.map((c, i) => (
            <Box key={i} sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography sx={{ flex: 1 }}>
                {i + 1}. {c.numbers.join(' ')}
              </Typography>
              <CopyButton numbers={c.numbers} />
            </Box>
          ))}
        </Paper>
      )}

      {backtest.data?.hit_rate_top6 != null && (
        <Paper sx={{ p: 2, mt: 2 }}>
          <Typography variant="h6">Walk-Forward 백테스트</Typography>
          <Typography>Top6 Hit: {backtest.data.hit_rate_top6}</Typography>
          {backtest.data.hit_rate_top4 != null && (
            <Typography variant="body2">Top4 Hit: {backtest.data.hit_rate_top4}</Typography>
          )}
          {backtest.data.rounds_tested != null && (
            <Typography variant="caption" color="text.secondary">
              검증 회차: {backtest.data.rounds_tested}
            </Typography>
          )}
          <Typography variant="caption" display="block">
            {backtest.data.disclaimer}
          </Typography>
        </Paper>
      )}
    </Box>
  );
}
