/**
 * 평행회차 분석 패널 — 선택된 회차의 동일 끝2자리 회차군 당첨 패턴.
 */
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
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
  const [roundFilter, setRoundFilter] = useState('');
  const [sortMode, setSortMode] = useState<'desc' | 'asc'>('desc');
  const [strongOnly, setStrongOnly] = useState(false);

  const query = useQuery({
    queryKey: ['v1-parallel-round', targetRound ?? 'auto'],
    queryFn: () => v1Api.getParallelRoundAnalysis(targetRound ?? undefined),
    enabled: true,
    staleTime: 300_000,
  });

  const data = query.data;
  const highlightSet = new Set((data?.parallel_strong ?? []).slice(0, 6));
  const strongCandidateSet = new Set(data?.parallel_strong ?? []);
  const visibleDraws = (data?.draw_table ?? [])
    .filter((row) => {
      if (roundFilter.trim() && !String(row.round).includes(roundFilter.trim())) {
        return false;
      }
      if (!strongOnly) return true;
      return row.numbers.some((n) => strongCandidateSet.has(n)) || strongCandidateSet.has(row.bonus);
    })
    .slice()
    .sort((a, b) => (sortMode === 'desc' ? b.round - a.round : a.round - b.round));

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
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                alignItems={{ xs: 'stretch', sm: 'center' }}
                sx={{ mb: 1.25 }}
              >
                <TextField
                  size="small"
                  label="회차 검색"
                  value={roundFilter}
                  onChange={(e) => setRoundFilter(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder="예: 1229"
                  sx={{ width: { xs: '100%', sm: 140 } }}
                />
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  <Chip
                    size="small"
                    clickable
                    color={sortMode === 'desc' ? 'primary' : 'default'}
                    variant={sortMode === 'desc' ? 'filled' : 'outlined'}
                    label="최신순"
                    onClick={() => setSortMode('desc')}
                  />
                  <Chip
                    size="small"
                    clickable
                    color={sortMode === 'asc' ? 'primary' : 'default'}
                    variant={sortMode === 'asc' ? 'filled' : 'outlined'}
                    label="오래된순"
                    onClick={() => setSortMode('asc')}
                  />
                  <Chip
                    size="small"
                    clickable
                    color={strongOnly ? 'secondary' : 'default'}
                    variant={strongOnly ? 'filled' : 'outlined'}
                    label="강수 포함만"
                    onClick={() => setStrongOnly((v) => !v)}
                  />
                </Stack>
                {(roundFilter || strongOnly || sortMode !== 'desc') && (
                  <Button
                    type="button"
                    size="small"
                    color="inherit"
                    onClick={() => {
                      setRoundFilter('');
                      setSortMode('desc');
                      setStrongOnly(false);
                    }}
                  >
                    초기화
                  </Button>
                )}
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                표시 {visibleDraws.length} / 전체 {data.draw_table.length}회
              </Typography>
              {data.disclaimer && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                  {data.disclaimer}
                </Typography>
              )}

              {visibleDraws.length > 0 && (
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
                      {visibleDraws.map((row) => {
                        return (
                          <TableRow key={row.round}>
                            <TableCell>{row.round}</TableCell>
                            {row.numbers.map((n, idx) => (
                              <TableCell key={`${row.round}-${idx}`} align="center" sx={{ p: 0.5 }}>
                                <LottoBall
                                  number={n}
                                  size={28}
                                  dimmed={!highlightSet.has(n)}
                                />
                              </TableCell>
                            ))}
                            <TableCell align="center" sx={{ p: 0.5 }}>
                              <LottoBall number={row.bonus} size={28} dimmed={!highlightSet.has(row.bonus)} />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </Box>
              )}
              {visibleDraws.length === 0 && (
                <Alert severity="info" sx={{ mb: 1 }}>
                  현재 조건에 맞는 평행회차가 없습니다. 검색어/필터를 조정해 주세요.
                </Alert>
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
