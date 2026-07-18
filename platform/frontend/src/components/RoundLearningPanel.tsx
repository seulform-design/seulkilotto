import { Alert, Box, Chip, LinearProgress, Paper, Stack, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import LottoBall from './LottoBall';
import ComboActions from './ComboActions';
import SharingBadge from './SharingBadge';
import { v1Api } from '../api/v1Api';

/**
 * 🎓 다회차 용지 학습 — 보관된 과거 회차 용지(추첨 전 등록분, 누수 없음)를 실제
 * 당첨번호와 대조해 '양쪽 지지 구간별 적중률' 을 캘리브레이션하고, 이번회차 용지에 적용.
 *
 * ⚠️ 로또는 균등 무작위 → 기대상 구간별 적중률은 평탄(≈13.3%)하다. 이 패널의 값어치는
 * 신호가 있다고 우기는 게 아니라 내 용지 구조의 예측력을 정직하게 측정하는 데 있다.
 */
export default function RoundLearningPanel() {
  const q = useQuery({
    queryKey: ['v1-photo-round-learning'],
    queryFn: v1Api.getRoundLearning,
    staleTime: 300_000,
    retry: 1,
  });

  if (q.isLoading) {
    return (
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 1 }}>
          🎓 다회차 용지 학습
        </Typography>
        <LinearProgress />
      </Paper>
    );
  }
  const d = q.data;
  if (!d) return null;

  if (!d.ok) {
    return (
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 0.5 }}>
          🎓 다회차 용지 학습
        </Typography>
        <Alert severity="info">{d.reason ?? '학습할 보관 회차가 아직 없습니다.'}</Alert>
      </Paper>
    );
  }

  const cal = d.calibration ?? [];
  const maxLift = Math.max(1, ...cal.map((c) => c.lift));
  const scores = d.current_scores ?? [];
  const top6 = scores.slice(0, 6).map((s) => s.number).sort((a, b) => a - b);

  return (
    <Paper sx={{ p: 2, mb: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
        <Typography variant="subtitle1" fontWeight={800}>
          🎓 다회차 용지 학습 ({d.round_count}개 회차)
        </Typography>
        {d.summary && (
          <Chip
            size="small"
            color={d.summary.total_top6_hits > d.summary.expected_top6_hits ? 'success' : 'default'}
            label={`지지 상위6 누적 적중 ${d.summary.total_top6_hits}개 (기대 ${d.summary.expected_top6_hits})`}
            sx={{ height: 20, fontSize: 11, fontWeight: 700 }}
          />
        )}
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        추첨 <strong>전</strong>에 등록된 보관 용지만 사용하므로 <strong>누수가 없습니다</strong>.
        번호별 <strong>양쪽 지지</strong>(자동·반자동 줄에 함께 등장한 정도)가 실제 당첨과 얼마나
        연관됐는지 회차를 합산해 측정합니다.
      </Typography>

      {/* 회차별 결과 */}
      <Stack spacing={0.5} sx={{ mb: 1.5 }}>
        {(d.rounds ?? []).map((r) => (
          <Stack key={r.round_no} direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap
            sx={{ p: 0.75, borderRadius: 1, bgcolor: 'action.hover' }}>
            <Typography sx={{ fontWeight: 800, fontSize: 12, minWidth: 52 }}>{r.round_no}회</Typography>
            <Chip size="small" variant="outlined" label={`자동 ${r.auto_line_count}줄·반자동 ${r.semi_line_count}줄`} sx={{ height: 18, fontSize: 10 }} />
            <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>지지 상위6:</Typography>
            {r.top6_by_support.map((n) => (
              <LottoBall key={`${r.round_no}-${n}`} number={n} size={20} dimmed={!r.winning_numbers.includes(n)} />
            ))}
            <Chip
              size="small"
              color={r.top6_hits >= 2 ? 'success' : r.top6_hits === 1 ? 'warning' : 'default'}
              label={`적중 ${r.top6_hits}/6`}
              sx={{ height: 18, fontSize: 10, fontWeight: 700 }}
            />
          </Stack>
        ))}
      </Stack>

      {/* 캘리브레이션 */}
      <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
        양쪽 지지 구간별 실제 적중률 (기준선 13.3% = 6/45)
      </Typography>
      <Stack spacing={0.4} sx={{ mb: 1.5 }}>
        {cal.map((c) => (
          <Stack key={c.bucket} direction="row" spacing={1} alignItems="center">
            <Typography sx={{ width: 118, fontSize: 10.5 }}>{c.bucket}</Typography>
            <Box sx={{ flex: 1, position: 'relative', height: 14, bgcolor: 'action.hover', borderRadius: 0.5 }}>
              <Box
                sx={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: `${Math.min(100, (c.lift / maxLift) * 100)}%`,
                  bgcolor: c.lift >= 1.3 ? 'success.main' : c.lift >= 0.8 ? 'info.main' : 'text.disabled',
                  borderRadius: 0.5,
                }}
              />
            </Box>
            <Typography sx={{ width: 132, fontSize: 10, color: 'text.secondary', textAlign: 'right' }}>
              {(c.hit_rate * 100).toFixed(1)}% · lift {c.lift} · {c.won}/{c.played}
            </Typography>
          </Stack>
        ))}
      </Stack>

      {d.summary?.calibration_flat && (
        <Alert severity="info" sx={{ mb: 1.5, py: 0.25 }}>
          구간별 적중률이 <strong>거의 평탄</strong>합니다 — 내 용지의 지지 구조가 당첨을 예측한다는
          근거는 아직 없습니다(무작위 게임의 정상적인 결과).
        </Alert>
      )}

      {/* 이번회차 적용 */}
      {scores.length > 0 ? (
        <Box sx={{ p: 1.25, borderRadius: 1, bgcolor: 'action.hover' }}>
          <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
            🎯 {d.current_round_no}회 이번회차 용지에 학습 적용 (지지 × 학습 lift)
          </Typography>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
            {scores.map((s) => (
              <Box key={`rl-${s.number}`} sx={{ textAlign: 'center', minWidth: 38 }}>
                <LottoBall number={s.number} size={26} />
                <Typography sx={{ fontSize: 8, color: 'text.disabled', lineHeight: 1.1 }}>{s.score}</Typography>
                <Typography sx={{ fontSize: 7.5, color: 'text.disabled', lineHeight: 1 }}>
                  자{s.auto}·반{s.semi}
                </Typography>
              </Box>
            ))}
          </Stack>
          {top6.length === 6 && (
            <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="caption" fontWeight={700} sx={{ fontSize: 11 }}>학습 상위6:</Typography>
              {top6.map((n) => (
                <LottoBall key={`rlt-${n}`} number={n} size={24} />
              ))}
              <SharingBadge numbers={top6} />
              <ComboActions numbers={top6} source="unknown" label="다회차 학습 상위6" />
            </Stack>
          )}
        </Box>
      ) : (
        <Alert severity="info" sx={{ py: 0.25 }}>
          이번회차 용지가 없어 학습을 적용할 대상이 없습니다. 이번회차 용지를 등록하면 위 캘리브레이션이 적용됩니다.
        </Alert>
      )}

      <Typography variant="caption" sx={{ display: 'block', mt: 1, fontStyle: 'italic', color: 'text.disabled' }}>
        ⚠️ {d.honesty}
      </Typography>
    </Paper>
  );
}
