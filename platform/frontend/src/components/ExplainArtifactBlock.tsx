import { Alert, Box, Chip, Stack, Typography } from '@mui/material';
import type { ExplainPayload, ValidationGatesSummary } from '../api/v1Api';

const EXPERIMENTAL_DEFAULT =
  'Experimental — 점수·히어로·validatedLearning에 연결되지 않습니다. 당첨 확률(1/8,145,060)은 변하지 않습니다.';

/** decision과 무관 — Experimental Artifact 결과 배너. */
export function ExperimentalBanner({
  show,
  label,
}: {
  show?: boolean;
  label?: string;
}) {
  if (!show) return null;
  return (
    <Alert severity="warning" sx={{ mb: 1.5, py: 0.5 }} icon={false}>
      <Typography variant="caption" fontWeight={700} sx={{ display: 'block' }}>
        Experimental
      </Typography>
      <Typography variant="caption">{label ?? EXPERIMENTAL_DEFAULT}</Typography>
    </Alert>
  );
}

/** Explain Artifact 표준 블록 — Review/Feature/Pattern/Round/Overlap 공용. */
export function ExplainArtifactBlock({
  explain,
  title,
}: {
  explain?: ExplainPayload | null;
  title?: string;
}) {
  if (!explain) return null;
  const isExp =
    Boolean(explain.experimental) ||
    (explain.used_data?.artifact_versions ?? []).some((v) => /experimental/i.test(v));
  const heading = title ?? `Explain — ${explain.decision}`;
  return (
    <Box
      sx={{
        mb: 1.5,
        p: 1.25,
        borderRadius: 1,
        border: '1px dashed',
        borderColor: isExp ? 'warning.main' : 'info.main',
      }}
    >
      <ExperimentalBanner show={isExp} />
      <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
        {heading}
        {isExp ? ' · 실험' : ''}
      </Typography>
      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
        {isExp && (
          <Chip size="small" color="warning" label="점수 미연결" sx={{ height: 18, fontSize: 9.5, fontWeight: 700 }} />
        )}
        <Chip
          size="small"
          color={explain.confidence.overall >= 40 ? 'success' : 'default'}
          label={`신뢰도 ${explain.confidence.overall}/100`}
          sx={{ height: 18, fontSize: 9.5, fontWeight: 700 }}
        />
        <Chip
          size="small"
          variant="outlined"
          label={`백테스트 ${explain.confidence.backtest}/100`}
          sx={{ height: 18, fontSize: 9.5 }}
        />
        {(explain.algorithms ?? []).slice(0, 4).map((a) => (
          <Chip key={a} size="small" variant="outlined" label={a} sx={{ height: 18, fontSize: 9 }} />
        ))}
        {explain.backtest?.small_sample && (
          <Chip size="small" color="warning" label="소표본" sx={{ height: 18, fontSize: 9.5, fontWeight: 700 }} />
        )}
      </Stack>
      {(explain.evidence?.length ?? 0) > 0 && (
        <Stack spacing={0.2} sx={{ mb: 0.5 }}>
          {explain.evidence.map((e, i) => (
            <Typography key={`${e.kind}-${i}`} variant="caption" sx={{ fontSize: 9.5, color: 'text.secondary' }}>
              · [{e.kind}] {e.detail}
            </Typography>
          ))}
        </Stack>
      )}
      {explain.backtest?.metric && (
        <Typography variant="caption" sx={{ display: 'block', fontSize: 9.5, mb: 0.3 }}>
          {explain.backtest.metric}={explain.backtest.value ?? '—'}
          {explain.backtest.baseline != null ? ` (무작위≈${explain.backtest.baseline})` : ''}
          {(explain.used_data?.rounds?.length ?? 0) > 0
            ? ` · 회차 ${explain.used_data.rounds.length}개`
            : ''}
        </Typography>
      )}
      {(explain.limits?.length ?? 0) > 0 && (
        <Typography variant="caption" color="warning.main" sx={{ display: 'block', fontSize: 9.5 }}>
          한계: {explain.limits.slice(0, 3).join(' · ')}
        </Typography>
      )}
      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', fontSize: 9, mt: 0.4, fontStyle: 'italic' }}>
        ⚠️ {explain.honesty}
      </Typography>
    </Box>
  );
}

/** Validation Gate 요약 — scoring_allowed / demo 차단 표시. */
export function ValidationGatesBlock({
  gates,
}: {
  gates?: ValidationGatesSummary | null;
}) {
  if (!gates || !gates.count) return null;
  const allowed = gates.scoring_allowed_ids?.length ?? 0;
  const passed = gates.passed?.length ?? 0;
  const rejected = gates.rejected?.length ?? 0;
  return (
    <Box sx={{ mb: 1.5, p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
      <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.4 }}>
        Validation Gate
      </Typography>
      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
        <Chip
          size="small"
          color={allowed > 0 ? 'success' : 'default'}
          label={`scoring 허용 ${allowed}`}
          sx={{ height: 18, fontSize: 9.5, fontWeight: 700 }}
        />
        <Chip size="small" variant="outlined" label={`통과 ${passed}`} sx={{ height: 18, fontSize: 9 }} />
        <Chip size="small" variant="outlined" label={`거절 ${rejected}`} sx={{ height: 18, fontSize: 9 }} />
        {gates.demo_blocked && (
          <Chip
            size="small"
            color="warning"
            label="demo 차단 — forward 점수 미주입"
            sx={{ height: 18, fontSize: 9.5, fontWeight: 700 }}
          />
        )}
      </Stack>
      {allowed > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.4, fontSize: 9 }}>
          허용: {gates.scoring_allowed_ids!.slice(0, 6).join(', ')}
          {gates.scoring_allowed_ids!.length > 6 ? '…' : ''}
        </Typography>
      )}
    </Box>
  );
}
