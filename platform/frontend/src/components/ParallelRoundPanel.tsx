/**
 * L10-A. 평행회차 분석 — 끝2자리 동일 회차군의 당첨 패턴.
 * 학습 엔진 규격: EngineSection + SubBlock + StatusChip + LottoBall.
 */
import {
  Alert,
  Box,
  Button,
  CircularProgress,
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
import { ENGINE_BALL, EngineSection, EngineStatusChip, EngineSubBlock } from './EngineSection';
import LottoBall from './LottoBall';

interface ParallelRoundPanelProps {
  targetRound?: number | null;
  defaultOpen?: boolean;
  modeLabel?: string;
}

const DECADE_ORDER = ['단번대', '10번대', '20번대', '30번대', '40번대'] as const;

function DecadeSummary({ data }: { data: ParallelRoundAnalysisResponse }) {
  return (
    <EngineSubBlock
      tone="warning"
      title="A. 평행 강수 · 기대수 (구간별)"
      chips={<EngineStatusChip variant="outlined" label="밝은 공=강수 TOP6" />}
    >
      <Stack spacing={0.75}>
        {DECADE_ORDER.map((label) => {
          const bucket = data.by_decade[label];
          if (!bucket) return null;
          const strongSet = new Set(bucket.strong);
          return (
            <Stack key={label} direction="row" flexWrap="wrap" alignItems="center" gap={0.5} useFlexGap>
              <Typography variant="caption" fontWeight={700} sx={{ minWidth: 48, fontSize: 10 }}>
                {label}
              </Typography>
              <Typography variant="caption" color="error.light" sx={{ fontSize: 10, fontWeight: 700 }}>
                강수
              </Typography>
              {bucket.strong.length === 0 && (
                <Typography variant="caption" color="text.disabled" sx={{ fontSize: 10 }}>
                  —
                </Typography>
              )}
              {bucket.strong.map((n) => (
                <LottoBall key={`${label}-s-${n}`} number={n} size={ENGINE_BALL.list} />
              ))}
              <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5, fontSize: 10, fontWeight: 700 }}>
                기대
              </Typography>
              {bucket.expected.length === 0 && (
                <Typography variant="caption" color="text.disabled" sx={{ fontSize: 10 }}>
                  —
                </Typography>
              )}
              {bucket.expected.map((n) => (
                <LottoBall
                  key={`${label}-e-${n}`}
                  number={n}
                  size={ENGINE_BALL.list}
                  dimmed={strongSet.has(n) ? false : true}
                />
              ))}
            </Stack>
          );
        })}
      </Stack>
      {data.ending_digits.length > 0 && (
        <Stack direction="row" flexWrap="wrap" alignItems="center" gap={0.5} useFlexGap sx={{ mt: 1 }}>
          <Typography variant="caption" fontWeight={700} sx={{ fontSize: 10 }}>
            끝수
          </Typography>
          {data.ending_digits.slice(0, 5).map((item) => (
            <EngineStatusChip
              key={`end-${item.digit}`}
              variant="outlined"
              color="primary"
              label={`${item.digit} (${item.count})`}
            />
          ))}
        </Stack>
      )}
    </EngineSubBlock>
  );
}

