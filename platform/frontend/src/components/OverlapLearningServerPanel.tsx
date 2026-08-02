/**
 * 검증학습 V4-A. 줄겹침(다회차 서버) — getOverlapLearning.
 * 복기 프로파일(V4-B)과 분리: 서버가 우선 주입, 평탄이면 미주입.
 */
import { Alert, Box, LinearProgress, Stack, Typography } from '@mui/material';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import LottoBall from './LottoBall';
import { ENGINE_BALL, EngineSection, EngineStatusChip, EngineSubBlock } from './EngineSection';
import { ExplainArtifactBlock } from './ExplainArtifactBlock';
import { v1Api } from '../api/v1Api';

export default function OverlapLearningServerPanel({
  sheetIntent = 'current_round',
}: {
  sheetIntent?: 'review' | 'current_round';
}) {

  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['v1-photo-overlap-learning', sheetIntent],
    queryFn: () => v1Api.getOverlapLearning({ applyIntent: sheetIntent }),
    staleTime: 300_000,
    retry: 1,
    enabled: open, // ④ 펼침 시 동시요청 폭주 방지 — 이 패널 열 때만 발화
  });

  if (q.isLoading) {
    return (
      <EngineSection tone="success" title="V4-A. 줄겹침 (다회차 서버)" id="learn-v4a" sx={{ mb: 2 }}>
        <LinearProgress />
      </EngineSection>
    );
  }
  if (q.isError) {
    return (
      <EngineSection tone="success" title="V4-A. 줄겹침 (다회차 서버)" id="learn-v4a" sx={{ mb: 2 }}>
        <Alert severity="error">
          {q.error instanceof Error ? q.error.message : '서버 오류'}
        </Alert>
      </EngineSection>
    );
  }
  const d = q.data;
  if (!d) {
    // 접힘(미조회) 상태 — 펼치면 그때 발화(④ 동시요청 폭주 방지)
    return (
      <EngineSection
        tone="success"
        title="V4-A. 줄겹침 (다회차 서버)"
        id="learn-v4a"
        collapsible
        open={open}
        onToggle={() => setOpen((v) => !v)}
        sx={{ mb: 2 }}
        chips={<EngineStatusChip color="default" label="펼치면 분석" />}
      >
        <LinearProgress />
      </EngineSection>
    );
  }
  if (!d.ok) {
    return (
      <EngineSection
        tone="success"
        title="V4-A. 줄겹침 (다회차 서버)"
        id="learn-v4a"
        collapsible
        open={open}
        onToggle={() => setOpen((v) => !v)}
        sx={{ mb: 2 }}
        chips={<EngineStatusChip color="default" label="표본 없음" />}
        intent="다회차 줄겹침 조합×당첨 역산. 표본이 쌓이면 채워집니다."
      >
        <Alert severity="info">{d.reason ?? '겹침 학습 표본이 아직 없습니다.'}</Alert>
      </EngineSection>
    );
  }

  const flat = Boolean(d.calibration_flat);
  const scores = d.current_scores ?? [];

  return (
    <EngineSection
      tone="success"
      title={`V4-A. 줄겹침 (다회차 서버 · ${d.round_count}회)`}
      id="learn-v4a"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      sx={{ mb: 2 }}
      chips={
        <>
          <EngineStatusChip variant="outlined" label={`조합 ${d.total_combos ?? 0}`} />
          <EngineStatusChip
            color={flat ? 'warning' : scores.length > 0 ? 'success' : 'default'}
            label={flat ? '평탄→미주입' : scores.length > 0 ? `주입후보 ${scores.length}` : '적용 없음'}
          />
        </>
      }
      intent={
        <>
          다회차 보관 용지의 2·3·4번호 줄겹침이 당첨을 담았는지 누적합니다.
          <strong> 검증학습 우선 소스</strong>(V4-B 클라보다 앞). 평탄이면 점수 미주입.
          L7(현재 1:1 세트중복)과 축이 다릅니다.
        </>
      }
    >
      <ExplainArtifactBlock
        explain={d.explain}
        title={`Explain — 줄겹침 (${d.explain?.decision ?? 'neutral'})`}
      />
      <Stack spacing={1.25}>
        <EngineSubBlock tone="success" title="A. 크기별 lift">
          <Stack spacing={0.4}>
            {(d.by_size ?? []).map((s) => (
              <Stack key={`ovs-${s.size}`} direction="row" spacing={1} alignItems="center">
                <Typography sx={{ width: 88, fontSize: 11, fontWeight: 700 }}>{s.size}번호 겹침</Typography>
                <EngineStatusChip
                  color={s.lift_vs_chance >= 1.3 ? 'success' : s.lift_vs_chance >= 0.8 ? 'info' : 'default'}
                  label={`×${s.lift_vs_chance}`}
                />
                <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>
                  평균 {s.mean_overlap} (기대 {s.expected}) · {s.combos}건 · 전부당첨 {s.fully_winning}
                </Typography>
              </Stack>
            ))}
          </Stack>
        </EngineSubBlock>

        {d.signal_comparison?.signals && d.signal_comparison.rounds > 0 && (
          <EngineSubBlock
            tone="info"
            title={`B. 신호 정면비교 (${d.signal_comparison.rounds}회 평균)`}
          >
            <Stack spacing={0.3}>
              {d.signal_comparison.signals.map((s) => (
                <Typography key={s.key} sx={{ fontSize: 10.5 }}>
                  <strong>{s.label}</strong> — top6 {s.mean_top6} · top10 {s.mean_top10} · top18 {s.mean_top18}
                </Typography>
              ))}
            </Stack>
            {d.signal_comparison.verdict && (
              <Alert
                severity={d.signal_comparison.verdict.includes('앞섬') ? 'warning' : 'info'}
                sx={{ mt: 0.75, py: 0.25 }}
              >
                판정: <strong>{d.signal_comparison.verdict}</strong>
              </Alert>
            )}
          </EngineSubBlock>
        )}

        <EngineSubBlock
          tone="warning"
          title={`C. ${d.current_round_no ?? '?'}회 ${d.apply_label ?? (sheetIntent === 'review' ? '복기' : '이번회차')} ${sheetIntent === 'review' ? '소급' : '예상'} 적용`}
          chips={
            <>
              <EngineStatusChip variant="outlined" label={sheetIntent === 'review' ? '복기 탭' : '이번회차 탭'} />
              <EngineStatusChip variant="outlined" label={flat ? '평탄 게이트' : `${scores.length}개`} />
            </>
          }
        >
          {scores.length > 0 ? (
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              {scores.map((s) => (
                <Box key={`ovc-${s.number}`} sx={{ textAlign: 'center', minWidth: 36 }}>
                  <LottoBall number={s.number} size={ENGINE_BALL.list} />
                  <Typography sx={{ fontSize: 8, color: 'text.disabled', lineHeight: 1.1 }}>{s.score}</Typography>
                  <Typography sx={{ fontSize: 7.5, color: 'text.disabled', lineHeight: 1 }}>
                    {s.combo_support}조합
                  </Typography>
                </Box>
              ))}
            </Stack>
          ) : (
            <Alert severity="info" sx={{ py: 0.25 }}>
              {sheetIntent === 'review'
                ? '복기 겹침 조합이 없어 소급 적용 대상이 없습니다(자동 용지 2줄 이상 필요).'
                : '이번회차 겹침 조합이 없어 예상 적용 대상이 없습니다(자동 용지 2줄 이상 필요).'}
            </Alert>
          )}
        </EngineSubBlock>

        {d.honesty && (
          <Typography variant="caption" sx={{ fontStyle: 'italic', color: 'text.disabled', fontSize: 9 }}>
            ⚠️ {d.honesty}
          </Typography>
        )}
      </Stack>
    </EngineSection>
  );
}
