import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import ComboActions from '../components/ComboActions';
import LottoBall from '../components/LottoBall';
import MetricChips from '../components/MetricChips';
import MachineDrawSimulator from '../components/MachineDrawSimulator';
import { v1Api } from '../api/v1Api';

const HONESTY_DISCLAIMER =
  '본 추첨기 추천은 호기별 과거 통계 패턴에 기반합니다. 모든 6-튜플의 1등 당첨 확률은 동일하게 1/8,145,060 이며, 본 페이지의 어떤 옵션도 그 확률을 변경하지 않습니다. 추첨기는 공정 관리되어 어느 호기든 다음 회차 예측력은 사실상 없습니다.';

const MACHINE_COLORS: Record<number, string> = { 1: '#E8570D', 2: '#0D8A3E', 3: '#2952CC' };

type MachineChoice = 'auto' | 1 | 2 | 3;

export default function RoundRecommendPage() {
  const [machine, setMachine] = useState<MachineChoice>('auto');

  const meta = useQuery({ queryKey: ['v1-meta'], queryFn: v1Api.getMeta });
  const overview = useQuery({
    queryKey: ['v1-machine-overview'],
    queryFn: v1Api.getMachineOverview,
  });
  const recommend = useQuery({
    queryKey: ['v1-recommend', machine],
    queryFn: () =>
      v1Api.getRoundRecommend(machine === 'auto' ? undefined : machine),
  });

  const data = recommend.data;
  const ov = overview.data;

  return (
    <Box>
      <Typography variant="h5" fontWeight={800} gutterBottom>
        회차 추천
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {meta.data?.current_round ?? '—'}회 추첨 기준 · 호기 패턴 5게임
        {meta.data ? ` (데이터 ${meta.data.row_count}건)` : ''}
      </Typography>
      <Alert severity="success" sx={{ mb: 2 }}>
        호기는 <b>실측 데이터</b>입니다 — lottotapa {ov?.coverage.confirmed_count ?? 969}회
        ({ov?.coverage.min_round ?? 262}~{ov?.coverage.max_round ?? 1230}) 당첨번호 100% 대조 검증.
        1~261회는 기록 미확보로 월별순환 추정, 다음 회차는 1→2→3 순환 예측입니다.
      </Alert>

      <MachineDrawSimulator />

      {ov && (
        <Paper sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            🎰 추첨기(호기) 현황
          </Typography>

          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
            <Typography variant="body2" color="text.secondary">다음 {ov.next_round}회 예측</Typography>
            <Chip
              label={`${ov.next_machine}호기`}
              sx={{ bgcolor: MACHINE_COLORS[ov.next_machine], color: '#fff', fontWeight: 800 }}
            />
            <Chip
              size="small"
              variant="outlined"
              label={ov.next_source === 'confirmed' ? '실측 확정' : '순환 예측'}
              color={ov.next_source === 'confirmed' ? 'success' : 'info'}
            />
            <Typography variant="caption" color="text.secondary">
              (최신 {ov.latest_round}회 {ov.latest_machine}호기 · {ov.current_block_len}연속 →
              순환상 다음 {ov.next_in_rotation}호기)
            </Typography>
          </Stack>

          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>
            최근 호기 순환 이력
          </Typography>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
            {ov.recent_history.map((h) => (
              <Chip
                key={h.round}
                size="small"
                label={`${h.round}·${h.machine}호`}
                title={h.confirmed ? '실측 확정' : '추정'}
                sx={{
                  bgcolor: MACHINE_COLORS[h.machine],
                  color: '#fff',
                  fontWeight: 700,
                  opacity: h.confirmed ? 1 : 0.5,
                }}
              />
            ))}
          </Stack>

          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {[1, 2, 3].map((m) => (
              <Chip
                key={m}
                size="small"
                variant="outlined"
                label={`${m}호기 ${ov.per_machine[String(m)]?.count ?? 0}회 (최근 ${ov.per_machine[String(m)]?.last_round ?? '-'}회)`}
                sx={{ borderColor: MACHINE_COLORS[m], color: MACHINE_COLORS[m], fontWeight: 700 }}
              />
            ))}
          </Stack>
        </Paper>
      )}

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
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
            <Typography variant="subtitle1" fontWeight={700}>
              호기 통계 요약
            </Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              <Chip
                size="small"
                label={`표본 ${data.stats.draw_count}회`}
                variant="outlined"
              />
              <Chip size="small" label={`평균합 ${data.stats.avg_sum}`} variant="outlined" />
              <Chip size="small" label={`평균 홀 ${data.stats.avg_odd}`} variant="outlined" />
            </Stack>
          </Stack>

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mt: 1 }}>
            <Box sx={{ flex: 1 }}>
              <Typography variant="caption" color="warning.main" sx={{ fontWeight: 700 }}>
                🔥 최다 출현 TOP 5
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                {data.stats.hot_top5.map((h) => (
                  <Chip
                    key={`hot-${h.number}`}
                    size="small"
                    label={`${h.number} · ${h.count}회`}
                    color="warning"
                    variant="outlined"
                  />
                ))}
              </Stack>
            </Box>
            <Box sx={{ flex: 1 }}>
              <Typography variant="caption" color="info.main" sx={{ fontWeight: 700 }}>
                ❄ 미출현 TOP 5 (gap)
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                {data.stats.cold_top5.map((c) => (
                  <Chip
                    key={`cold-${c.number}`}
                    size="small"
                    label={`${c.number} · ${c.gap_rounds}회 전`}
                    color="info"
                    variant="outlined"
                  />
                ))}
              </Stack>
            </Box>
          </Stack>

          {data.stats.consecutive_top3?.length > 0 && (
            <Box sx={{ mt: 1.5 }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontWeight: 700, display: 'block' }}
              >
                연속 출현 TOP 3
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                {data.stats.consecutive_top3.map((c, i) => (
                  <Chip
                    key={`cons-${i}`}
                    size="small"
                    label={`${c.pair.join('-')} · ${c.count}회`}
                    variant="outlined"
                  />
                ))}
              </Stack>
            </Box>
          )}

          {data.stats.synergy_top3?.length > 0 && (
            <Box sx={{ mt: 1.5 }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontWeight: 700, display: 'block' }}
              >
                동반 출현 TOP 3 (호기 내)
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                {data.stats.synergy_top3.map((s, i) => (
                  <Chip
                    key={`syn-${i}`}
                    size="small"
                    label={`${s.pair.join(' & ')} · ${s.count}회`}
                    variant="outlined"
                    color="success"
                  />
                ))}
              </Stack>
            </Box>
          )}
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
            <Paper key={idx} sx={{ p: 2, mb: 1 }}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                alignItems={{ xs: 'flex-start', sm: 'center' }}
              >
                <Typography
                  sx={{
                    width: 28,
                    fontWeight: 800,
                    color: 'text.secondary',
                    flexShrink: 0,
                    fontSize: 18,
                  }}
                >
                  {idx + 1}
                </Typography>
                <Stack
                  direction="row"
                  spacing={0.75}
                  flexWrap="wrap"
                  useFlexGap
                  sx={{ flex: 1 }}
                >
                  {combo.numbers.map((n) => (
                    <LottoBall key={n} number={n} size={38} />
                  ))}
                </Stack>
                <ComboActions
                  numbers={combo.numbers}
                  source="recommend"
                  label={
                    data?.machine_id
                      ? `${data.machine_id}호기 ${idx + 1}게임`
                      : `추첨기 ${idx + 1}게임`
                  }
                />
              </Stack>
              <MetricChips numbers={combo.numbers} />
              {combo.pattern_label && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mt: 0.5 }}
                >
                  패턴: {combo.pattern_label}
                </Typography>
              )}
            </Paper>
          ))}

          <Divider sx={{ my: 2 }} />
          <Paper variant="outlined" sx={{ p: 1.5, borderColor: 'warning.main', borderLeftWidth: 4, borderLeftStyle: 'solid' }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
              <Chip
                size="small"
                label="1등 확률 1 / 8,145,060"
                color="warning"
                sx={{ fontWeight: 700 }}
              />
              <Chip size="small" label="≈ 0.0000123%" variant="outlined" />
            </Stack>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontStyle: 'italic' }}
            >
              {HONESTY_DISCLAIMER}
            </Typography>
          </Paper>
        </Box>
      )}
    </Box>
  );
}
