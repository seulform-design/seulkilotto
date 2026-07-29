import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import { v1Api, type ValidationGatesSummary } from '../api/v1Api';

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

const UPGRADE_KEY_STORAGE = 'lotto:upgrade-api-key:v1';

type PendingAction = {
  kind: 'disable' | 'enable';
  modelId: string;
  reason: string;
};

/**
 * Model Registry — 감사 뷰 + 사람 승인 disable/enable.
 * 자동 scoring 변경 없음. confirm=true 필수.
 */
export function ModelRegistryBlock({
  gates,
  tournament,
  selected,
  orchestrator,
  modelRegistry,
  title = 'Model Registry',
  onChanged,
}: {
  gates?: ValidationGatesSummary | null;
  tournament?: TournamentModelRow[] | null;
  selected?: string | null;
  orchestrator?: { candidates?: OrchestratorCandidate[]; auto_mutate_scoring?: boolean } | null;
  modelRegistry?: { disabled_ids?: string[]; honesty?: string } | null;
  title?: string;
  onChanged?: () => void;
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

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [reason, setReason] = useState('');
  const [upgradeKey, setUpgradeKey] = useState(() => {
    try {
      return window.localStorage.getItem(UPGRADE_KEY_STORAGE) ?? '';
    } catch {
      return '';
    }
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const openDisable = (modelId: string, defaultReason: string) => {
    setErr(null);
    setOkMsg(null);
    setPending({ kind: 'disable', modelId, reason: defaultReason });
    setReason(defaultReason || 'human_disable');
    setConfirmText('');
  };

  const openEnable = (modelId: string) => {
    setErr(null);
    setOkMsg(null);
    setPending({ kind: 'enable', modelId, reason: 'human_enable' });
    setReason('human_enable');
    setConfirmText('');
  };

  const submit = async () => {
    if (!pending) return;
    if (confirmText.trim().toLowerCase() !== 'confirm') {
      setErr('확인란에 confirm 을 입력하세요.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (upgradeKey) {
        try {
          window.localStorage.setItem(UPGRADE_KEY_STORAGE, upgradeKey);
        } catch {
          /* ignore */
        }
      }
      const body = {
        model_id: pending.modelId,
        reason: reason || pending.reason,
        confirm: true,
        by: 'operator-ui',
      };
      const res =
        pending.kind === 'disable'
          ? await v1Api.postModelRegistryDisable(body, upgradeKey || undefined)
          : await v1Api.postModelRegistryEnable(body, upgradeKey || undefined);
      if (!res.ok) {
        setErr(res.error ?? '실패');
        return;
      }
      setOkMsg(
        pending.kind === 'disable'
          ? `${pending.modelId} 비활성 완료`
          : `${pending.modelId} 재활성 완료`,
      );
      setPending(null);
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '요청 실패');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ mb: 1.5, p: 1.25, borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
      <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
        {title}
      </Typography>
      <Alert severity="info" sx={{ mb: 1, py: 0.4 }}>
        <Typography variant="caption">
          Rollback·토너먼트는 감사 뷰입니다. 비활성은 <strong>사람 확인(confirm)</strong> 후에만
          적용되며 자동 scoring 변경은 없습니다.
        </Typography>
      </Alert>
      {okMsg && (
        <Alert severity="success" sx={{ mb: 1, py: 0.4 }} onClose={() => setOkMsg(null)}>
          <Typography variant="caption">{okMsg}</Typography>
        </Alert>
      )}

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
          <Stack spacing={0.35}>
            {disabledIds.slice(0, 12).map((id) => (
              <Stack key={id} direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="caption" color="warning.main" sx={{ fontSize: 9.5 }}>
                  {id}
                </Typography>
                <Button size="small" variant="outlined" onClick={() => openEnable(id)} sx={{ minWidth: 0, px: 0.75, py: 0, fontSize: 9 }}>
                  재활성
                </Button>
              </Stack>
            ))}
          </Stack>
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
            폐기 제안 (사람 확인 후 적용)
          </Typography>
          <Stack spacing={0.35}>
            {proposals.map((c) => (
              <Stack key={c.model_id} direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: 9, flex: 1, minWidth: 120 }}>
                  · {c.model_id}: {c.reason}
                </Typography>
                <Button
                  size="small"
                  color="warning"
                  variant="outlined"
                  disabled={disabledIds.includes(c.model_id)}
                  onClick={() => openDisable(c.model_id, c.reason)}
                  sx={{ minWidth: 0, px: 0.75, py: 0, fontSize: 9 }}
                >
                  {disabledIds.includes(c.model_id) ? '이미 비활성' : '비활성'}
                </Button>
              </Stack>
            ))}
          </Stack>
          {orchestrator?.auto_mutate_scoring === false && (
            <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.3, fontSize: 8.5 }}>
              자동 scoring 변경 없음
            </Typography>
          )}
        </Box>
      )}

      <Dialog open={Boolean(pending)} onClose={() => !busy && setPending(null)} fullWidth maxWidth="xs">
        <DialogTitle sx={{ fontSize: 16, fontWeight: 800 }}>
          {pending?.kind === 'disable' ? 'Model 비활성 확인' : 'Model 재활성 확인'}
        </DialogTitle>
        <DialogContent>
          <Typography variant="caption" sx={{ display: 'block', mb: 1 }}>
            대상: <strong>{pending?.modelId}</strong>
          </Typography>
          <TextField
            fullWidth
            size="small"
            label="사유"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            sx={{ mb: 1.25 }}
          />
          <TextField
            fullWidth
            size="small"
            label="확인 (confirm 입력)"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            sx={{ mb: 1.25 }}
            helperText="실수 방지 — 정확히 confirm"
          />
          <TextField
            fullWidth
            size="small"
            type="password"
            label="X-Upgrade-Key (서버에 키가 설정된 경우)"
            value={upgradeKey}
            onChange={(e) => setUpgradeKey(e.target.value)}
            autoComplete="off"
          />
          {err && (
            <Alert severity="error" sx={{ mt: 1, py: 0.4 }}>
              <Typography variant="caption">{err}</Typography>
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPending(null)} disabled={busy}>
            취소
          </Button>
          <Button
            variant="contained"
            color={pending?.kind === 'disable' ? 'warning' : 'primary'}
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? '처리 중…' : pending?.kind === 'disable' ? '비활성 적용' : '재활성 적용'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
