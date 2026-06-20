/**
 * 평행회차 분석 패널 — 선택된 회차의 동일 끝2자리 회차군 당첨 패턴.
 */
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { v1Api, type ParallelRoundAnalysisResponse } from '../api/v1Api';
import LottoBall from './LottoBall';

interface ParallelRoundPanelProps {
  targetRound?: number | null;
  defaultOpen?: boolean;
  modeLabel?: string;
}

const DECADE_ORDER = ['단번대', '10번대', '20번대', '30번대', '40번대'] as const;

function DecadeSummary({ data }: { data: ParallelRoundAnalysisResponse }) {
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="subtitle2" fontWeight={700} gutterBottom>
        ★ 평행강수 &amp; 기대수 (구간별)
      </Typography>
      <Stack spacing={1}>
        {DECADE_ORDER.map((label) => {
          const bucket = data.by_decade[label];
          if (!bucket) return null;
          return (
            <Stack key={label} direction="row" flexWrap="wrap" alignItems="center" gap={0.75}>
              <Typography variant="caption" fontWeight={700} sx={{ minWidth: 52 }}>
                {label}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                강수
              </Typography>
              {bucket.strong.map((n) => (
                <Chip key={`${label}-s-${n}`} size="small" label={n} color="error" variant="outlined" />
              ))}
              <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                기대
              </Typography>
              {bucket.expected.map((n) => (
                <Chip key={`${label}-e-${n}`} size="small" label={n} variant="outlined" />
              ))}
            </Stack>
          );
        })}
      </Stack>
      {data.ending_digits.length > 0 && (
        <Stack direction="row" flexWrap="wrap" alignItems="center" gap={0.75} sx={{ mt: 1 }}>
          <Typography variant="caption" fontWeight={700}>
            끝수
          </Typography>
          {data.ending_digits.slice(0, 5).map((item) => (
            <Chip
              key={`end-${item.digit}`}
              size="small"
              label={`${item.digit} (${item.count})`}
              color="primary"
              variant="outlined"
            />
          ))}
        </Stack>
      )}
    </Box>
  );
}

export default function ParallelRoundPanel({
  targetRound,
  defaultOpen = true,
  modeLabel = '확인',
}: ParallelRoundPanelProps) {
  const [open, setOpen] = useState(defaultOpen);

  const query = useQuery({
    queryKey: ['v1-parallel-round', targetRound ?? 'auto'],
    queryFn: () => v1Api.getParallelRoundAnalysis(targetRound ?? undefined),
    enabled: true,
    staleTime: 300_000,
  });

  const data = query.data;

  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderColor: 'warning.main' }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setOpen((v) => !v)}
      >
        <Typography variant="subtitle2" fontWeight={700}>
          🔀 평행회차 분석
          {data ? ` — ${data.suffix_label} · ${data.parallel_count}회` : ''}
          {open ? ' ▼' : ' ▶'}
        </Typography>
        {query.isFetching && <CircularProgress size={16} />}
      </Stack>

      {open && (
        <Box sx={{ mt: 1 }}>
          {query.isError && (
            <Alert severity="warning" sx={{ mb: 1 }}>
              {modeLabel} 평행회차 데이터를 불러오지 못했습니다.
            </Alert>
          )}
          {data && (
            <>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                {modeLabel} 기준 · {data.summary} · 대상 {data.target_round}회 · 반자동 고정 후보{' '}
                {data.semi_auto_fixed_hint.join(', ') || '—'}
              </Typography>
              {data.disclaimer && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                  {data.disclaimer}
                </Typography>
              )}

              {(data.draw_table?.length ?? 0) > 0 && (
                <Box sx={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 420, mb: 1 }}>
                  <Table size="small" sx={{ minWidth: 480 }}>
                    <TableHead>
                      <TableRow>
                        <TableCell>회차</TableCell>
                        <TableCell align="center">1</TableCell>
                        <TableCell align="center">2</TableCell>
                        <TableCell align="center">3</TableCell>
                        <TableCell align="center">4</TableCell>
                        <TableCell align="center">5</TableCell>
                        <TableCell align="center">6</TableCell>
                        <TableCell align="center">보너스</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {data.draw_table.map((row) => {
                        const strongSet = new Set(data.parallel_strong.slice(0, 6));
                        return (
                          <TableRow key={row.round}>
                            <TableCell>{row.round}</TableCell>
                            {row.numbers.map((n, idx) => (
                              <TableCell key={`${row.round}-${idx}`} align="center" sx={{ p: 0.5 }}>
                                <LottoBall
                                  number={n}
                                  size={28}
                                  dimmed={!strongSet.has(n)}
                                />
                              </TableCell>
                            ))}
                            <TableCell align="center" sx={{ p: 0.5 }}>
                              <LottoBall number={row.bonus} size={28} />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </Box>
              )}

              <DecadeSummary data={data} />

              {data.travel_highlights.length > 0 && (
                <Box sx={{ mt: 1.5 }}>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>
                    연속 평행 출현 (경로)
                  </Typography>
                  <Stack direction="row" flexWrap="wrap" gap={0.75}>
                    {data.travel_highlights.map((item) => (
                      <Chip
                        key={`travel-${item.number}`}
                        size="small"
                        label={`${item.number} · ${item.appearances.map((a) => a.round).join('→')}`}
                        variant="outlined"
                        color="secondary"
                      />
                    ))}
                  </Stack>
                </Box>
              )}
            </>
          )}
        </Box>
      )}
    </Paper>
  );
}
