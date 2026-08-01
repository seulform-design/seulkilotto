import { Alert, Box, Chip, LinearProgress, Stack, Typography } from '@mui/material';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import LottoBall from './LottoBall';
import ComboActions from './ComboActions';
import SharingBadge from './SharingBadge';
import { ENGINE_BALL, EngineSection, EngineStatusChip } from './EngineSection';
import { ExplainArtifactBlock } from './ExplainArtifactBlock';
import { v1Api } from '../api/v1Api';

/**
 * 🔬 복기 역산 검증 — 당첨번호가 각 신호에서 몇 위였는지, 커버리지 곡선.
 *
 * 사용자 관찰: 강수/기대 그리드는 당첨 6개를 다 담았는데 최종 top-6 픽은 못 뽑는다.
 * → '집중' 은 실패하고 '넓은 그물' 만 잡는다는 사실을 데이터로 보여준다.
 * ⚠️ 확률 불변. 이 리포트는 헛된 집중 예측 대신 커버리지 전략을 쓰게 하는 정직한 도구.
 */
export default function ReviewVerificationPanel() {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    // round_no 가 응답에 포함되므로 stale 시 회차 업그레이드 후 옛 검증이 남을 수 있음 → 재조회 주기 단축
    queryKey: ['v1-photo-review-verification', 'expand24-v9-decade-precision', 'semi-freq-v1', 'pair-product'],
    queryFn: v1Api.getReviewVerification,
    staleTime: 60_000,
    refetchOnMount: 'always',
    retry: 1,
  });

  if (q.isLoading) {
    return (
      <EngineSection
        tone="warning"
        title="🔬 복기 역산 검증"
        collapsible
        open={open}
        onToggle={() => setOpen((v) => !v)}
        defaultOpen={false}
        sx={{ mb: 2 }}
      >
        <LinearProgress />
      </EngineSection>
    );
  }
  const d = q.data;
  if (!d) return null;
  if (!d.ok) {
    return (
      <EngineSection
        tone="warning"
        title="🔬 복기 역산 검증"
        collapsible
        open={open}
        onToggle={() => setOpen((v) => !v)}
        defaultOpen={false}
        sx={{ mb: 2 }}
      >
        <Alert severity="info">{d.reason ?? '검증할 복기 데이터가 없습니다.'}</Alert>
      </EngineSection>
    );
  }

  const ks = ['top6', 'top10', 'top15', 'top18', 'top24', 'top30'];

  return (
    <EngineSection
      tone="warning"
      title={`🔬 ${d.round_no}회 복기 역산 검증`}
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      defaultOpen={false}
      sx={{ mb: 2 }}
      chips={
        d.summary ? (
          <EngineStatusChip
            color="warning"
            label={`어떤 신호도 top-6 최대 ${d.summary.best_top6}개 · top-18 ${d.summary.best_top18}개`}
          />
        ) : undefined
      }
    >
      {/* 실제 당첨 */}
      <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        <Typography variant="caption" fontWeight={700}>{d.round_no}회 당첨:</Typography>
        {(d.winning_numbers ?? []).map((n) => (
          <LottoBall key={`w-${n}`} number={n} size={ENGINE_BALL.list} />
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

      {/* 🧭 시니어 역산 진단 — 낮은 당첨률 원인 → 적용 정책 */}
      {d.inverse_diagnosis && (d.inverse_diagnosis.problems?.length ?? 0) > 0 && (
        <Box sx={{ mb: 1.5, p: 1.25, borderRadius: 1, border: '1px solid', borderColor: 'error.light', bgcolor: 'rgba(211,47,47,0.04)' }}>
          <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
            🧭 시니어 역산 진단 — 엔진 당첨률이 낮았던 이유
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, mb: 0.75 }}>
            {d.inverse_diagnosis.verdict}
          </Typography>
          <Stack spacing={0.4} sx={{ mb: 0.75 }}>
            {d.inverse_diagnosis.problems.map((p) => (
              <Box key={p.id} sx={{ pl: 0.5 }}>
                <Typography variant="caption" sx={{ fontSize: 10.5, fontWeight: 800, color: p.severity === 'high' ? 'error.main' : p.severity === 'medium' ? 'warning.main' : 'text.secondary' }}>
                  [{p.severity === 'high' ? '치명' : p.severity === 'medium' ? '주의' : '참고'}] {p.title}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 9.5 }}>
                  {p.detail}
                </Typography>
              </Box>
            ))}
          </Stack>
          {d.inverse_diagnosis.metrics && (
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
              <Chip size="small" color="warning" label={`다회차 상위6 ${d.inverse_diagnosis.metrics.mean_top6 ?? '—'} (무작위 ${d.inverse_diagnosis.metrics.random_top6 ?? 0.8})`} sx={{ height: 18, fontSize: 9.5, fontWeight: 700 }} />
              <Chip size="small" color="success" label={`다회차 상위18 ${d.inverse_diagnosis.metrics.mean_top18 ?? '—'} (무작위 ${d.inverse_diagnosis.metrics.random_top18 ?? 2.4})`} sx={{ height: 18, fontSize: 9.5, fontWeight: 700 }} />
              {d.inverse_diagnosis.policy && (
                <Chip size="small" color={d.inverse_diagnosis.policy.coverage_mode === 'expand18_first' ? 'primary' : 'default'}
                  label={`정책 ${d.inverse_diagnosis.policy.coverage_mode} · core=${d.inverse_diagnosis.policy.core6_mode ?? 'best_single'} · expand=${d.inverse_diagnosis.policy.expand18_mode ?? 'best_of_engines'}`}
                  sx={{ height: 18, fontSize: 9.5, fontWeight: 700 }} />
              )}
            </Stack>
          )}
          <Typography variant="caption" fontWeight={700} sx={{ display: 'block', fontSize: 10, mb: 0.25 }}>적용 보완</Typography>
          <Stack component="ul" sx={{ m: 0, pl: 2 }}>
            {(d.inverse_diagnosis.actions ?? []).map((a) => (
              <Typography key={a} component="li" variant="caption" sx={{ fontSize: 9.5, color: 'text.secondary' }}>{a}</Typography>
            ))}
          </Stack>
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', fontSize: 9, mt: 0.5, fontStyle: 'italic' }}>
            ⚠️ 이 진단은 1등 확률을 올리지 않습니다. 실패 패턴(집중·저성과 신호)을 주입에서 끊어 커버리지 전략만 남깁니다.
          </Typography>
        </Box>
      )}

      {/* Explain Artifact — confidence·근거·한계 */}
      <ExplainArtifactBlock
        explain={d.explain}
        title={`Explain — 왜 이 커버리지인가 (${d.explain?.decision ?? 'coverage'})`}
      />

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
              const sig = a.significance;
              return (
                <Chip
                  key={k}
                  size="small"
                  color={sig?.significant ? 'success' : a.lift >= 1.15 ? 'warning' : 'default'}
                  label={`top-${k} 평균 ${a.mean_hit}/6 (무작위 ${a.mean_exp} · ×${a.lift}${sig ? ` · p=${sig.p_value}${sig.significant ? ' ✓유의' : sig.small_sample ? ' ·소표본' : ''}` : ''})`}
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
                <Chip size="small" color={s.mean_top18 >= 3 ? 'success' : s.underperforming ? 'error' : 'default'}
                  label={`상위6 ${s.mean_top6} · 상위18 ${s.mean_top18}${s.underperforming ? ' ·저성과' : ''}`} sx={{ height: 17, fontSize: 9.5, fontWeight: 700 }} />
                {s.significance && (
                  <Typography variant="caption" sx={{ fontSize: 9, fontWeight: 700, color: s.significance.significant ? 'success.main' : 'text.disabled' }}>
                    p={s.significance.p_value}{s.significance.significant ? ' ✓유의' : ''}
                  </Typography>
                )}
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

      {/* 🔁 Leave-One-Out 교차검증 — 신호 선택이 과적합이 아니라 일반화되나(누수 없음) */}
      {d.signal_leaderboard?.loo && (d.signal_leaderboard.loo.folds?.length ?? 0) > 0 && (
        <Box sx={{ mb: 1.5, p: 1, borderRadius: 1, border: '1px dashed', borderColor: 'divider' }}>
          <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
            🔁 Leave-One-Out 교차검증 — 신호 선택이 일반화되나
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, mb: 0.5 }}>
            각 회차를 빼고 <strong>나머지로 최고 신호를 고른 뒤</strong>, 뺀 회차에서의 상위18 적중 — 신호 선택이 과적합이
            아닌지 정직하게 봅니다(뺀 회차는 선택에 미참여 = 누수 없음).
          </Typography>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.3 }}>
            {d.signal_leaderboard.loo.folds.map((f) => (
              <Chip key={f.held_round} size="small" variant="outlined"
                label={`${f.held_round}회 → ${f.chosen_label} ${f.top18_hit}/6`}
                sx={{ height: 18, fontSize: 9.5 }} />
            ))}
          </Stack>
          <Typography variant="caption" sx={{ display: 'block', fontSize: 10, fontWeight: 700, color: d.signal_leaderboard.loo.generalizes ? 'success.main' : 'text.secondary' }}>
            LOO 평균 상위18 적중 {d.signal_leaderboard.loo.mean_top18_hit ?? '—'} vs 무작위 {d.signal_leaderboard.loo.random_baseline}
            {d.signal_leaderboard.loo.generalizes ? ' — 무작위 초과(일반화 조짐)' : ' — 무작위와 비슷(일반화 근거 약함)'}
          </Typography>
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', fontSize: 9, mt: 0.3, fontStyle: 'italic' }}>
            ⚠️ 소표본에선 LOO 도 흔들립니다 — 참고용. 회차가 쌓일수록 신뢰도가 오릅니다. 확률 불변.
          </Typography>
        </Box>
      )}

      {/* 🎼 앙상블 커버리지 천장 백테스트 — 전 엔진을 합쳐도 무작위를 이기나(정직한 천장) */}
      {d.ensemble_backtest?.ok && (d.ensemble_backtest.rounds ?? 0) > 1 && (() => {
        const e = d.ensemble_backtest!;
        const sig18 = e.ensemble_significance?.['18'];
        return (
          <Box sx={{ mb: 1.5, p: 1, borderRadius: 1, border: '2px solid', borderColor: e.beats_random ? 'success.main' : 'warning.dark' }}>
            <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
              🎼 앙상블 커버리지 천장 백테스트 ({e.rounds}개 회차 · 전 엔진 신호 합산)
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, mb: 0.5 }}>
              전 신호({(e.signals_combined ?? []).length}개)를 <strong>등가중 평균순위(Borda·과적합 없음)</strong>로 합친 앙상블이
              당첨을 상위18에 몇 개 담나 — <strong>무작위·최고 단일신호와 정면 비교</strong>.
            </Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
              <Chip size="small" variant="outlined" label={`무작위 ${e.random_baseline?.top18 ?? 2.4}`} sx={{ height: 20, fontSize: 10 }} />
              {e.best_single_signal && (
                <Chip size="small" variant="outlined" color="info" label={`최고 단일: ${e.best_single_signal.label} ${e.best_single_signal.mean_top18}`} sx={{ height: 20, fontSize: 10, fontWeight: 700 }} />
              )}
              <Chip size="small" color={sig18?.significant ? 'success' : 'warning'}
                label={`앙상블 ${e.ensemble_mean?.['18'] ?? '—'}${sig18 ? ` · p=${sig18.p_value}${sig18.significant ? ' ✓유의' : sig18.small_sample ? ' ·소표본' : ''}` : ''}`}
                sx={{ height: 20, fontSize: 10, fontWeight: 800 }} />
            </Stack>
            <Typography variant="caption" sx={{ display: 'block', fontSize: 10, fontWeight: 700, color: e.beats_random ? 'success.main' : 'text.secondary' }}>
              판정: {e.verdict}
              {e.beats_best_single ? ' · 최고 단일도 상회' : ' · 최고 단일 대비 이점 없음'}
            </Typography>
            <Typography variant="caption" color="text.disabled" sx={{ display: 'block', fontSize: 9, mt: 0.3, fontStyle: 'italic' }}>
              ⚠️ 확률(1/8,145,060)·부분일치 기대값은 어떤 앙상블로도 불변입니다. 이 백테스트는 '천장'을 정직하게 볼 뿐 —
              유일한 실질 레버는 당첨 시 기대수령액(공동당첨 회피)입니다.
            </Typography>
          </Box>
        );
      })()}

      {/* 🚫 놓친 당첨 분석 — 어떤 신호로도 못 잡은 당첨(예측 천장) */}
      {d.missed_winner_analysis && d.missed_winner_analysis.rounds > 0 && d.missed_winner_analysis.aggregate.total > 0 && (() => {
        const a = d.missed_winner_analysis.aggregate;
        const pct = (x: number) => Math.round((x / a.total) * 100);
        return (
          <Box sx={{ mb: 1.5, p: 1, borderRadius: 1, border: '1px solid', borderColor: 'warning.dark' }}>
            <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
              🚫 놓친 당첨 분석 — 예측 천장 ({d.missed_winner_analysis.rounds}개 회차 · 당첨 {a.total}개)
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, mb: 0.5 }}>
              <strong>전 신호를 종합해도</strong> 각 당첨번호가 어디까지 잡혔나 — 어떤 신호의 상위6/18/30에도 못 든 당첨,
              특히 <strong>티켓(자동·반자동)에 아예 없던 당첨</strong>은 티켓 데이터로 구조적으로 못 잡습니다.
            </Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
              <Chip size="small" color="success" label={`상위6 안 ${a.top6_any} (${pct(a.top6_any)}%)`} sx={{ height: 18, fontSize: 9.5, fontWeight: 700 }} />
              <Chip size="small" color="success" label={`상위18 안 ${a.top18_any} (${pct(a.top18_any)}%)`} sx={{ height: 18, fontSize: 9.5, fontWeight: 700 }} />
              <Chip size="small" color={a.uncatchable > 0 ? 'warning' : 'default'} label={`상위밖(미포착) ${a.uncatchable}`} sx={{ height: 18, fontSize: 9.5, fontWeight: 700 }} />
              <Chip size="small" color={a.missing_ticket > 0 ? 'error' : 'default'} label={`티켓 미등장 ${a.missing_ticket} (${pct(a.missing_ticket)}%)`} sx={{ height: 18, fontSize: 9.5, fontWeight: 700 }} />
            </Stack>
            <Stack spacing={0.2}>
              {(d.missed_winner_analysis.per_round ?? []).map((r) => (
                <Typography key={r.round_no} variant="caption" sx={{ fontSize: 9.5, color: 'text.secondary' }}>
                  <strong>{r.round_no}회</strong>: 잡음 {r.caught_top18.join('·') || '-'}
                  {r.missed.length > 0
                    ? ` · 놓침 ${r.missed.map((m) => `${m.number}(${m.in_ticket ? m.best_rank + '위' : '미등장'})`).join('·')}`
                    : ''}
                </Typography>
              ))}
            </Stack>
            <Typography variant="caption" color="text.disabled" sx={{ display: 'block', fontSize: 9, mt: 0.5, fontStyle: 'italic' }}>
              ⚠️ 놓친 당첨(특히 티켓 미등장)은 어떤 분석으로도 못 잡습니다 — 이게 예측의 천장이자 확률 불변의 직접 증거입니다. 넓은 그물로 '담을 수 있는 것'만 최대화합니다.
            </Typography>
          </Box>
        );
      })()}

      {/* 📊 구간(10단위) 균형 커버리지 진단 — 어느 구간 당첨이 덜 잡혔나 */}
      {d.decade_catch && d.decade_catch.rounds > 0 && (
        <Box sx={{ mb: 1.5, p: 1, borderRadius: 1, border: '1px solid', borderColor: 'info.dark' }}>
          <Typography variant="caption" fontWeight={800} sx={{ display: 'block', mb: 0.5 }}>
            📊 구간(10단위) 커버리지 진단 ({d.decade_catch.rounds}개 회차 집계)
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, mb: 0.5 }}>
            구간별 당첨번호를 <strong>양쪽 지지 상위(진단 top18)</strong>이 얼마나 담았나(잡음/당첨) — 낮은 구간은 실제 확장망(top24)으로 보정합니다.
          </Typography>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
            {d.decade_catch.per_decade.map((r) => {
              const weak = d.decade_catch!.weak_decades.includes(r.decade);
              return (
                <Chip
                  key={r.decade}
                  size="small"
                  color={r.winning === 0 ? 'default' : weak ? 'warning' : 'success'}
                  variant={r.winning === 0 ? 'outlined' : 'filled'}
                  label={`${r.decade}: ${r.caught_top18}/${r.winning}${r.catch_rate != null ? ` (${Math.round(r.catch_rate * 100)}%)` : ''}`}
                  sx={{ height: 18, fontSize: 9.5, fontWeight: 700 }}
                />
              );
            })}
          </Stack>
          {d.decade_catch.weak_decades.length > 0 && (
            <Typography variant="caption" color="warning.main" sx={{ display: 'block', fontSize: 9.5 }}>
              ⚠️ 덜 잡힌 구간: {d.decade_catch.weak_decades.join(', ')} — 이번회차 넓은 그물이 이 구간을 반드시 포함하도록 보정했습니다.
            </Typography>
          )}
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', fontSize: 9, mt: 0.3, fontStyle: 'italic' }}>
            ⚠️ 로또는 i.i.d. — 구간별 당첨 '확률'은 동일합니다(표본 적어 편차는 대개 우연). 이 진단은 확률 비교가 아니라 그물이 빠뜨린 구간을 찾아 커버리지를 넓히기 위한 것입니다.
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
            top-6 '집중' 대신{' '}
            <strong>
              핵심 6 + 확장망(합 {d.current_coverage_set.expand_size ?? d.current_coverage_set.expand18?.length ?? 24})
            </strong>
            으로 제시합니다(복기 검증상 확장이 더 잡음).
            {' '}{d.current_round_no}회는 아직 추첨 전이라 대조하지 않습니다.
          </Typography>
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
            <Typography variant="caption" fontWeight={700} sx={{ fontSize: 11 }}>핵심 6:</Typography>
            {/* 이번회차(미추첨) 픽이므로 지난(복기) 회차 당첨과 대조(dimmed)하지 않는다. */}
            {d.current_coverage_set.core6.map((n) => (
              <LottoBall key={`c6-${n}`} number={n} size={ENGINE_BALL.list} />
            ))}
            <SharingBadge numbers={[...d.current_coverage_set.core6].sort((a, b) => a - b)} />
            <ComboActions numbers={[...d.current_coverage_set.core6].sort((a, b) => a - b)} source="unknown" label="복기검증 핵심6" />
          </Stack>
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
            {/* 확장은 핵심 6 제외 나머지 — 합 = expand_size(기본 24). */}
            <Typography variant="caption" fontWeight={700} sx={{ fontSize: 11 }}>
              확장 +{(d.current_coverage_set.expand18 ?? []).filter((n) => !d.current_coverage_set!.core6.includes(n)).length}:
            </Typography>
            {d.current_coverage_set.expand18
              .filter((n) => !d.current_coverage_set!.core6.includes(n))
              .map((n) => (
                <LottoBall key={`e18-${n}`} number={n} size={ENGINE_BALL.table} />
              ))}
          </Stack>
          {d.current_coverage_set.decade_balance && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 9.5, mt: 0.5 }}>
              🧩 구간 균형:{' '}
              {Object.entries(d.current_coverage_set.decade_balance.spread)
                .map(([k, v]) => `${k}(${v})`)
                .join(' · ')}
              {d.current_coverage_set.decade_balance.filled_decades.length > 0
                ? ` · 보정으로 채운 구간: ${d.current_coverage_set.decade_balance.filled_decades.join(', ')}`
                : ' · 5개 구간 모두 커버'}
              {d.current_coverage_set.decade_balance.empty_decades.length > 0
                ? ` · 티켓 후보 없는 구간: ${d.current_coverage_set.decade_balance.empty_decades.join(', ')}`
                : ''}
              {(d.current_coverage_set.decade_balance.displaced?.length ?? 0) > 0
                ? ` · 교체 −${d.current_coverage_set.decade_balance.displaced!.join(',')}`
                : ''}
            </Typography>
          )}
          {d.expand_walkforward && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 9.5, mt: 0.35 }}>
              📐 확장망: {d.expand_walkforward.selected_label ?? d.expand_walkforward.selected_mode}
              {d.current_coverage_set.expand_size
                ? ` · ${d.current_coverage_set.expand_size}개`
                : d.current_coverage_set.expand18
                  ? ` · ${d.current_coverage_set.expand18.length}개`
                  : ''}
            </Typography>
          )}
        </Box>
      )}

      <Typography variant="caption" sx={{ display: 'block', mt: 1, fontStyle: 'italic', color: 'text.disabled' }}>
        ⚠️ {d.honesty}
      </Typography>
    </EngineSection>
  );
}
