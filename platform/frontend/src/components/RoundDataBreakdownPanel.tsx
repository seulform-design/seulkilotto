import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import { v1Api, type PhotoAnalysisAccumulated } from '../api/v1Api';
import { EngineSection, EngineStatusChip } from './EngineSection';
import { useConfirm } from './useConfirm';

/**
 * 🗂 회차별 용지 데이터 — ④ 엔진 · 검증 탭.
 *
 * 학습·복기검증·백테스트가 어떤 용지 출처를 쓰는지 정화하는 데이터 층.
 *  - 롤오버 보관분: 그 회차 이번회차 용지(추첨 시 동결) = 학습 정본
 *  - 복기 저장분: 저장 시점 최신 회차로 라벨링 → 실제 구매 회차와 다를 수 있음
 *  - 고아 복기: 보관과 줄 수 동일 → 중복으로 학습·표시 오염 → 삭제 대상
 */
function isOrphanReview(r: {
  review?: { auto_lines: number; semi_lines: number; entry_count: number } | null;
  archived?: { auto_lines: number; semi_lines: number; entry_count: number } | null;
  is_orphan_review?: boolean;
}): boolean {
  if (typeof r.is_orphan_review === 'boolean') return r.is_orphan_review;
  if (!r.review || !r.archived) return false;
  return (
    r.review.auto_lines === r.archived.auto_lines
    && r.review.semi_lines === r.archived.semi_lines
    && r.review.auto_lines + r.review.semi_lines > 0
  );
}

function isCoexist(r: {
  review?: unknown;
  archived?: unknown;
  is_coexist?: boolean;
  is_orphan_review?: boolean;
}): boolean {
  if (typeof r.is_coexist === 'boolean') return r.is_coexist;
  return Boolean(r.review && r.archived && !isOrphanReview(r as Parameters<typeof isOrphanReview>[0]));
}

