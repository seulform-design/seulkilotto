import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import CopyButton from '../components/CopyButton';
import LottoBall from '../components/LottoBall';
import { v1Api } from '../api/v1Api';

type MachineChoice = 'auto' | 1 | 2 | 3;

export default function RoundRecommendPage() {
  const [machine, setMachine] = useState<MachineChoice>('auto');

  const meta = useQuery({ queryKey: ['v1-meta'], queryFn: v1Api.getMeta });
  const recommend = useQuery({
    queryKey: ['v1-recommend', machine],
    queryFn: () =>
      v1Api.getRoundRecommend(machine === 'auto' ? undefined : machine),
  });

  const data = recommend.data;

  return (
    <Box>
      <Typography variant="h5" fontWeight={800} gutterBottom>
        회차 추천
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {meta.data?.current_round ?? '—'}회 추첨 기준 · 호기 패턴 5게임
        {meta.data ? ` (데이터 ${meta.data.row_count}건)` : ''}
      </Typography>
      <Alert severity="info" sx={{ mb: 2 }}>
        호기는 추첨일 기반 추정값입니다. 공식 발표와 다를 수 있으며 통계 참고용입니다.
      </Alert>

      {data && (
        <Paper sx={{ p: 2, mb: 2, bgcolor: '#69C8F2', color: '#10202A' }}>
          <Typography variant="caption" fontWeight={600}>
            추천 대상
          </Typography>
          <Typography variant="h3" fontWeight={800}>
            {data.next_round}회
          </Typography>
          <Typography variant="body2">
            예상 추첨일 {data.next_draw_date} · {data.machine_id}호기
            {data.machine_id !== data.auto_machine_id
              ? ` (자동예측 ${data.auto_machine_id}호기)`
              : ''}
          </Typography>
        </Paper>
      )}

      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" gutterBottom>
          분석 호기
        </Typography>
        <ToggleButtonGroup
          exclusive
          value={machine}
          onChange={(_, v) => v && setMachine(v)}
          size="small"
        >
          {(['auto', 1, 2, 3] as MachineChoice[]).map((opt) => (
            <ToggleButton key={String(opt)} value={opt}>
              {opt === 'auto' ? '자동' : `${opt}호기`}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Paper>

      <Button
        variant="contained"
        color="warning"
        onClick={() => recommend.refetch()}
        disabled={recommend.isFetching}
        sx={{ mb: 2, fontWeight: 800 }}
      >
        {recommend.isFetching ? <CircularProgress size={24} color="inherit" /> : '회차 추천 받기'}
      </Button>

      {recommend.isError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {recommend.error instanceof Error ? recommend.error.message : '추천 실패'}
        </Alert>
      )}
      {data?.warning && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {data.warning}
        </Alert>
      )}

      {data && data.stats.draw_count > 0 && (
        <Paper sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle1" fontWeight={700}>
            호기 통계 요약
          </Typography>
          <Typography variant="body2" color="text.secondary">
            분석 {data.stats.draw_count}회 · 평균합 {data.stats.avg_sum} · 홀{' '}
            {data.stats.avg_odd}
          </Typography>
          <Typography variant="caption" color="warning.main" sx={{ mt: 1, display: 'block' }}>
            최다 출현 TOP 5
          </Typography>
          <Typography variant="body2">
            {data.stats.hot_top5.map((h) => `${h.number}(${h.count})`).join('  ')}
          </Typography>
          <Typography variant="caption" color="warning.main" sx={{ mt: 1, display: 'block' }}>
            미출현 TOP 5
          </Typography>
          <Typography variant="body2">
            {data.stats.cold_top5.map((c) => `${c.number}(${c.gap_rounds})`).join('  ')}
          </Typography>
        </Paper>
      )}

      {data && data.combinations.length > 0 && (
        <Box>
          <Typography variant="subtitle1" fontWeight={700}>
            추천 5게임
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
            {data.compose_rule} · {data.filter_rule}
          </Typography>
          {data.combinations.map((combo, idx) => (
            <Paper key={idx} sx={{ p: 2, mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography sx={{ width: 22, fontWeight: 800, color: 'text.secondary' }}>
                {idx + 1}
              </Typography>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ flex: 1 }}>
                {combo.numbers.map((n) => (
                  <LottoBall key={n} number={n} size={36} />
                ))}
              </Stack>
              <Box sx={{ textAlign: 'right' }}>
                <Typography variant="caption" color="text.secondary" display="block">
                  합{combo.sum_total} · 홀{combo.odd_count}
                </Typography>
                <CopyButton numbers={combo.numbers} />
              </Box>
            </Paper>
          ))}
        </Box>
      )}
    </Box>
  );
}
