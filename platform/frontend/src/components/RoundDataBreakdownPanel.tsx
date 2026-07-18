import { Alert, Box, Chip, Paper, Stack, Typography } from '@mui/material';
import type { PhotoAnalysisAccumulated } from '../api/v1Api';

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
}: {
  accumulated: PhotoAnalysisAccumulated | null;
}) {
  const rows = accumulated?.historical_dataset?.rounds_breakdown ?? [];
  if (!rows.length) return null;
  const conflicted = rows.filter((r) => r.review && r.archived);

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
                </Stack>
              ) : (
                <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>—</Typography>
              )}
            </Box>
          </Stack>
        ))}
      </Stack>

      <Typography variant="caption" sx={{ display: 'block', mt: 1, fontStyle: 'italic', color: 'text.disabled' }}>
        ※ 두 출처 모두 보존됩니다(삭제 없음). 학습·분석은 회차별로 구분해 사용합니다.
      </Typography>
    </Paper>
  );
}