export default function RoundDataBreakdownPanel({
  accumulated,
  onAccumulatedChange,
}: {
  accumulated: PhotoAnalysisAccumulated | null;
  onAccumulatedChange?: (acc: PhotoAnalysisAccumulated) => void;
}) {
  const { confirm, ConfirmDialog } = useConfirm();
  const rows = accumulated?.historical_dataset?.rounds_breakdown ?? [];
  const orphans = rows.filter(isOrphanReview);
  const conflicted = rows.filter(isCoexist);
  const [open, setOpen] = useState(orphans.length > 0);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [targetRound, setTargetRound] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (!rows.length) return null;

  const runReattribute = async (fromRound: string) => {
    const to = Number(targetRound);
    if (!Number.isInteger(to) || to < 1) {
      setNotice('교정할 회차 번호를 정확히 입력하세요.');
      return;
    }
    if (String(to) === String(fromRound)) {
      setNotice('현재 회차와 교정 회차가 같습니다.');
      return;
    }
    const ok = await confirm({
      message:
        `${fromRound}회로 기록된 복기 저장분을 ${to}회로 재귀속할까요?\n\n` +
        `• 회차 라벨만 교정되며 용지 줄은 삭제되지 않습니다.\n` +
        `• 롤오버 보관 정본은 변경되지 않습니다.\n` +
        `• 원래 회차(${fromRound})는 보존되어 되돌릴 수 있습니다.`,
      confirmText: `${to}회로 재귀속`,
    });
    if (!ok) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await v1Api.reattributeEntries(Number(fromRound), to);
      if (res.accumulated) onAccumulatedChange?.(res.accumulated);
      setNotice(`✅ ${res.changed}건을 ${fromRound}회 → ${to}회로 재귀속했습니다.`);
      setOpenFor(null);
      setTargetRound('');
    } catch (e) {
      setNotice(`❌ 재귀속 실패: ${e instanceof Error ? e.message : '서버 오류'}`);
    } finally {
      setBusy(false);
    }
  };

  const clearOrphanReviews = async () => {
    const orphanRounds = Array.from(
      new Set(orphans.map((r) => Number(r.ticket_round)).filter((n) => Number.isInteger(n) && n > 0)),
    );
    if (orphanRounds.length === 0) {
      setNotice('삭제할 고아 회차를 식별하지 못했습니다.');
      return;
    }
    const ok = await confirm({
      message:
        '보관 정본과 줄 수가 동일한 「고아 복기 저장분」을 삭제할까요?\n\n' +
        `대상 회차: ${orphanRounds.join(', ')}회 (이 회차만 삭제)\n` +
        '• 롤오버 보관 정본은 절대 삭제하지 않습니다.\n' +
        '• 다른 회차의 복기 저장분은 건드리지 않습니다.',
      confirmText: '고아 복기 삭제',
    });
    if (!ok) return;
    setBusy(true);
    setNotice(null);
    try {
      // 회차별 round_no 삭제만 — 미지정 삭제는 전체 복기를 날리는 데이터 손실 버그.
      let removed = 0;
      for (const r of orphanRounds) {
        const res = await v1Api.clearPhotoAnalysisStore('review', undefined, { roundNo: r });
        removed += res.removed ?? 0;
      }
      const acc = await v1Api.getPhotoAnalysisAccumulated();
      onAccumulatedChange?.(acc);
      setNotice(
        `✅ 고아 복기 정리 완료 (${orphanRounds.length}개 회차 · 삭제 ${removed}건). 보관 정본·타 회차 복기는 유지됩니다.`,
      );
    } catch (e) {
      setNotice(`❌ 고아 삭제 실패: ${e instanceof Error ? e.message : '서버 오류'}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <EngineSection
        id="engine-round-data"
        tone={orphans.length > 0 ? 'warning' : 'info'}
        title={`🗂 회차별 용지 데이터 (${rows.length}개 회차)`}
        collapsible
        open={open}
        onToggle={() => setOpen((v) => !v)}
        defaultOpen={orphans.length > 0}
        chips={
          <>
            <EngineStatusChip color="info" label="④ 엔진 · 데이터 정화" />
            <EngineStatusChip
              color="success"
              variant="outlined"
              label={`보관 ${rows.filter((r) => r.archived).length}`}
            />
            <EngineStatusChip
              color="info"
              variant="outlined"
              label={`복기저장 ${rows.filter((r) => r.review).length}`}
            />
            {orphans.length > 0 && (
              <EngineStatusChip color="error" label={`고아 ${orphans.length}`} />
            )}
            {conflicted.length > 0 && (
              <EngineStatusChip color="warning" label={`공존 ${conflicted.length}`} />
            )}
          </>
        }
        intent={
          <>
            학습·복기검증·백테스트가 읽는 <strong>용지 출처</strong>를 정리합니다.
            <strong> 롤오버 보관분</strong>이 그 회차에 실제로 등록한 이번회차 용지(추첨 시 동결)이고,
            <strong> 복기 저장분</strong>은 저장 시점 최신 회차로 라벨링되어 실제 구매 회차와 다를 수 있습니다.
            보관과 줄 수가 같은 복기는 <strong>고아(중복)</strong>로 엔진 학습·표시를 오염시키므로 삭제하세요.
          </>
        }
        actions={
          orphans.length > 0 ? (
            <Button
              size="small"
              color="warning"
              variant="outlined"
              disabled={busy}
              onClick={clearOrphanReviews}
              sx={{ fontSize: 11 }}
            >
              고아 복기 {orphans.length}건 삭제
            </Button>
          ) : undefined
        }
        sx={{ mb: 2 }}
      >
        {orphans.length > 0 && (
          <Alert severity="error" sx={{ mb: 1.5 }}>
            고아 복기 감지: {orphans.map((r) => r.ticket_round).join(', ')}회 —
            보관 정본과 동일 줄 수라 중복 저장으로 보입니다. Feature/다회차/접목 학습이 왜곡될 수 있습니다.
          </Alert>
        )}

        {conflicted.length > 0 && (
          <Alert severity="warning" sx={{ mb: 1.5 }}>
            {conflicted.map((r) => r.ticket_round).join(', ')}회에 <strong>두 출처가 공존</strong>합니다
            (내용이 다름). 재귀속으로 라벨을 교정하세요. 줄 수가 같으면 고아로 분류됩니다.
          </Alert>
        )}

        <Stack spacing={0.75}>
          <Stack direction="row" spacing={1} sx={{ px: 1, py: 0.5 }}>
            <Typography sx={{ width: 64, fontSize: 11, fontWeight: 800 }}>회차</Typography>
            <Typography sx={{ flex: 1, fontSize: 11, fontWeight: 800, color: 'success.light' }}>
              롤오버 보관분 (학습 정본)
            </Typography>
            <Typography sx={{ flex: 1, fontSize: 11, fontWeight: 800, color: 'info.light' }}>
              복기 저장분 (라벨 기준)
            </Typography>
          </Stack>
          {rows.map((r) => (
            <Stack
              key={r.ticket_round}
              direction="row"
              spacing={1}
              alignItems="center"
              sx={{
                px: 1,
                py: 0.75,
                borderRadius: 1,
                bgcolor: isOrphanReview(r)
                  ? 'rgba(211,47,47,0.12)'
                  : r.review && r.archived
                    ? 'rgba(237,108,2,0.12)'
                    : 'action.hover',
              }}
            >
              <Typography sx={{ width: 64, fontWeight: 800, fontSize: 13 }}>{r.ticket_round}회</Typography>
              <Box sx={{ flex: 1 }}>
                {r.archived ? (
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
                    <EngineStatusChip
                      color="success"
                      label={`자동 ${r.archived.auto_lines} · 반자동 ${r.archived.semi_lines}`}
                    />
                    <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>
                      {r.archived.entry_count}건 보관
                    </Typography>
                  </Stack>
                ) : (
                  <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>—</Typography>
                )}
              </Box>
              <Box sx={{ flex: 1 }}>
                {r.review ? (
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
                    <EngineStatusChip
                      color={isOrphanReview(r) ? 'error' : 'info'}
                      variant="outlined"
                      label={`자동 ${r.review.auto_lines} · 반자동 ${r.review.semi_lines}`}
                    />
                    {isOrphanReview(r) && <EngineStatusChip color="error" label="고아" />}
                    <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>
                      {r.review.entry_count}건
                    </Typography>
                    <Button
                      size="small"
                      variant="text"
                      disabled={busy}
                      onClick={() => {
                        setOpenFor(openFor === r.ticket_round ? null : r.ticket_round);
                        setTargetRound('');
                        setNotice(null);
                      }}
                      sx={{ minWidth: 0, px: 0.75, fontSize: 10 }}
                    >
                      회차 재귀속
                    </Button>
                  </Stack>
                ) : (
                  <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>—</Typography>
                )}
                {openFor === r.ticket_round && (
                  <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.75 }}>
                    <TextField
                      size="small"
                      label="실제 회차"
                      placeholder="예: 1232"
                      value={targetRound}
                      onChange={(e) => setTargetRound(e.target.value.replace(/\D/g, ''))}
                      sx={{ width: 110 }}
                    />
                    <Button
                      size="small"
                      variant="contained"
                      color="warning"
                      disabled={busy || !targetRound}
                      onClick={() => runReattribute(r.ticket_round)}
                    >
                      {busy ? <CircularProgress size={16} color="inherit" /> : '교정'}
                    </Button>
                    <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>
                      복기 저장분만 교정 · 보관 정본 불변
                    </Typography>
                  </Stack>
                )}
              </Box>
            </Stack>
          ))}
        </Stack>

        {notice && (
          <Alert severity={notice.startsWith('❌') ? 'error' : 'success'} sx={{ mt: 1.5 }}>
            {notice}
          </Alert>
        )}
      </EngineSection>
      {ConfirmDialog}
    </>
  );
}
