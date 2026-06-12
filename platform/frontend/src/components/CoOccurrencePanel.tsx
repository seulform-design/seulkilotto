import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  LinearProgress,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import LottoBall from './LottoBall';
import { v1Api } from '../api/v1Api';

const ALL_NUMBERS = Array.from({ length: 45 }, (_, i) => i + 1);
const DISPLAY_TOP_N = 10;

export default function CoOccurrencePanel() {
  const [selected, setSelected] = useState<number>(17);

  const { data, isLoading, error } = useQuery({
    queryKey: ['co-occurrence', 20],
    queryFn: () => v1Api.getCoOccurrence(20),
    staleTime: 5 * 60_000,
  });

  const partners = useMemo(
    () => data?.partners?.[String(selected)]?.slice(0, DISPLAY_TOP_N) ?? [],
    [data, selected]
  );
  const sourceAppearance = data?.appearance_counts?.[String(selected)] ?? 0;
  const baselinePct = data ? data.baseline_confidence * 100 : 11.36;
  const maxConfidence = partners.length > 0 ? Math.max(...partners.map((p) => p.confidence)) : 0;
  const sigCount = partners.filter((p) => p.is_significant).length;

  if (isLoading) {
    return (
      <Paper sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary">
            동반 출현 계산 중...
          </Typography>
        </Stack>
      </Paper>
    );
  }

  if (error || !data) {
    return (
      <Alert severity="error">
        동반 출현 데이터 로드 실패: {error instanceof Error ? error.message : '알 수 없는 오류'}
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
            동반 출현 분석 — #{selected}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            전체 {data.total_rounds}회 · #{selected} 출현 {sourceAppearance}회 ·
            무작위 베이스라인 {baselinePct.toFixed(1)}%
          </Typography>
        </Box>
        {sigCount > 0 ? (
          <Chip
            size="small"
            color="warning"
            label={`통계적 유의 ${sigCount}쌍`}
            sx={{ fontWeight: 700 }}
          />
        ) : (
          <Chip
            size="small"
            variant="outlined"
            label="유의한 쌍 없음 (무작위 범위)"
          />
        )}
      </Stack>

      {/* 번호 선택 그리드 */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(15, minmax(0, 1fr))',
          gap: 0.5,
          p: 1,
          borderRadius: 1.5,
          bgcolor: 'action.hover',
          mb: 2,
        }}
      >
        {ALL_NUMBERS.map((n) => {
          const isSelected = n === selected;
          return (
            <Box
              key={n}
              onClick={() => setSelected(n)}
              sx={{
                display: 'flex',
                justifyContent: 'center',
                cursor: 'pointer',
                transform: isSelected ? 'scale(1.15)' : 'scale(1)',
                transition: 'transform 0.12s ease, opacity 0.12s ease',
                opacity: isSelected ? 1 : 0.55,
              }}
            >
              <LottoBall number={n} size={26} dimmed={!isSelected} />
            </Box>
          );
        })}
      </Box>

      {/* 파트너 목록 */}
      {partners.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          #{selected} 의 동반 출현 데이터가 없습니다.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {partners.map((p, idx) => {
            const widthPct = maxConfidence > 0 ? (p.confidence / maxConfidence) * 100 : 0;
            const confidencePct = p.confidence * 100;
            const liftDirection = p.lift >= 1 ? '+' : '';
            return (
              <Box key={p.number}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
                  <Typography
                    variant="caption"
                    sx={{ width: 28, color: 'text.secondary', fontWeight: 700 }}
                  >
                    #{idx + 1}
                  </Typography>
                  <LottoBall number={p.number} size={32} />
                  <Tooltip
                    arrow
                    title={
                      <Box sx={{ whiteSpace: 'pre-line' }}>
                        {`#${p.number} 동반 출현\n` +
                          `함께 등장 ${p.count}회\n` +
                          `P(#${p.number} | #${selected}) = ${confidencePct.toFixed(2)}%\n` +
                          `Lift ${p.lift.toFixed(3)} (1.0 = 무작위)\n` +
                          `베이스라인 ${baselinePct.toFixed(2)}%`}
                      </Box>
                    }
                  >
                    <Box sx={{ flex: 1, position: 'relative' }}>
                      <LinearProgress
                        variant="determinate"
                        value={widthPct}
                        sx={{
                          height: 18,
                          borderRadius: 1,
                          bgcolor: 'action.selected',
                          '& .MuiLinearProgress-bar': {
                            bgcolor: p.is_significant ? 'warning.main' : 'primary.main',
                          },
                        }}
                      />
                      <Typography
                        variant="caption"
                        sx={{
                          position: 'absolute',
                          top: 0,
                          left: 8,
                          lineHeight: '18px',
                          fontWeight: 700,
                          color: '#fff',
                          textShadow: '0 1px 2px rgba(0,0,0,0.6)',
                        }}
                      >
                        {p.count}회 · {confidencePct.toFixed(1)}%
                      </Typography>
                    </Box>
                  </Tooltip>
                  <Chip
                    size="small"
                    label={`Lift ${liftDirection}${p.lift.toFixed(2)}`}
                    color={p.is_significant ? 'warning' : 'default'}
                    variant={p.is_significant ? 'filled' : 'outlined'}
                    sx={{ minWidth: 78, fontWeight: 700 }}
                  />
                </Stack>
              </Box>
            );
          })}
        </Stack>
      )}

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
