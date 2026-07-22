import { Alert, Box, Chip, LinearProgress, Paper, Stack, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import LottoBall from './LottoBall';
import ComboActions from './ComboActions';
import SharingBadge from './SharingBadge';
import { v1Api } from '../api/v1Api';

/**
 * 🔬 복기 역산 검증 — 당첨번호가 각 신호에서 몇 위였는지, 커버리지 곡선.
 *
 * 사용자 관찰: 강수/기대 그리드는 당첨 6개를 다 담았는데 최종 top-6 픽은 못 뽑는다.
 * → '집중' 은 실패하고 '넓은 그물' 만 잡는다는 사실을 데이터로 보여준다.
 * ⚠️ 확률 불변. 이 리포트는 헛된 집중 예측 대신 커버리지 전략을 쓰게 하는 정직한 도구.
 */
export default function ReviewVerificationPanel() {
  const q = useQuery({
    queryKey: ['v1-photo-review-verification'],
    queryFn: v1Api.getReviewVerification,
    staleTime: 300_000,
    retry: 1,
  });

  if (q.isLoading) {
    return (
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 1 }}>
          🔬 복기 역산 검증
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
          🔬 복기 역산 검증
        </Typography>
        <Alert severity="info">{d.reason ?? '검증할 복기 데이터가 없습니다.'}</Alert>
      </Paper>
    );
  }

  const winSet = new Set(d.winning_numbers ?? []);
  const ks = ['top6', 'top10', 'top15', 'top18', 'top24', 'top30'];

  return (
    <Paper sx={{ p: 2, mb: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
        <Typography variant="subtitle1" fontWeight={800}>
          🔬 {d.round_no}회 복기 역산 검증
        </Typography>
        {d.summary && (
          <Chip
            size="small"
            color="warning"
            label={`어떤 신호도 top-6 최대 ${d.summary.best_top6}개 · top-18 ${d.summary.best_top18}개`}
            sx={{ height: 20, fontSize: 11, fontWeight: 700 }}
          />
        )}
      </Stack>

      {/* 실제 당첨 */}
      <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        <Typography variant="caption" fontWeight={700}>{d.round_no}회 당첨:</Typography>
        {(d.winning_numbers ?? []).map((n) => (
          <LottoBall key={`w-${n}`} number={n} size={26} />
        ))}
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        각 신호로 45개 번호를 세운 뒤 당첨번호가 <strong>몇 위</strong>였는지, top-K 안에 몇 개
        들어오는지 봅니다. 자동 {d.auto_line_count}줄 · 반자동 {d.semi_line_count}줄 기준.
      </Typography>

      {/* 신호별 커버리지 */}
      {(d.signals ?? []).map((s) => (
        <Box key={s.key} sx={{ mb: 1.25, p: 1, borderRadius: 1, bgcolor: s.key === d.best_signal_key ? 'rgba(46,125,50,0.12)' : 'action.hover' }}>
          <Stack direction="row" alignItems="center" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
            <Typography variant="caption" fontWeight={800}>
              {s.label}
              {s.key === d.best_signal_key && ' ⭐ 최선'}
            </Typography>
            {ks.map((k) => (
              <Chip
                key={k}
                size="small"
                variant="outlined"
                color={(s.coverage[k] ?? 0) >= 4 ? 'success' : 'default'}
                label={`${k.replace('top', 'top-')} ${s.coverage[k] ?? 0}개`}
                sx={{ height: 17, fontSize: 9.5 }}
              />
            ))}
          </Stack>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
            <Typography variant="caption" sx={{ fontSize: 10, color: 'text.secondary' }}>당첨 순위:</Typography>
            {s.winner_ranks.map((w) => (
              <Chip
                key={`${s.key}-${w.number}`}
                size="small"
                label={`${w.number}=${w.rank}위`}
                color={w.rank <= 6 ? 'success' : w.rank <= 18 ? 'warning' : 'default'}
                sx={{ height: 16, fontSize: 9.5, fontWeight: 700 }}
              />
            ))}
          </Stack>
        </Box>
      ))}

      <Alert severity="info" sx={{ mb: 1.5 }}>
        <strong>진단</strong>: 가장 많이 산 번호(고지지 <em>최상위</em>)는 당첨과 무관해 top-6 집중 픽은
        구조적으로 실패합니다. 당첨은 <strong>중간 지지대</strong>에 흩어져 top-18 커버리지에서만 대부분
        잡힙니다. <strong>'자동 빈도' 는 최악</strong>(단면 신호), <strong>'양쪽 지지' 가 최선</strong>입니다.
      </Alert>

      {/* 이번회차 커버리지 세트 */}
      {d.current_coverage_set && (d.current_coverage_set.expand18?.length ?? 0) > 0 && (
        <Box sx={{ p: 1.25, borderRadius: 1, border: '1px dashed', borderColor: 'primary.main' }}>
          <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
            🎯 {d.current_round_no}회 커버리지 세트 — {d.current_coverage_set.signal_label} 기준
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
            top-6 '집중' 대신 <strong>핵심 6 + 확장 18</strong>로 제시합니다(복기 검증상 확장이 더 잡음).
          </Typography>
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
            <Typography variant="caption" fontWeight={700} sx={{ fontSize: 11 }}>핵심 6:</Typography>
            {d.current_coverage_set.core6.map((n) => (
              <LottoBall key={`c6-${n}`} number={n} size={26} dimmed={winSet.size > 0 && !winSet.has(n)} />
            ))}
            <SharingBadge numbers={[...d.current_coverage_set.core6].sort((a, b) => a - b)} />
            <ComboActions numbers={[...d.current_coverage_set.core6].sort((a, b) => a - b)} source="unknown" label="복기검증 핵심6" />
          </Stack>
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="caption" fontWeight={700} sx={{ fontSize: 11 }}>확장 18:</Typography>
            {d.current_coverage_set.expand18.map((n) => (
              <LottoBall key={`e18-${n}`} number={n} size={20} />
            ))}
          </Stack>
        </Box>
      )}

      <Typography variant="caption" sx={{ display: 'block', mt: 1, fontStyle: 'italic', color: 'text.disabled' }}>
        ⚠️ {d.honesty}
      </Typography>
    </Paper>
  );
}
