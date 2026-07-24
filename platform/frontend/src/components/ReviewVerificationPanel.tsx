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
        {' '}지지 신호는 <strong>반자동 고정수를 제외</strong>해 산출합니다(고정수는 거의 모든 반자동 줄에 반복돼 왜곡).
      </Alert>

      {/* 🧪 다회차 백테스트 — 보관 전 회차의 지지(고정수 제외) 상위 K 커버리지 + 이월 */}
      {d.multi_round_backtest && d.multi_round_backtest.rounds > 1 && (
        <Box sx={{ mb: 1.5, p: 1, borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
            🧪 다회차 백테스트 ({d.multi_round_backtest.rounds}개 보관 회차 · 반자동 고정수 제외 지지 기준)
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, mb: 0.5 }}>
            각 회차의 자동↔반자동 지지 상위 K 가 그 회차 당첨을 몇 개 담나 — <strong>단일회차가 아닌 전 회차 평균</strong>.
            lift = 실제/무작위기대. 이월 = 그 회차 강수 미당첨 → <strong>다음 회차</strong> 당첨.
          </Typography>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
            {['6', '12', '18'].map((k) => {
              const a = d.multi_round_backtest!.aggregate?.[k];
              if (!a) return null;
              return (
                <Chip
                  key={k}
                  size="small"
                  color={a.lift >= 1.15 ? 'success' : 'default'}
                  label={`top-${k} 평균 ${a.mean_hit}/6 (무작위 ${a.mean_exp} · ×${a.lift})`}
                  sx={{ height: 20, fontSize: 10, fontWeight: 700 }}
                />
              );
            })}
          </Stack>
          <Stack spacing={0.3}>
            {(d.multi_round_backtest.per_round ?? []).map((r) => (
              <Stack key={r.round_no} direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography sx={{ fontSize: 10, fontWeight: 700, minWidth: 42 }}>{r.round_no}회</Typography>
                <Typography variant="caption" sx={{ fontSize: 10, color: 'text.secondary' }}>
                  자{r.auto_lines}·반{r.semi_lines} · <strong>top6 {r.support_coverage['6']} · top18 {r.support_coverage['18']}</strong>
                  {r.fixed_semi.length > 0
                    ? ` · 🔒고정수 ${r.fixed_semi.join('·')}`
                    : r.semi_repeat_top && r.semi_repeat_top.length > 0
                      ? ` · 반자동 최다반복 ${r.semi_repeat_top.slice(0, 4).map((x) => `${x.number}(${Math.round(x.frac * 100)}%)`).join('·')}${r.semi_repeat_top[0].frac < 0.5 ? ' (50%↑ 없음=강한 고정수 없음)' : ''}`
                      : ''}
                  {r.carryover
                    ? ` · 이월→${r.carryover.to_round} ${r.carryover.hit}개${r.carryover.carried.length ? `(${r.carryover.carried.join('·')})` : ''}`
                    : ''}
                </Typography>
              </Stack>
            ))}
          </Stack>
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', fontSize: 9, mt: 0.5, fontStyle: 'italic' }}>
            ⚠️ 표본({d.multi_round_backtest.rounds}회차)이 작아 lift 는 우연일 수 있습니다. 회차가 쌓일수록 신뢰도가 오릅니다. 1등 확률(1/8,145,060)은 불변.
          </Typography>
        </Box>
      )}

      {/* 🏆 다회차 신호 순위표 — 어느 신호가 당첨을 가장 잘 잡았나(고정수 제외) */}
      {d.signal_leaderboard && (d.signal_leaderboard.leaderboard?.length ?? 0) > 0 && d.signal_leaderboard.rounds > 0 && (
        <Box sx={{ mb: 1.5, p: 1, borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
            🏆 신호 성적표 ({d.signal_leaderboard.rounds}개 회차 다회차 집계) — 어느 방법이 당첨을 잘 잡았나
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, mb: 0.5 }}>
            각 신호로 세운 순위에서 실제 당첨이 <strong>상위6/상위18</strong>에 평균 몇 개 들었나(전 회차 평균).
            이번회차 커버리지 신호는 <strong>단일 회차가 아닌 이 다회차 성적 1위</strong>로 고릅니다(우연 흔들림 완화).
            tier = 당첨이 상위6·7~18·19~30·상위밖 중 어디에 떨어졌나(집중 실패·커버리지 유효의 증거).
          </Typography>
          <Stack spacing={0.3}>
            {(d.signal_leaderboard.leaderboard ?? []).map((s, i) => (
              <Stack key={s.key} direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap
                sx={{ p: 0.3, borderRadius: 0.5, bgcolor: s.key === d.signal_leaderboard!.best_signal_multi ? 'rgba(46,125,50,0.12)' : 'transparent' }}>
                <Typography sx={{ fontSize: 10, fontWeight: 700, minWidth: 16, color: 'text.disabled' }}>{i + 1}</Typography>
                <Typography variant="caption" sx={{ fontSize: 10.5, fontWeight: s.key === d.signal_leaderboard!.best_signal_multi ? 800 : 600, minWidth: 130 }}>
                  {s.label}{s.key === d.signal_leaderboard!.best_signal_multi ? ' ⭐' : ''}
                </Typography>
                <Chip size="small" color={s.mean_top18 >= 3 ? 'success' : 'default'}
                  label={`상위6 ${s.mean_top6} · 상위18 ${s.mean_top18}`} sx={{ height: 17, fontSize: 9.5, fontWeight: 700 }} />
                <Typography variant="caption" sx={{ fontSize: 9, color: 'text.disabled' }}>
                  tier 6:{s.tiers.t6}·18:{s.tiers.t18}·30:{s.tiers.t30}·밖:{s.tiers.out}
                </Typography>
              </Stack>
            ))}
          </Stack>
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', fontSize: 9, mt: 0.5, fontStyle: 'italic' }}>
            ⚠️ {d.signal_leaderboard.rounds}회차는 표본이 작아 순위는 흔들릴 수 있습니다 — 회차가 쌓일수록 안정됩니다. 확률 불변.
          </Typography>
        </Box>
      )}

      {/* 이번회차 커버리지 세트 */}
      {d.current_coverage_set && (d.current_coverage_set.expand18?.length ?? 0) > 0 && (
        <Box sx={{ p: 1.25, borderRadius: 1, border: '1px dashed', borderColor: 'primary.main' }}>
          <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
            🎯 {d.current_round_no}회 커버리지 세트 — {d.current_coverage_set.signal_label} 기준
            {d.current_coverage_set.selected_by === 'multi_round' ? ' (다회차 성적 1위 신호)' : ''}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
            top-6 '집중' 대신 <strong>핵심 6 + 확장 12(합 18)</strong>로 제시합니다(복기 검증상 확장이 더 잡음).
            {' '}{d.current_round_no}회는 아직 추첨 전이라 대조하지 않습니다.
          </Typography>
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
            <Typography variant="caption" fontWeight={700} sx={{ fontSize: 11 }}>핵심 6:</Typography>
            {/* 이번회차(미추첨) 픽이므로 지난(복기) 회차 당첨과 대조(dimmed)하지 않는다. */}
            {d.current_coverage_set.core6.map((n) => (
              <LottoBall key={`c6-${n}`} number={n} size={26} />
            ))}
            <SharingBadge numbers={[...d.current_coverage_set.core6].sort((a, b) => a - b)} />
            <ComboActions numbers={[...d.current_coverage_set.core6].sort((a, b) => a - b)} source="unknown" label="복기검증 핵심6" />
          </Stack>
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
            {/* 확장은 핵심 6 을 제외한 나머지(7~18위)만 — '핵심 6 + 확장' 이 실제로 합 18 이 되게. */}
            <Typography variant="caption" fontWeight={700} sx={{ fontSize: 11 }}>확장 +12:</Typography>
            {d.current_coverage_set.expand18
              .filter((n) => !d.current_coverage_set!.core6.includes(n))
              .map((n) => (
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
