import { Alert, Box, Chip, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import type { ValidationGatesSummary } from '../api/v1Api';

export type TournamentModelRow = {
  name: string;
  walk_forward_mean_hits?: number;
  lift_vs_uniform?: number;
  folds?: number;
  stable?: boolean;
};

export type OrchestratorCandidate = {
  model_id: string;
  action: string;
  reason: string;
  requires_human?: boolean;
  auto_applied?: boolean;
};

/**
 * Model Registry 표시 — Rollback/토너먼트는 **표시·감사**만.
 * 자동 가중·자동 비활성·점수 주입은 하지 않는다 (Validation gate 설계).
 */
export function ModelRegistryBlock({
  gates,
  tournament,
  selected,
  orchestrator,
  modelRegistry,
  title = 'Model Registry (표시전용)',
}: {
  gates?: ValidationGatesSummary | null;
  tournament?: TournamentModelRow[] | null;
  selected?: string | null;
  orchestrator?: { candidates?: OrchestratorCandidate[]; auto_mutate_scoring?: boolean } | null;
  modelRegistry?: { disabled_ids?: string[]; honesty?: string } | null;
  title?: string;
}) {
  const hasGates = Boolean(gates && gates.count > 0);
  const hasTour = Boolean(tournament && tournament.length > 0);
  const proposals = (orchestrator?.candidates ?? []).filter((c) => c.action === 'propose_disable').slice(0, 8);
  const hasOrch = proposals.length > 0;
  const disabledIds = modelRegistry?.disabled_ids ?? [];
  const hasDisabled = disabledIds.length > 0;
  if (!hasGates && !hasTour && !hasOrch && !hasDisabled) return null;

  const allowed = gates?.scoring_allowed_ids ?? [];
  const rejected = gates?.rejected ?? [];
  const archivedLike = rejected.slice(0, 12);

  return (
    <Box sx={{ mb: 1.5, p: 1.25, borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
      <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
        {title}
      </Typography>
      <Alert severity="info" sx={{ mb: 1, py: 0.4 }}>
        <Typography variant="caption">
          Rollback·토너먼트는 감사 뷰입니다. 자동으로 점수를 바꾸지 않으며,{' '}
          <strong>scoring 허용</strong> 목록만 forward 후보입니다. Experimental·demo 는 제외.
        </Typography>
      </Alert>

      {hasGates && (
        <Stack spacing={0.5} sx={{ mb: hasTour ? 1 : 0 }}>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
            <Chip
              size="small"
              color={allowed.length > 0 ? 'success' : 'default'}
              label={`활성(scoring) ${allowed.length}`}
              sx={{ height: 18, fontSize: 9.5, fontWeight: 700 }}
            />
            <Chip
              size="small"
              variant="outlined"
              label={`거절/아카이브 후보 ${rejected.length}`}
              sx={{ height: 18, fontSize: 9.5 }}
            />
            {gates!.demo_blocked && (
              <Chip size="small" color="warning" label="demo 차단" sx={{ height: 18, fontSize: 9.5, fontWeight: 700 }} />
            )}
          </Stack>
          {allowed.length > 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: 9 }}>
              활성: {allowed.slice(0, 8).join(', ')}
              {allowed.length > 8 ? '…' : ''}
            </Typography>
          )}
          {archivedLike.length > 0 && (
            <Typography variant="caption" color="text.disabled" sx={{ fontSize: 9 }}>
              거절(롤백 대상 아님·삭제 금지): {archivedLike.join(', ')}
              {rejected.length > 12 ? '…' : ''}
            </Typography>
          )}
        </Stack>
      )}

      {hasDisabled && (
        <Box sx={{ mb: hasTour || hasOrch ? 1 : 0 }}>
          <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.3 }}>
            사람 승인 비활성 ({disabledIds.length})
          </Typography>
          <Typography variant="caption" color="warning.main" sx={{ fontSize: 9 }}>
            {disabledIds.slice(0, 10).join(', ')}
            {disabledIds.length > 10 ? '…' : ''}
          </Typography>
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', fontSize: 8.5, mt: 0.2 }}>
            POST /model-registry/disable|enable + confirm + X-Upgrade-Key (자동 적용 없음)
          </Typography>
        </Box>
      )}

      {hasTour && (
        <>
          <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.4 }}>
            토너먼트 비교 (앙상블 실험 · 승자 자동 주입 없음)
            {selected ? ` · 표시 승자: ${selected}` : ''}
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontSize: 10 }}>모델</TableCell>
                <TableCell align="right" sx={{ fontSize: 10 }}>
                  WF
                </TableCell>
                <TableCell align="right" sx={{ fontSize: 10 }}>
                  Lift
                </TableCell>
                <TableCell sx={{ fontSize: 10 }}>역할</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {tournament!.map((m) => {
                const isSel = selected != null && m.name === selected;
                return (
                  <TableRow key={m.name} selected={isSel}>
                    <TableCell sx={{ fontSize: 11, fontWeight: isSel ? 800 : 500 }}>{m.name}</TableCell>
                    <TableCell align="right" sx={{ fontSize: 11 }}>
                      {(m.walk_forward_mean_hits ?? 0).toFixed(2)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontSize: 11 }}>
                      {(m.lift_vs_uniform ?? 0).toFixed(2)}
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        color={isSel ? 'success' : m.stable ? 'info' : 'default'}
                        label={isSel ? 'selected' : m.stable ? 'stable' : 'bench'}
                        sx={{ height: 18, fontSize: 9 }}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </>
      )}

      {hasOrch && (
        <Box sx={{ mt: 1 }}>
          <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.3 }}>
            폐기 제안 (사람 확인 전 · auto_applied=false)
          </Typography>
          <Stack spacing={0.2}>
            {proposals.map((c) => (
              <Typography key={c.model_id} variant="caption" color="text.secondary" sx={{ fontSize: 9 }}>
                · {c.model_id}: {c.reason}
              </Typography>
            ))}
          </Stack>
          {orchestrator?.auto_mutate_scoring === false && (
            <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.3, fontSize: 8.5 }}>
              자동 scoring 변경 없음
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
}
