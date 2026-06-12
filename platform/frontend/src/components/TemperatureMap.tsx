import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { v1Api, type TemperatureTier } from '../api/v1Api';

const TIER_ORDER: TemperatureTier[] = ['hot', 'warm', 'neutral', 'cold', 'frozen'];
const LOOKBACK_OPTIONS = [10, 30, 50, 100] as const;

interface TemperatureMapProps {
  /** 기본 30회. 사용자가 토글로 변경 가능. */
  initialLookback?: number;
}

export default function TemperatureMap({ initialLookback = 30 }: TemperatureMapProps) {
  const [lookback, setLookback] = useState<number>(initialLookback);

  const { data, isLoading, error } = useQuery({
    queryKey: ['temperature', lookback],
    queryFn: () => v1Api.getTemperature(lookback),
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <Paper sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary">
            온도 계산 중...
          </Typography>
        </Stack>
      </Paper>
    );
  }

  if (error || !data) {
    return (
      <Alert severity="error">
        온도 데이터 로드 실패: {error instanceof Error ? error.message : '알 수 없는 오류'}
      </Alert>
    );
  }

  return (
    <Paper sx={{ p: 2 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        spacing={1}
        sx={{ mb: 1.5 }}
      >
        <Box>
          <Typography variant="subtitle1" fontWeight={700}>
            번호 온도 — 최근 {data.lookback}회 기준
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {data.latest_round}회까지 누적 · 5단계 균등 분배 (각 9개)
          </Typography>
        </Box>
        <ToggleButtonGroup
          exclusive
          value={lookback}
          onChange={(_, v) => v && setLookback(v)}
          size="small"
        >
          {LOOKBACK_OPTIONS.map((opt) => (
            <ToggleButton key={opt} value={opt}>
              {opt}회
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Stack>

      {/* 등급별 요약 칩 */}
      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        {TIER_ORDER.map((tier) => (
          <Chip
            key={tier}
            label={`${data.tier_labels[tier]} ${data.tier_distribution[tier] ?? 0}`}
            size="small"
            sx={{
              bgcolor: data.tier_colors[tier],
              color: '#fff',
              fontWeight: 700,
              border: 'none',
            }}
          />
        ))}
      </Stack>

      {/* 등급별 행 — 각 행에 9개 번호 */}
      <Stack spacing={1}>
        {TIER_ORDER.map((tier) => {
          const items = data.items
            .filter((it) => it.tier === tier)
            .sort((a, b) => a.number - b.number);
          return (
            <Stack
              key={tier}
              direction="row"
              spacing={0.75}
              alignItems="center"
              flexWrap="wrap"
              useFlexGap
            >
              <Box
                sx={{
                  bgcolor: data.tier_colors[tier],
                  color: '#fff',
                  px: 1,
                  py: 0.5,
                  borderRadius: 1,
                  fontSize: 12,
                  fontWeight: 700,
                  minWidth: 80,
                  textAlign: 'center',
                  flexShrink: 0,
                }}
              >
                {data.tier_labels[tier]}
              </Box>
              {items.map((it) => (
                <Tooltip
                  key={it.number}
                  arrow
                  title={
                    <Box sx={{ whiteSpace: 'pre-line' }}>
                      {`#${it.number} (랭크 ${it.rank}/45)\n` +
                        `최근 ${data.lookback}회 출현: ${it.recent_count}회\n` +
                        `마지막 출현 후 ${it.gap}회 경과\n` +
                        `전체 누적: ${it.total_count}회\n` +
                        `점수: ${it.score >= 0 ? '+' : ''}${it.score.toFixed(3)}`}
                    </Box>
                  }
                >
                  <Box
                    sx={{
                      width: 38,
                      height: 38,
                      borderRadius: '50%',
                      bgcolor: data.tier_colors[it.tier],
                      color: '#fff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 700,
                      fontSize: 14,
                      cursor: 'default',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                      transition: 'transform 0.1s',
                      '&:hover': { transform: 'scale(1.1)' },
                    }}
                  >
                    {it.number}
                  </Box>
                </Tooltip>
              ))}
            </Stack>
          );
        })}
      </Stack>

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ mt: 2, display: 'block', fontStyle: 'italic' }}
      >
        {data.disclaimer}
      </Typography>
    </Paper>
  );
}