export default function ParallelRoundPanel({
  targetRound,
  defaultOpen = false,
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
    <EngineSection
      tone="warning"
      id="learn-l10a"
      title="L10-A. 평행회차 분석"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      actions={query.isFetching ? <CircularProgress size={16} /> : undefined}
      chips={
        <>
          <EngineStatusChip variant="outlined" label={modeLabel} />
          {data ? (
            <>
              <EngineStatusChip color="warning" label={data.suffix_label} />
              <EngineStatusChip variant="outlined" label={`${data.parallel_count}회`} />
              <EngineStatusChip variant="outlined" label={`대상 ${data.target_round}회`} />
            </>
          ) : (
            <EngineStatusChip
              color={query.isError ? 'error' : 'default'}
              label={query.isError ? '오류' : query.isFetching ? '로딩' : '대기'}
            />
          )}
        </>
      }
      intent={
        data
          ? `${modeLabel} · ${data.summary} · 고정수 힌트 ${data.semi_auto_fixed_hint.join(', ') || '—'}. 밝은 공=강수 TOP6. 주입: validatedLearning 아님 → L1 평행가산·③ 5세트에 직접.`
          : `${modeLabel} 끝2자리 동일 회차군. 주입 경로는 상단 주입 맵(L10-A=직접) 참고.`
      }
    >
      {query.isError && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          {modeLabel} 평행회차 데이터를 불러오지 못했습니다.
        </Alert>
      )}
      {!data && !query.isError && (
        <Alert severity="info" sx={{ py: 0.5 }}>
          평행회차 데이터를 불러오는 중…
        </Alert>
      )}
      {data && (
        <Stack spacing={1.25}>
          <DecadeSummary data={data} />

          <EngineSubBlock
            tone="neutral"
            title="B. 평행 회차표"
            chips={
              <EngineStatusChip variant="outlined" label={`표시 ${visibleDraws.length}/${data.draw_table.length}`} />
            }
          >
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              alignItems={{ xs: 'stretch', sm: 'center' }}
              sx={{ mb: 1 }}
            >
              <TextField
                size="small"
                label="회차 검색"
                value={roundFilter}
                onChange={(e) => setRoundFilter(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="예: 1234"
                sx={{ width: { xs: '100%', sm: 140 } }}
              />
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                <EngineStatusChip
                  clickable
                  color={sortMode === 'desc' ? 'primary' : 'default'}
                  variant={sortMode === 'desc' ? 'filled' : 'outlined'}
                  label="최신순"
                  onClick={() => setSortMode('desc')}
                />
                <EngineStatusChip
                  clickable
                  color={sortMode === 'asc' ? 'primary' : 'default'}
                  variant={sortMode === 'asc' ? 'filled' : 'outlined'}
                  label="오래된순"
                  onClick={() => setSortMode('asc')}
                />
                <EngineStatusChip
                  clickable
                  color={strongOnly ? 'secondary' : 'default'}
                  variant={strongOnly ? 'filled' : 'outlined'}
                  label="강수 포함만"
                  onClick={() => setStrongOnly((v) => !v)}
                />
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
            </Stack>
            {data.disclaimer && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75, fontSize: 10 }}>
                {data.disclaimer}
              </Typography>
            )}
            {visibleDraws.length > 0 ? (
              <Box sx={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 420 }}>
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
                    {visibleDraws.map((row) => (
                      <TableRow key={row.round}>
                        <TableCell>{row.round}</TableCell>
                        {row.numbers.map((n, idx) => (
                          <TableCell key={`${row.round}-${idx}`} align="center" sx={{ p: 0.5 }}>
                            <LottoBall number={n} size={ENGINE_BALL.list} dimmed={!highlightSet.has(n)} />
                          </TableCell>
                        ))}
                        <TableCell align="center" sx={{ p: 0.5 }}>
                          <LottoBall number={row.bonus} size={ENGINE_BALL.list} dimmed={!highlightSet.has(row.bonus)} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            ) : (
              <Alert severity="info" sx={{ py: 0.5 }}>
                조건에 맞는 평행회차가 없습니다. 검색/필터를 조정하세요.
              </Alert>
            )}
          </EngineSubBlock>

          {data.travel_highlights.length > 0 && (
            <EngineSubBlock tone="secondary" title="C. 연속 평행 출현 (경로)">
              <Stack direction="row" flexWrap="wrap" gap={0.5} useFlexGap>
                {data.travel_highlights.map((item) => (
                  <EngineStatusChip
                    key={`travel-${item.number}`}
                    variant="outlined"
                    color="secondary"
                    label={`${item.number} · ${item.appearances.map((a) => a.round).join('→')}`}
                  />
                ))}
              </Stack>
            </EngineSubBlock>
          )}
        </Stack>
      )}
    </EngineSection>
  );
}
