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
  // 줄겹침(2·3·4번호) 역산 학습 — 회차가 쌓이면 자동으로 표본이 늘어난다.
  const ov = useQuery({
    queryKey: ['v1-photo-overlap-learning'],
    queryFn: v1Api.getOverlapLearning,
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
  // 실패 시 조용히 사라지지 않도록 오류를 표면화(구버전은 null 반환으로 섹션이 증발).
  if (q.isError) {
    return (
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 0.5 }}>
          🎓 다회차 용지 학습
        </Typography>
        <Alert severity="error">
          학습 데이터를 불러오지 못했습니다: {q.error instanceof Error ? q.error.message : '서버 오류'}
        </Alert>
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
          {(d.current_auto_lines ?? 0) + (d.current_semi_lines ?? 0) > 0 ? (
            <>
              이번회차 용지는 등록돼 있으나(자동 {d.current_auto_lines ?? 0}줄 · 반자동{' '}
              {d.current_semi_lines ?? 0}줄) 학습 점수를 낼 수 없습니다.
              {d.current_one_sided
                ? ' 한쪽만 등록돼 양쪽 지지(자동∩반자동)가 0이기 때문입니다 — 나머지 한쪽도 등록하면 적용됩니다.'
                : ''}
            </>
          ) : (
            '이번회차 용지가 없어 학습을 적용할 대상이 없습니다. 이번회차 용지를 등록하면 위 캘리브레이션이 적용됩니다.'
          )}
        </Alert>
      )}

      <Typography variant="caption" sx={{ display: 'block', mt: 1, fontStyle: 'italic', color: 'text.disabled' }}>
        ⚠️ {d.honesty}
      </Typography>

      {/* ── 줄겹침(2·3·4번호) 역산 학습 ── */}
      {ov.data?.ok && (
        <Box sx={{ mt: 2, pt: 1.5, borderTop: '1px dashed', borderColor: 'divider' }}>
          <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
            <Typography variant="subtitle2" fontWeight={800}>
              🔗 줄겹침(2·3·4번호) 역산 학습 — {ov.data.round_count}개 회차 · 조합 {ov.data.total_combos}건
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            '다른 줄에도 겹침' 조합이 <strong>실제 당첨번호를 얼마나 담았는지</strong> 회차마다 역산해
            누적합니다. 기준선 = 조합 크기 × 6/45 (무작위 기대). <strong>lift 배수</strong>가 1.0 근처면
            예측력이 없다는 뜻입니다.
          </Typography>

          {/* 크기별 */}
          <Stack spacing={0.4} sx={{ mb: 1 }}>
            {(ov.data.by_size ?? []).map((s) => (
              <Stack key={`ovs-${s.size}`} direction="row" spacing={1} alignItems="center">
                <Typography sx={{ width: 88, fontSize: 11, fontWeight: 700 }}>{s.size}번호 겹침</Typography>
                <Chip
                  size="small"
                  color={s.lift_vs_chance >= 1.3 ? 'success' : s.lift_vs_chance >= 0.8 ? 'info' : 'default'}
                  label={`×${s.lift_vs_chance}`}
                  sx={{ height: 18, fontSize: 10, fontWeight: 700, minWidth: 52 }}
                />
                <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>
                  평균 당첨겹침 {s.mean_overlap} (기대 {s.expected}) · {s.combos}건 · 전부당첨 {s.fully_winning}건
                </Typography>
              </Stack>
            ))}
          </Stack>

          {/* lift 구간별 */}
          <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.5 }}>
            겹침 강도(lift) 구간별 — 강하게 묶인 조합이 당첨을 더 담았나?
          </Typography>
          <Stack spacing={0.3} sx={{ mb: 1 }}>
            {(ov.data.by_lift_bucket ?? [])
              .filter((b) => b.combos >= 5)
              .map((b) => (
                <Stack key={`ovb-${b.size}-${b.bucket}`} direction="row" spacing={1} alignItems="center">
                  <Typography sx={{ width: 150, fontSize: 10 }}>
                    {b.size}번호 · {b.bucket}
                  </Typography>
                  <Typography sx={{ fontSize: 10, color: b.lift_vs_chance >= 1.3 ? 'success.light' : 'text.secondary' }}>
                    ×{b.lift_vs_chance} (평균 {b.mean_overlap} / 기대 {b.expected}) · {b.combos}건
                  </Typography>
                </Stack>
              ))}
          </Stack>

          {ov.data.calibration_flat && (
            <Alert severity="info" sx={{ mb: 1, py: 0.25 }}>
              구간별 배수가 <strong>1.0 근처로 평탄</strong>합니다 — 겹침 강도가 당첨을 예측한다는 근거는
              아직 없습니다(무작위 게임의 정상 결과).
            </Alert>
          )}

          {(ov.data.current_scores?.length ?? 0) > 0 ? (
            <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
              <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.5 }}>
                🎯 {ov.data.current_round_no}회 이번회차 겹침 조합에 학습 적용 (조합 {ov.data.current_combo_count}건)
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                {ov.data.current_scores!.map((s) => (
                  <Box key={`ovc-${s.number}`} sx={{ textAlign: 'center', minWidth: 36 }}>
                    <LottoBall number={s.number} size={26} />
                    <Typography sx={{ fontSize: 8, color: 'text.disabled', lineHeight: 1.1 }}>{s.score}</Typography>
                    <Typography sx={{ fontSize: 7.5, color: 'text.disabled', lineHeight: 1 }}>{s.combo_support}조합</Typography>
                  </Box>
                ))}
              </Stack>
            </Box>
          ) : (
            <Alert severity="info" sx={{ py: 0.25 }}>
              이번회차 자동 누적에 겹침 조합이 없어 적용 대상이 없습니다(자동 용지 2줄 이상 필요).
            </Alert>
          )}

          <Typography variant="caption" sx={{ display: 'block', mt: 0.75, fontStyle: 'italic', color: 'text.disabled' }}>
            ⚠️ {ov.data.honesty}
          </Typography>
        </Box>
      )}
      {ov.data && !ov.data.ok && (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          🔗 줄겹침 학습: {ov.data.reason}
        </Alert>
      )}
    </Paper>
  );
}
