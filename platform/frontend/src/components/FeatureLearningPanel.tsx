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
import { v1Api, type FeatureLearningFeatureReport } from '../api/v1Api';

/**
 * 복기 Feature 자동 생성·검증·학습 패널.
 * 검증 통과 Feature 만 추천에 쓰고, Random 대비 지표·기여도를 함께 표시한다.
 */
export default function FeatureLearningPanel() {
  const [showRejected, setShowRejected] = useState(false);
  const [expandedNumber, setExpandedNumber] = useState<number | null>(null);

  const q = useQuery({
    queryKey: ['v1-photo-feature-learning'],
    queryFn: () => v1Api.getFeatureLearning(42),
    staleTime: 300_000,
    retry: 1,
  });

  const adopted = useMemo(
    () => (q.data?.features ?? []).filter((f) => f.adopted),
    [q.data?.features],
  );
  const rejected = useMemo(
    () => (q.data?.features ?? []).filter((f) => !f.adopted),
    [q.data?.features],
  );

  if (q.isLoading) {
    return (
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 1 }}>
          🧠 복기 Feature 학습 엔진
        </Typography>
        <LinearProgress />
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          Feature 생성 · Walk-Forward / Bootstrap / Permutation / Monte Carlo 검증 중…
        </Typography>
      </Paper>
    );
  }

  if (q.isError) {
    return (
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 0.5 }}>
          🧠 복기 Feature 학습 엔진
        </Typography>
        <Alert severity="error">
          학습 엔진을 불러오지 못했습니다:{' '}
          {q.error instanceof Error ? q.error.message : '서버 오류'}
        </Alert>
      </Paper>
    );
  }

  const d = q.data;
  if (!d) return null;

  if (!d.ok) {
    return (
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 0.5 }}>
          🧠 복기 Feature 학습 엔진
        </Typography>
        <Alert severity="info">{d.reason ?? '학습할 보관 회차가 아직 없습니다.'}</Alert>
      </Paper>
    );
  }

  const rec = d.recommendation;
  const ensemble = d.ensemble;

  return (
    <Paper sx={{ p: 2, mb: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
        <Typography variant="subtitle1" fontWeight={800}>
          🧠 복기 Feature 학습 엔진 ({d.round_count}개 회차)
        </Typography>
        <Chip
          size="small"
          color={adopted.length > 0 ? 'success' : 'default'}
          label={`채택 ${d.adopted_count ?? adopted.length} · 제외 ${d.rejected_count ?? rejected.length}`}
          sx={{ height: 20, fontSize: 11, fontWeight: 700 }}
        />
        {d.baselines && (
          <Chip
            size="small"
            variant="outlined"
            label={`Random 기준 top6≈${d.baselines.uniform_top6_hits}`}
            sx={{ height: 20, fontSize: 10 }}
          />
        )}
      </Stack>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        추첨 <strong>전</strong> 보관 용지만으로 Feature 를 만들고, Walk-Forward · Bootstrap ·
        Permutation · Monte Carlo · Time-Split 으로 검증합니다. Random 보다 일관된 향상이
        재현되지 않으면 폐기하고, 통과한 Feature 만 추천·기여도에 반영합니다.
      </Typography>

      {d.honesty && (
        <Alert severity="warning" sx={{ mb: 1.5, py: 0.5 }}>
          <Typography variant="caption">{d.honesty}</Typography>
        </Alert>
      )}

      {/* 파이프라인 */}
      {d.pipeline && (
        <Stack direction="row" flexWrap="wrap" gap={0.5} sx={{ mb: 1.5 }}>
          {d.pipeline.map((step) => (
            <Chip key={step} size="small" label={step} sx={{ height: 22, fontSize: 10 }} />
          ))}
        </Stack>
      )}

      {/* 회차 데이터셋 */}
      {d.dataset?.rounds && d.dataset.rounds.length > 0 && (
        <Box sx={{ mb: 1.5 }}>
          <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
            Feature Dataset ({d.dataset.sample_rows}행 · {d.dataset.feature_count}개 Feature)
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
          {d.dataset.excluded_sources?.length ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              학습 제외: {d.dataset.excluded_sources.join(', ')}
            </Typography>
          ) : null}
        </Box>
      )}

      {/* 채택 Feature */}
      <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
        검증 통과 Feature ({adopted.length})
      </Typography>
      {adopted.length === 0 ? (
        <Alert severity="info" sx={{ mb: 1.5, py: 0.5 }}>
          <Typography variant="caption">
            현재 표본에서 Random 대비 재현 가능한 Feature 가 없습니다. 회차가 쌓이면 자동으로
            재검증됩니다. 검증 미통과 Feature 는 추천에 반영하지 않습니다.
          </Typography>
        </Alert>
      ) : (
        <FeatureTable rows={adopted} sx={{ mb: 1.5 }} />
      )}

      {/* 제외 Feature (접기) */}
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <Typography variant="caption" fontWeight={800}>
          제외된 Feature ({rejected.length})
        </Typography>
        <Button size="small" onClick={() => setShowRejected((v) => !v)} sx={{ minWidth: 0, py: 0 }}>
          {showRejected ? '접기' : '펼치기'}
        </Button>
      </Stack>
      <Collapse in={showRejected}>
        <FeatureTable rows={rejected.slice(0, 40)} dense />
      </Collapse>

      {/* 앙상블 */}
      {ensemble && (
        <Box sx={{ mt: 1.5, mb: 1.5 }}>
          <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
            앙상블 실험
            {ensemble.selected ? ` · 유지: ${ensemble.selected}` : ' · 유지 모델 없음'}
          </Typography>
          {!ensemble.ok ? (
            <Typography variant="caption" color="text.secondary">
              {ensemble.reason}
            </Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>모델</TableCell>
                  <TableCell align="right">WF 평균 적중</TableCell>
                  <TableCell align="right">Lift</TableCell>
                  <TableCell align="right">Fold</TableCell>
                  <TableCell>상태</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(ensemble.models ?? []).map((m) => (
                  <TableRow key={m.name} selected={m.name === ensemble.selected}>
                    <TableCell sx={{ fontWeight: m.name === ensemble.selected ? 800 : 500 }}>{m.name}</TableCell>
                    <TableCell align="right">{m.walk_forward_mean_hits.toFixed(2)}</TableCell>
                    <TableCell align="right">{m.lift_vs_uniform.toFixed(2)}</TableCell>
                    <TableCell align="right">{m.folds}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        color={m.stable ? 'success' : 'default'}
                        label={m.stable ? '안정' : '미달'}
                        sx={{ height: 18, fontSize: 10 }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {ensemble.note && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              {ensemble.note}
            </Typography>
          )}
        </Box>
      )}

      {/* 추천 + 기여도 */}
      <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
        검증 Feature 기반 번호 점수 · 기여도
        {rec?.source && rec.source !== 'current_round' ? ` (${rec.source})` : ''}
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
              <LottoBall key={`top6-${n}`} number={n} size={28} />
            ))}
            <Chip
              size="small"
              label={`채택 Feature ${rec.adopted_feature_count ?? 0}개`}
              sx={{ height: 20, fontSize: 10 }}
            />
          </Stack>
          <Stack spacing={0.5}>
            {(rec.numbers ?? []).slice(0, 12).map((row) => {
              const open = expandedNumber === row.number;
              return (
                <Box key={row.number} sx={{ p: 0.75, borderRadius: 1, bgcolor: 'action.hover' }}>
                  <Stack
                    direction="row"
                    alignItems="center"
                    spacing={1}
                    sx={{ cursor: 'pointer' }}
                    onClick={() => setExpandedNumber(open ? null : row.number)}
                  >
                    <LottoBall number={row.number} size={24} />
                    <Typography sx={{ fontWeight: 700, fontSize: 12, minWidth: 64 }}>
                      점수 {row.score.toFixed(3)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }} noWrap>
                      {(row.contributions ?? [])
                        .slice(0, 3)
                        .map((c) => `${c.label} ${c.contribution >= 0 ? '+' : ''}${c.contribution.toFixed(2)}`)
                        .join(' · ')}
                    </Typography>
                    <Typography variant="caption" color="primary.main">
                      {open ? '접기' : '기여도'}
                    </Typography>
                  </Stack>
                  <Collapse in={open}>
                    <Table size="small" sx={{ mt: 0.5 }}>
                      <TableHead>
                        <TableRow>
                          <TableCell>Feature</TableCell>
                          <TableCell align="right">기여도</TableCell>
                          <TableCell align="right">원값</TableCell>
                          <TableCell align="right">가중치</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {(row.contributions ?? []).map((c) => (
                          <TableRow key={c.feature}>
                            <TableCell sx={{ fontSize: 11 }}>{c.label}</TableCell>
                            <TableCell align="right" sx={{ fontSize: 11, fontWeight: 700 }}>
                              {c.contribution >= 0 ? '+' : ''}
                              {c.contribution.toFixed(3)}
                            </TableCell>
                            <TableCell align="right" sx={{ fontSize: 11 }}>
                              {c.raw_value}
                            </TableCell>
                            <TableCell align="right" sx={{ fontSize: 11 }}>
                              {c.weight.toFixed(3)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
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

function FeatureTable({
  rows,
  dense,
  sx,
}: {
  rows: FeatureLearningFeatureReport[];
  dense?: boolean;
  sx?: object;
}) {
  if (!rows.length) return null;
  return (
    <Box sx={{ overflowX: 'auto', ...sx }}>
      <Table size="small" stickyHeader sx={{ minWidth: dense ? 520 : 720 }}>
        <TableHead>
          <TableRow>
            <TableCell>Feature</TableCell>
            <TableCell align="right">WF</TableCell>
            <TableCell align="right">Lift</TableCell>
            <TableCell align="right">p(perm)</TableCell>
            <TableCell align="right">Boot CI</TableCell>
            <TableCell>판정</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((f) => (
            <TableRow key={f.key}>
              <TableCell sx={{ fontSize: 11, fontWeight: 600 }}>{f.label}</TableCell>
              <TableCell align="right" sx={{ fontSize: 11 }}>
                {f.walk_forward_mean_hits.toFixed(2)}
              </TableCell>
              <TableCell align="right" sx={{ fontSize: 11 }}>
                {f.lift_vs_uniform.toFixed(2)}
              </TableCell>
              <TableCell align="right" sx={{ fontSize: 11 }}>
                {f.permutation_p.toFixed(3)}
              </TableCell>
              <TableCell align="right" sx={{ fontSize: 10 }}>
                {f.bootstrap_ci95[0].toFixed(2)}–{f.bootstrap_ci95[1].toFixed(2)}
              </TableCell>
              <TableCell>
                <Chip
                  size="small"
                  color={f.adopted ? 'success' : 'default'}
                  label={f.adopted ? '채택' : (f.exclude_reason?.[0] ?? '제외').slice(0, 28)}
                  sx={{ height: 18, fontSize: 9, maxWidth: 180 }}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}
