import {
  Alert,
  Box,
  Chip,
  LinearProgress,
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
import LottoBall from './LottoBall';
import { ENGINE_BALL, EngineSection, EngineStatusChip } from './EngineSection';
import { ValidationGatesBlock } from './ExplainArtifactBlock';
import { v1Api } from '../api/v1Api';

/**
 * Nested CV 읽기 전용 패널 — outer mean_top6 vs baseline.
 * scoring_allowed=false 고정 (점수·히어로 미연결).
 */
export default function NestedCvPanel() {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['v1-photo-nested-cv'],
    queryFn: () => v1Api.getNestedCv(42),
    staleTime: 300_000,
    retry: 1,
  });

  /** Gate 교차 링크 — Feature 학습 요약(읽기 전용). Nested 자체는 Gate 미승격. */
  const featureQ = useQuery({
    queryKey: ['v1-photo-feature-learning', 'current_round'],
    queryFn: () => v1Api.getFeatureLearning(42, { applyIntent: 'current_round' }),
    staleTime: 300_000,
    retry: 1,
    enabled: open,
  });

  if (q.isLoading) {
    return (
      <EngineSection tone="info" title="Validation · Nested CV" id="learn-nested-cv" sx={{ mb: 2 }}>
        <LinearProgress />
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          Outer/Inner fold 집계 중…
        </Typography>
      </EngineSection>
    );
  }

  if (q.isError) {
    return (
      <EngineSection tone="info" title="Validation · Nested CV" id="learn-nested-cv" sx={{ mb: 2 }}>
        <Alert severity="error">
          Nested CV를 불러오지 못했습니다:{' '}
          {q.error instanceof Error ? q.error.message : '서버 오류'}
        </Alert>
      </EngineSection>
    );
  }

  const d = q.data;
  if (!d) return null;

  if (!d.ok) {
    return (
      <EngineSection
        tone="info"
        title="Validation · Nested CV"
        id="learn-nested-cv"
        collapsible
        open={open}
        onToggle={() => setOpen((v) => !v)}
        defaultOpen={false}
        sx={{ mb: 2 }}
      >
        <Alert severity="info">{d.reason ?? 'Nested CV 표본이 부족합니다.'}</Alert>
      </EngineSection>
    );
  }

  const mean = d.mean_top6;
  const baseline = d.baseline_top6 ?? 0.8;
  const models = d.picked_models ?? [];
  const outer = d.outer_folds ?? 0;
  const stable = outer >= 5 && !d.small_sample;

  return (
    <EngineSection
      tone="info"
      title={`Validation · Nested CV (outer ${outer})`}
      id="learn-nested-cv"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      defaultOpen={false}
      sx={{ mb: 2 }}
      chips={
        <>
          <EngineStatusChip
            color={d.scoring_allowed ? 'warning' : 'success'}
            label={d.scoring_allowed ? 'scoring?' : '점수 미연결'}
          />
          <EngineStatusChip
            color={stable ? 'success' : 'warning'}
            label={stable ? 'outer≥5 안정' : '소표본/불안정'}
          />
          <EngineStatusChip
            variant="outlined"
            label={
              mean != null
                ? `mean_top6 ${mean.toFixed(2)} / base ${baseline}`
                : `base ${baseline}`
            }
          />
        </>
      }
      intent={
        <>
          Outer fold에서 채택 Feature로 top6 hits를 집계합니다. Gate·사람 승인 전{' '}
          <strong>scoring에 쓰지 않습니다</strong>. Feature Gate 요약은 아래 교차 링크입니다.
        </>
      }
    >
      {d.honesty && (
        <Alert severity="warning" sx={{ mb: 1.5, py: 0.5 }}>
          <Typography variant="caption">{d.honesty}</Typography>
        </Alert>
      )}
      {stable ? (
        <Alert severity="success" sx={{ mb: 1, py: 0.5 }} icon={false}>
          <Typography variant="caption">
            outer folds ≥ 5 — 안정성 기준 충족(표시용). Gate 승격·scoring 허용은 별도 사람 승인.
          </Typography>
        </Alert>
      ) : (
        <Alert severity="info" sx={{ mb: 1, py: 0.5 }} icon={false}>
          <Typography variant="caption">
            outer &lt; 5 또는 small_sample — Nested 결과를 Gate/점수에 올리지 마세요.
          </Typography>
        </Alert>
      )}
      {d.note && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1, fontSize: 10 }}>
          {d.note}
        </Typography>
      )}
      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        <Chip
          size="small"
          label={`lift_vs_uniform ${d.lift_vs_uniform ?? '—'}`}
          sx={{ height: 20, fontSize: 10 }}
        />
        <Chip
          size="small"
          label={`lift_vs_baseline_hits ${d.lift_vs_baseline_hits ?? '—'}`}
          sx={{ height: 20, fontSize: 10 }}
        />
        <Chip
          size="small"
          variant="outlined"
          label={`inner ${d.inner_folds ?? '—'}`}
          sx={{ height: 20, fontSize: 10 }}
        />
      </Stack>

      <ValidationGatesBlock gates={featureQ.data?.validation_gates} />

      {models.length === 0 ? (
        <Alert severity="info" sx={{ py: 0.5 }}>
          <Typography variant="caption">outer fold 결과가 없습니다.</Typography>
        </Alert>
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontSize: 10, fontWeight: 800, py: 0.5 }}>outer</TableCell>
                <TableCell sx={{ fontSize: 10, fontWeight: 800, py: 0.5 }}>hits</TableCell>
                <TableCell sx={{ fontSize: 10, fontWeight: 800, py: 0.5 }}>top6</TableCell>
                <TableCell sx={{ fontSize: 10, fontWeight: 800, py: 0.5 }}>당첨</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {models.map((m) => (
                <TableRow key={`outer-${m.outer_test_index}-${m.outer_round_no}`}>
                  <TableCell sx={{ fontSize: 10, py: 0.5, whiteSpace: 'nowrap' }}>
                    #{m.outer_test_index} · {m.outer_round_no}회 · 채택 {m.adopted_count}
                  </TableCell>
                  <TableCell sx={{ fontSize: 10, py: 0.5, fontWeight: 700 }}>
                    {m.top6_hits}/6
                  </TableCell>
                  <TableCell sx={{ py: 0.5 }}>
                    <Stack direction="row" spacing={0.25} flexWrap="wrap" useFlexGap>
                      {(m.top6 ?? []).map((n) => (
                        <LottoBall
                          key={`ncv-${m.outer_round_no}-${n}`}
                          number={n}
                          size={ENGINE_BALL.table}
                          dimmed={!m.winning?.includes(n)}
                        />
                      ))}
                    </Stack>
                  </TableCell>
                  <TableCell sx={{ py: 0.5 }}>
                    <Stack direction="row" spacing={0.25} flexWrap="wrap" useFlexGap>
                      {(m.winning ?? []).map((n) => (
                        <LottoBall
                          key={`ncv-w-${m.outer_round_no}-${n}`}
                          number={n}
                          size={ENGINE_BALL.table}
                        />
                      ))}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
    </EngineSection>
  );
}
