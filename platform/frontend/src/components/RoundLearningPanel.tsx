import { Alert, Box, LinearProgress, Stack, Typography } from '@mui/material';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import LottoBall from './LottoBall';
import ComboActions from './ComboActions';
import SharingBadge from './SharingBadge';
import { ENGINE_BALL, EngineSection, EngineStatusChip, EngineSubBlock } from './EngineSection';
import { ExplainArtifactBlock } from './ExplainArtifactBlock';
import { v1Api } from '../api/v1Api';

/**
 * V3. 다회차 용지 학습 — 보관된 과거 회차 용지(추첨 전 등록분, 누수 없음)를 실제
 * 당첨번호와 대조해 '양쪽 지지 구간별 적중률' 을 캘리브레이션하고, 이번회차 용지에 적용.
 *
 * 줄겹침은 V4-A(서버)·V4-B(클라)로 분리. 여기는 양쪽 지지 캘리브만.
 *
 * ⚠️ 로또는 균등 무작위 → 기대상 구간별 적중률은 평탄(≈13.3%)하다. 이 패널의 값어치는
 * 신호가 있다고 우기는 게 아니라 내 용지 구조의 예측력을 정직하게 측정하는 데 있다.
 */
export default function RoundLearningPanel({
  sheetIntent = 'current_round',
}: {
  sheetIntent?: 'review' | 'current_round';
}) {

  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['v1-photo-round-learning', sheetIntent],
    queryFn: () => v1Api.getRoundLearning({ applyIntent: sheetIntent }),
    staleTime: 300_000,
    retry: 1,
  });

  if (q.isLoading) {
    return (
      <EngineSection tone="primary" title="V3. 다회차 용지 학습" id="learn-v3" sx={{ mb: 2 }}>
        <LinearProgress />
      </EngineSection>
    );
  }
  if (q.isError) {
    return (
      <EngineSection tone="primary" title="V3. 다회차 용지 학습" id="learn-v3" sx={{ mb: 2 }}>
        <Alert severity="error">
          학습 데이터를 불러오지 못했습니다: {q.error instanceof Error ? q.error.message : '서버 오류'}
        </Alert>
      </EngineSection>
    );
  }
  const d = q.data;
  if (!d) return null;

  if (!d.ok) {
    return (
      <EngineSection
        tone="primary"
        title="V3. 다회차 용지 학습"
        id="learn-v3"
        collapsible
        open={open}
        onToggle={() => setOpen((v) => !v)}
        sx={{ mb: 2 }}
        chips={<EngineStatusChip color="default" label="표본 없음" />}
        intent="추첨 전 등록 보관 용지만 사용해 양쪽 지지×당첨을 회차 합산합니다."
      >
        <Alert severity="info">{d.reason ?? '학습할 보관 회차가 아직 없습니다. 회차가 쌓이면(목표 4회+) 채워집니다.'}</Alert>
      </EngineSection>
    );
  }

  const cal = d.calibration ?? [];
  const maxLift = Math.max(1, ...cal.map((c) => c.lift));
  const scores = d.current_scores ?? [];
  const top6 = scores.slice(0, 6).map((s) => s.number).sort((a, b) => a - b);
  const flat = Boolean(d.summary?.calibration_flat);
  const injectable = scores.filter((s) => (s.learned_lift ?? 1) >= 1.05).length;

  return (
    <EngineSection
      tone="primary"
      title={`V3. 다회차 용지 학습 (${d.round_count}개 회차)`}
      id="learn-v3"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      defaultOpen={false}
      sx={{ mb: 2 }}
      chips={
        <>
          {d.summary && (
            <EngineStatusChip
              color={d.summary.total_top6_hits > d.summary.expected_top6_hits ? 'success' : 'default'}
              label={`상위6 누적 ${d.summary.total_top6_hits}/${d.summary.expected_top6_hits}기대`}
            />
          )}
          <EngineStatusChip
            color={flat ? 'warning' : injectable > 0 ? 'success' : 'default'}
            label={flat ? '평탄→미주입' : injectable > 0 ? `주입후보 ${injectable}` : 'lift 부족'}
          />
        </>
      }
      intent={
        <>
          추첨 <strong>전</strong> 등록 보관 용지만 학습(누수 없음). 적용은 탭별 —
          복기=<strong>소급</strong>, 이번회차=<strong>예상</strong>. <strong>평탄·lift&lt;1.05는 점수 미주입</strong>.
        </>
      }
    >
      <ExplainArtifactBlock
        explain={d.explain}
        title={`Explain — 다회차 (${d.explain?.decision ?? 'neutral'})`}
      />
      <Stack spacing={1.25}>
        <EngineSubBlock
          tone="primary"
          title="A. 회차별 지지 상위6"
          chips={<EngineStatusChip variant="outlined" label={`${d.round_count}회`} />}
        >
          <Stack spacing={0.5}>
            {(d.rounds ?? []).map((r) => (
              <Stack
                key={r.round_no}
                direction="row"
                spacing={0.75}
                alignItems="center"
                flexWrap="wrap"
                useFlexGap
                sx={{ p: 0.75, borderRadius: 1, bgcolor: 'background.paper' }}
              >
                <Typography sx={{ fontWeight: 800, fontSize: 12, minWidth: 52 }}>{r.round_no}회</Typography>
                <EngineStatusChip
                  variant="outlined"
                  label={`자동 ${r.auto_line_count}·반 ${r.semi_line_count}`}
                />
                <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>지지 상위6:</Typography>
                {r.top6_by_support.map((n) => (
                  <LottoBall
                    key={`${r.round_no}-${n}`}
                    number={n}
                    size={ENGINE_BALL.table}
                    dimmed={!r.winning_numbers.includes(n)}
                  />
                ))}
                <EngineStatusChip
                  color={r.top6_hits >= 2 ? 'success' : r.top6_hits === 1 ? 'warning' : 'default'}
                  label={`적중 ${r.top6_hits}/6`}
                />
              </Stack>
            ))}
          </Stack>
        </EngineSubBlock>

        <EngineSubBlock
          tone="info"
          title="B. 양쪽 지지 구간 캘리브레이션"
          chips={
            <EngineStatusChip
              color={flat ? 'warning' : 'success'}
              label={flat ? '평탄(신호 약함)' : '구간 편차 있음'}
            />
          }
        >
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5, fontSize: 10 }}>
            기준선 13.3% = 6/45. lift≈1이면 지지 구조가 당첨을 가르치지 못함(무작위 정상).
          </Typography>
          <Stack spacing={0.4}>
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
                  {((c.hit_rate ?? 0) * 100).toFixed(1)}% · lift {c.lift} · {c.won}/{c.played}
                </Typography>
                {c.significance && (
                  <Typography sx={{ width: 74, fontSize: 9, textAlign: 'right', fontWeight: 700, color: c.significance.significant ? 'success.main' : 'text.disabled' }}>
                    p={c.significance.p_value}{c.significance.significant ? '✓' : c.significance.small_sample ? '·소표본' : ''}
                  </Typography>
                )}
              </Stack>
            ))}
          </Stack>
          {d.summary?.top6_significance && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 9.5, mt: 0.5 }}>
              지지 상위6 종합: 적중 {d.summary.top6_significance.hits}/{d.summary.top6_significance.trials} ·
              기대 {d.summary.top6_significance.expected} · lift {d.summary.top6_significance.lift} ·
              p={d.summary.top6_significance.p_value}{' '}
              {d.summary.top6_significance.significant ? '(✓ 유의)' : d.summary.top6_significance.small_sample ? '(소표본 — 우연 가능)' : '(미유의)'}
            </Typography>
          )}
          {flat && (
            <Alert severity="info" sx={{ mt: 1, py: 0.25 }}>
              구간별 적중률이 <strong>거의 평탄</strong>합니다 — ③ 추천 점수에는 넣지 않습니다.
            </Alert>
          )}
        </EngineSubBlock>

        <EngineSubBlock
          tone="warning"
          title={`C. ${d.current_round_no ?? '?'}회 ${d.apply_label ?? (sheetIntent === 'review' ? '복기' : '이번회차')} ${sheetIntent === 'review' ? '소급' : '예상'} 적용`}
          chips={
            <>
              <EngineStatusChip variant="outlined" label={sheetIntent === 'review' ? '복기 탭' : '이번회차 탭'} />
              <EngineStatusChip
                variant="outlined"
                label={scores.length > 0 ? `${scores.length}개 · 주입게이트 lift≥1.05` : '적용 없음'}
              />
            </>
          }
        >
          {scores.length > 0 ? (
            <>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
                {scores.map((s) => (
                  <Box key={`rl-${s.number}`} sx={{ textAlign: 'center', minWidth: 38 }}>
                    <LottoBall number={s.number} size={ENGINE_BALL.list} />
                    <Typography sx={{ fontSize: 8, color: 'text.disabled', lineHeight: 1.1 }}>{s.score}</Typography>
                    <Typography sx={{ fontSize: 7.5, color: 'text.disabled', lineHeight: 1 }}>
                      자{s.auto}·반{s.semi}
                      {(s.learned_lift ?? 1) >= 1.05 ? ' ·✓' : ''}
                    </Typography>
                  </Box>
                ))}
              </Stack>
              {top6.length === 6 && (
                <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Typography variant="caption" fontWeight={700} sx={{ fontSize: 11 }}>
                    학습 상위6:
                  </Typography>
                  {top6.map((n) => (
                    <LottoBall key={`rlt-${n}`} number={n} size={ENGINE_BALL.list} />
                  ))}
                  <SharingBadge numbers={top6} />
                  <ComboActions numbers={top6} source="unknown" label="다회차 학습 상위6" />
                </Stack>
              )}
            </>
          ) : (
            <Alert severity="info" sx={{ py: 0.25 }}>
              {(d.current_auto_lines ?? 0) + (d.current_semi_lines ?? 0) > 0 ? (
                <>
                  {sheetIntent === 'review' ? '복기' : '이번회차'} 용지는 등록돼 있으나(자동 {d.current_auto_lines ?? 0}줄 · 반자동{' '}
                  {d.current_semi_lines ?? 0}줄) 학습 점수를 낼 수 없습니다.
                  {d.current_one_sided
                    ? ' 한쪽만 등록돼 양쪽 지지가 0입니다 — 나머지 한쪽도 등록하세요.'
                    : ''}
                </>
              ) : (
                sheetIntent === 'review'
                  ? '복기 용지가 없어 소급 적용 대상이 없습니다. 복기 탭에 자동·반자동 용지를 등록하세요.'
                  : '이번회차 용지가 없어 예상 적용 대상이 없습니다. 이번회차 탭에 용지를 등록하세요.'
              )}
            </Alert>
          )}
        </EngineSubBlock>

        <Typography variant="caption" sx={{ display: 'block', fontStyle: 'italic', color: 'text.disabled', fontSize: 9 }}>
          ⚠️ {d.honesty}
        </Typography>
      </Stack>
    </EngineSection>
  );
}
