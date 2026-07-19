import { Alert, Box, Button, Chip, CircularProgress, Paper, Stack, TextField, Typography } from '@mui/material';
import { useState } from 'react';
import { v1Api, type PhotoAnalysisAccumulated } from '../api/v1Api';
import { useConfirm } from './useConfirm';

/**
 * 🗂 회차별 용지 데이터 — 같은 회차에 서로 다른 출처가 공존할 수 있어 분리 표시.
 *
 *  - 롤오버 보관분: 그 회차가 '이번회차'였을 때 등록한 용지 → 추첨 시 동결·보관됨.
 *    (= 실제로 그 회차에 구매·등록한 용지)
 *  - 복기 저장분: 복기 탭으로 저장된 엔트리. 저장 시점의 '최신 추첨 회차'로
 *    라벨링되므로, 이전 회차 용지를 나중에 저장하면 실제 구매 회차와 달라질 수 있다.
 */
export default function RoundDataBreakdownPanel({
  accumulated,
  onAccumulatedChange,
}: {
  accumulated: PhotoAnalysisAccumulated | null;
  onAccumulatedChange?: (acc: PhotoAnalysisAccumulated) => void;
}) {
  const { confirm, ConfirmDialog } = useConfirm();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [targetRound, setTargetRound] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const rows = accumulated?.historical_dataset?.rounds_breakdown ?? [];
  if (!rows.length) return null;
  const conflicted = rows.filter((r) => r.review && r.archived);

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

  return (
    <Paper sx={{ p: 2, mb: 2 }}>
      <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 0.5 }}>
        🗂 회차별 용지 데이터 ({rows.length}개 회차)
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        <strong>롤오버 보관분</strong>이 그 회차에 실제로 등록한 이번회차 용지입니다(추첨 시 동결).
        <strong> 복기 저장분</strong>은 복기 탭 저장분으로, 저장 시점의 최신 추첨 회차로 라벨링되어
        실제 구매 회차와 다를 수 있습니다.
      </Typography>

      {conflicted.length > 0 && (
        <Alert severity="warning" sx={{ mb: 1.5 }}>
          {conflicted.map((r) => r.ticket_round).join(', ')}회에 <strong>두 출처가 공존</strong>합니다.
          같은 회차 라벨이어도 내용이 다를 수 있으니 아래에서 구분해 확인하세요.
        </Alert>
      )}

      <Stack spacing={0.75}>
        {/* 헤더 */}
        <Stack direction="row" spacing={1} sx={{ px: 1, py: 0.5 }}>
          <Typography sx={{ width: 64, fontSize: 11, fontWeight: 800 }}>회차</Typography>
          <Typography sx={{ flex: 1, fontSize: 11, fontWeight: 800, color: 'success.light' }}>
            롤오버 보관분 (실제 그 회차 용지)
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
              bgcolor: r.review && r.archived ? 'rgba(237,108,2,0.12)' : 'action.hover',
            }}
          >
            <Typography sx={{ width: 64, fontWeight: 800, fontSize: 13 }}>{r.ticket_round}회</Typography>
            <Box sx={{ flex: 1 }}>
              {r.archived ? (
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
                  <Chip
                    size="small"
                    color="success"
                    label={`자동 ${r.archived.auto_lines}줄 · 반자동 ${r.archived.semi_lines}줄`}
                    sx={{ height: 20, fontSize: 11, fontWeight: 700 }}
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
                  <Chip
                    size="small"
                    color="info"
                    variant="outlined"
                    label={`자동 ${r.review.auto_lines}줄 · 반자동 ${r.review.semi_lines}줄`}
                    sx={{ height: 20, fontSize: 11, fontWeight: 700 }}
                  />
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
                    복기 저장분만 교정 · 보관 정본 불변 · 되돌리기 가능
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
      {ConfirmDialog}

      <Typography variant="caption" sx={{ display: 'block', mt: 1, fontStyle: 'italic', color: 'text.disabled' }}>
        ※ 두 출처 모두 보존됩니다(삭제 없음). 학습·분석은 회차별로 구분해 사용합니다.
      </Typography>
    </Paper>
  );
}
