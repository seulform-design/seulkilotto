import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  LinearProgress,
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
import { useMemo, useState } from 'react';
import LottoBall from './LottoBall';
import { v1Api, type PatternMiningResponse } from '../api/v1Api';

/**
 * 복기 Pattern Mining 엔진 UI.
 * 검증 통과 Pattern · Cluster · Feature · 설명가능 추천을 표시한다.
 */
export default function PatternMiningPanel() {
  const [showRejected, setShowRejected] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['v1-photo-pattern-mining'],
    queryFn: () => v1Api.getPatternMining(42),
    staleTime: 300_000,
    retry: 1,
  });

  const adopted = useMemo(
    () => q.data?.adopted_patterns ?? q.data?.patterns?.filter((p) => p.adopted) ?? [],
    [q.data],
  );
  const rejected = useMemo(
    () => (q.data?.patterns ?? []).filter((p) => !p.adopted).slice(0, 40),
    [q.data],
  );

  if (q.isLoading) {
    return (
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 1 }}>
          🔍 복기 Pattern Mining 엔진
        </Typography>
        <LinearProgress />
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          전수 학습 · Pattern 탐색 · WF/Rolling/Time-Split 검증 · Cluster · Feature 선택 중…
        </Typography>
      </Paper>
    );
  }

  if (q.isError) {
    return (
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 0.5 }}>
          🔍 복기 Pattern Mining 엔진
        </Typography>
        <Alert severity="error">
          엔진을 불러오지 못했습니다: {q.error instanceof Error ? q.error.message : '서버 오류'}
        </Alert>
      </Paper>
    );
  }

  const d = q.data as PatternMiningResponse | undefined;
  if (!d) return null;
  if (!d.ok) {
    return (
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 0.5 }}>
          🔍 복기 Pattern Mining 엔진
        </Typography>
        <Alert severity="info">{d.reason ?? '학습할 보관 회차가 없습니다.'}</Alert>
      </Paper>
    );
  }

  const rec = d.recommendation;

  return (
    <Paper sx={{ p: 2, mb: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
        <Typography variant="subtitle1" fontWeight={800}>
          🔍 복기 Pattern Mining 엔진 ({d.round_count}개 회차)
        </Typography>
        <Chip
          size="small"
          color={(d.adopted_count ?? 0) > 0 ? 'success' : 'default'}
          label={`Pattern ${d.pattern_count} · 채택 ${d.adopted_count} · 제외 ${d.rejected_count}`}
          sx={{ height: 20, fontSize: 11, fontWeight: 700 }}
        />
      </Stack>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        자동·반자동·매치카드·강한후보·간격·구간배치를 <strong>전수 학습</strong>해 Pattern 을 자동
        생성하고, Walk-Forward / Rolling / Time-Split / Backtest 로 검증합니다. 검증 통과분만
        추천하며, 각 번호에 Pattern·Cluster·기여도를 함께 표시합니다.
      </Typography>

      {d.honesty && (
        <Alert severity="warning" sx={{ mb: 1.5, py: 0.5 }}>
          <Typography variant="caption">{d.honesty}</Typography>
        </Alert>
      )}

      {d.pipeline && (
        <Stack direction="row" flexWrap="wrap" gap={0.5} sx={{ mb: 1.5 }}>
          {d.pipeline.map((step) => (
            <Chip key={step} size="small" label={step} sx={{ height: 22, fontSize: 10 }} />
          ))}
        </Stack>
      )}

      {/* Dataset */}
      {d.dataset?.rounds && (
        <Box sx={{ mb: 1.5 }}>
          <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
            학습 Dataset
          </Typography>
          <Stack spacing={0.4}>
            {d.dataset.rounds.map((r) => (
              <Stack
                key={r.round_no}
                direction="row"
                spacing={0.75}
                alignItems="center"
                flexWrap="wrap"
                useFlexGap
                sx={{ p: 0.6, borderRadius: 1, bgcolor: 'action.hover' }}
              >
                <Typography sx={{ fontWeight: 800, fontSize: 12, minWidth: 52 }}>{r.round_no}회</Typography>
                <Chip
                  size="small"
                  variant="outlined"
                  label={`자동 ${r.auto_lines} · 반자동 ${r.semi_lines}`}
                  sx={{ height: 18, fontSize: 10 }}
                />
                {r.winning.map((n) => (
                  <LottoBall key={`${r.round_no}-w-${n}`} number={n} size={18} />
                ))}
              </Stack>
            ))}
          </Stack>
        </Box>
      )}

      {/* Adopted patterns */}
      <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
        검증 통과 Pattern ({adopted.length})
      </Typography>
      {adopted.length === 0 ? (
        <Alert severity="info" sx={{ mb: 1.5, py: 0.5 }}>
          <Typography variant="caption">
            현재 표본에서 Random 대비 재현 가능한 Pattern 이 없습니다. 회차가 쌓이면 호출 시마다
            자동 재탐색·재검증됩니다.
          </Typography>
        </Alert>
      ) : (
        <Box sx={{ overflowX: 'auto', mb: 1.5 }}>
          <Table size="small" stickyHeader sx={{ minWidth: 720 }}>
            <TableHead>
              <TableRow>
                <TableCell>Pattern</TableCell>
                <TableCell>종류</TableCell>
                <TableCell align="right">출현</TableCell>
                <TableCell align="right">WF</TableCell>
                <TableCell align="right">Lift</TableCell>
                <TableCell align="right">안정성</TableCell>
                <TableCell align="right">p</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {adopted.slice(0, 25).map((p) => (
                <TableRow key={p.id}>
                  <TableCell sx={{ fontSize: 11, fontWeight: 600 }}>{p.label}</TableCell>
                  <TableCell sx={{ fontSize: 10 }}>{p.kind}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 11 }}>
                    {p.appear_rounds}
                  </TableCell>
                  <TableCell align="right" sx={{ fontSize: 11 }}>
                    {p.wf_mean_hits.toFixed(2)}
                  </TableCell>
                  <TableCell align="right" sx={{ fontSize: 11 }}>
                    {p.lift_vs_baseline.toFixed(2)}
                  </TableCell>
                  <TableCell align="right" sx={{ fontSize: 11 }}>
                    {p.stability.toFixed(2)}
                  </TableCell>
                  <TableCell align="right" sx={{ fontSize: 11 }}>
                    {p.permutation_p.toFixed(3)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}

      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <Typography variant="caption" fontWeight={800}>
          제외 Pattern ({rejected.length}+)
        </Typography>
        <Button size="small" onClick={() => setShowRejected((v) => !v)} sx={{ minWidth: 0, py: 0 }}>
          {showRejected ? '접기' : '펼치기'}
        </Button>
      </Stack>
      <Collapse in={showRejected}>
        <Stack spacing={0.3} sx={{ mb: 1.5 }}>
          {rejected.map((p) => (
            <Typography key={p.id} variant="caption" color="text.secondary">
              {p.label} — {(p.exclude_reasons ?? [])[0] ?? '제외'}
            </Typography>
          ))}
        </Stack>
      </Collapse>

      {/* Clusters */}
      {(d.clusters?.length ?? 0) > 0 && (
        <Box sx={{ mb: 1.5 }}>
          <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
            Pattern Cluster
          </Typography>
          <Stack direction="row" flexWrap="wrap" gap={0.5}>
            {d.clusters!.slice(0, 12).map((c) => (
              <Chip
                key={c.cluster_id}
                size="small"
                color={c.adopted_count > 0 ? 'success' : 'default'}
                label={`${c.cluster_id} · ${c.size}개 · lift ${c.mean_lift}`}
                sx={{ height: 22, fontSize: 10 }}
              />
            ))}
          </Stack>
        </Box>
      )}

      {/* Feature selection */}
      {d.feature_selection?.ok && (
        <Box sx={{ mb: 1.5 }}>
          <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
            Feature Selection — 유지 {(d.feature_selection.kept ?? []).length} · 제거{' '}
            {(d.feature_selection.dropped ?? []).length}
          </Typography>
          <Stack direction="row" flexWrap="wrap" gap={0.5}>
            {(d.feature_selection.kept ?? []).map((f) => (
              <Chip key={f} size="small" color="primary" variant="outlined" label={f} sx={{ height: 20, fontSize: 10 }} />
            ))}
          </Stack>
        </Box>
      )}

      {/* Recommendation */}
      <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
        설명가능 추천{rec?.source && rec.source !== 'current_round' ? ` (${rec.source})` : ''}
      </Typography>
      {!rec?.ok ? (
        <Alert severity="info" sx={{ py: 0.5 }}>
          <Typography variant="caption">{rec?.reason ?? '추천 없음'}</Typography>
        </Alert>
      ) : (
        <>
          <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
            <Typography variant="caption" color="text.secondary">
              Top6
            </Typography>
            {(rec.top6 ?? []).map((n) => (
              <LottoBall key={`pm-top6-${n}`} number={n} size={28} />
            ))}
            <Chip
              size="small"
              label={`채택 Pattern ${rec.adopted_pattern_count ?? 0}`}
              sx={{ height: 20, fontSize: 10 }}
            />
          </Stack>
          <Stack spacing={0.5}>
            {(rec.numbers ?? []).slice(0, 12).map((row) => {
              const open = expanded === String(row.number);
              return (
                <Box key={row.number} sx={{ p: 0.75, borderRadius: 1, bgcolor: 'action.hover' }}>
                  <Stack
                    direction="row"
                    alignItems="center"
                    spacing={1}
                    sx={{ cursor: 'pointer' }}
                    onClick={() => setExpanded(open ? null : String(row.number))}
                  >
                    <LottoBall number={row.number} size={24} />
                    <Typography sx={{ fontWeight: 700, fontSize: 12, minWidth: 64 }}>
                      점수 {row.score.toFixed(2)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }} noWrap>
                      {(row.reasons ?? [])
                        .slice(0, 2)
                        .map((r) => r.pattern_label)
                        .join(' · ') || '근거 없음'}
                    </Typography>
                    <Typography variant="caption" color="primary.main">
                      {open ? '접기' : '근거'}
                    </Typography>
                  </Stack>
                  <Collapse in={open}>
                    <Table size="small" sx={{ mt: 0.5 }}>
                      <TableHead>
                        <TableRow>
                          <TableCell>Pattern</TableCell>
                          <TableCell>Cluster</TableCell>
                          <TableCell align="right">Lift</TableCell>
                          <TableCell align="right">안정성</TableCell>
                          <TableCell align="right">기여</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {(row.reasons ?? []).map((r) => (
                          <TableRow key={`${row.number}-${r.pattern_id}`}>
                            <TableCell sx={{ fontSize: 11 }}>{r.pattern_label}</TableCell>
                            <TableCell sx={{ fontSize: 11 }}>{r.cluster_id ?? '—'}</TableCell>
                            <TableCell align="right" sx={{ fontSize: 11 }}>
                              {r.lift.toFixed(2)}
                            </TableCell>
                            <TableCell align="right" sx={{ fontSize: 11 }}>
                              {r.stability.toFixed(2)}
                            </TableCell>
                            <TableCell align="right" sx={{ fontSize: 11, fontWeight: 700 }}>
                              {r.contribution.toFixed(3)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {row.features && Object.keys(row.features).length > 0 && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                        Features:{' '}
                        {Object.entries(row.features)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(' · ')}
                      </Typography>
                    )}
                  </Collapse>
                </Box>
              );
            })}
          </Stack>
          {rec.honesty && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              {rec.honesty}
            </Typography>
          )}
        </>
      )}
    </Paper>
  );
}
