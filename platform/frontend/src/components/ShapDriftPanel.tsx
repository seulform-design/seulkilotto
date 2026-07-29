import {
  Alert,
  Box,
  Chip,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ENGINE_BALL, EngineSection, EngineStatusChip } from './EngineSection';
import { ExperimentalBanner, ExplainArtifactBlock } from './ExplainArtifactBlock';
import { v1Api } from '../api/v1Api';

/**
 * Experimental SHAP/Drift 패널 — Feature 기여도 proxy + drift alert.
 * scoring_allowed=false 고정.
 */
export default function ShapDriftPanel() {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['v1-photo-shap-drift'],
    queryFn: () => v1Api.getShapDrift(42),
    staleTime: 300_000,
    retry: 1,
  });

  const ranked = useMemo(() => {
    const values = q.data?.shap?.values ?? {};
    return Object.entries(values)
      .map(([key, value]) => ({
        key,
        value,
        label: q.data?.shap?.labels?.[key] ?? key,
      }))
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  }, [q.data]);

  const maxAbs = Math.max(0.001, ...ranked.map((r) => Math.abs(r.value)));

  if (q.isLoading) {
    return (
      <EngineSection tone="warning" title="Experimental · SHAP/Drift" id="learn-shap-drift" sx={{ mb: 2 }}>
        <LinearProgress />
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          permutation proxy · drift 계산 중…
        </Typography>
      </EngineSection>
    );
  }

  if (q.isError) {
    return (
      <EngineSection tone="warning" title="Experimental · SHAP/Drift" id="learn-shap-drift" sx={{ mb: 2 }}>
        <Alert severity="error">
          SHAP/Drift를 불러오지 못했습니다:{' '}
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
        tone="warning"
        title="Experimental · SHAP/Drift"
        id="learn-shap-drift"
        collapsible
        open={open}
        onToggle={() => setOpen((v) => !v)}
        defaultOpen={false}
        sx={{ mb: 2 }}
      >
        <ExperimentalBanner show />
        <Alert severity="info">{d.reason ?? '표본이 부족합니다.'}</Alert>
      </EngineSection>
    );
  }

  return (
    <EngineSection
      tone="warning"
      title={`Experimental · SHAP/Drift (${d.model_id ?? 'proxy'})`}
      id="learn-shap-drift"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      defaultOpen={false}
      sx={{ mb: 2 }}
      chips={
        <>
          <EngineStatusChip color="warning" label="Experimental" />
          <EngineStatusChip
            color={d.scoring_allowed ? 'error' : 'success'}
            label={d.scoring_allowed ? 'scoring?' : '점수 미연결'}
          />
          {d.drift?.alert && <EngineStatusChip color="error" label="drift alert" />}
          {d.shap?.small_sample && <EngineStatusChip color="warning" label="소표본" />}
        </>
      }
      intent={
        <>
          permutation proxy SHAP · early/late drift. 점수·히어로·validatedLearning에{' '}
          <strong>연결되지 않습니다</strong>.
        </>
      }
    >
      <ExperimentalBanner show={d.experimental !== false} />
      {d.honesty && (
        <Alert severity="warning" sx={{ mb: 1.5, py: 0.5 }}>
          <Typography variant="caption">{d.honesty}</Typography>
        </Alert>
      )}
      <ExplainArtifactBlock explain={d.explain} title="Explain — SHAP/Drift" />

      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        <Chip
          size="small"
          label={`method ${d.shap?.method ?? '—'}`}
          sx={{ height: 20, fontSize: 10 }}
        />
        <Chip
          size="small"
          color={d.drift?.alert ? 'error' : 'default'}
          label={`drift ${d.drift?.score ?? '—'} (${d.drift?.metric ?? ''})`}
          sx={{ height: 20, fontSize: 10 }}
        />
      </Stack>

      {ranked.length === 0 ? (
        <Alert severity="info" sx={{ py: 0.5 }}>
          <Typography variant="caption">SHAP 값이 없습니다.</Typography>
        </Alert>
      ) : (
        <Stack spacing={0.5} sx={{ mb: 1 }}>
          <Typography variant="caption" fontWeight={800} sx={{ fontSize: 10 }}>
            Feature 기여도 proxy (상위 {Math.min(12, ranked.length)})
          </Typography>
          {ranked.slice(0, 12).map((r) => (
            <Stack key={r.key} direction="row" alignItems="center" spacing={0.75}>
              <Typography
                variant="caption"
                sx={{ minWidth: 120, fontSize: 10, fontWeight: 700 }}
                noWrap
                title={r.key}
              >
                {r.label}
              </Typography>
              <Box
                sx={{
                  flex: 1,
                  height: ENGINE_BALL.table / 2,
                  borderRadius: 0.5,
                  bgcolor: 'action.hover',
                  overflow: 'hidden',
                }}
              >
                <Box
                  sx={{
                    width: `${(Math.abs(r.value) / maxAbs) * 100}%`,
                    height: '100%',
                    bgcolor: r.value >= 0 ? 'success.main' : 'error.main',
                    opacity: 0.75,
                  }}
                />
              </Box>
              <Typography variant="caption" sx={{ minWidth: 40, fontSize: 10, textAlign: 'right' }}>
                {r.value.toFixed(3)}
              </Typography>
            </Stack>
          ))}
        </Stack>
      )}
    </EngineSection>
  );
}
