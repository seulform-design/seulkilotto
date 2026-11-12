/**
 * 통합 마스터 엔진 — V12 현재 회차 후보(번호 A/B/C·10조합) · V12 독립 검증 · V8 누수 · V9 신뢰도 · V10 번호 편향 · V11 무작위.
 * 서버에 저장된 마지막 실행 결과(일일 파이프라인이 자동 갱신)를 보여 준다.
 */
import { Alert, Box, Chip, LinearProgress, Stack, Typography } from '@mui/material';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EngineSection, EngineStatusChip } from './EngineSection';
import { v1Api } from '../api/v1Api';

const GROUP: Record<string, { label: string; color: 'primary' | 'secondary' | 'warning' }> = {
  core: { label: '핵심', color: 'primary' },
  dispersion: { label: '분산', color: 'secondary' },
  experimental: { label: '실험', color: 'warning' },
};
const TIER_COLOR: Record<string, string> = { A: 'primary.main', B: 'secondary.main', C: 'warning.main', '-': 'text.disabled' };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 0.5 }}>{title}</Typography>
      {children}
    </Box>
  );
}

function Ball({ n, tier }: { n: number; tier?: string }) {
  return (
    <Box component="span" sx={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: '50%',
      border: 2, borderColor: TIER_COLOR[tier ?? '-'] ?? 'divider', fontSize: 12, fontWeight: 800, mr: 0.4,
    }}>{n}</Box>
  );
}

export default function MasterEnginePanel() {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['v1-master-report'], queryFn: v1Api.getMasterReport, enabled: open, staleTime: 300_000 });
  const r = q.data;
  const v12 = r?.v12;
  const val = r?.v12_validation;
  const tierOf: Record<number, string> = {};
  (v12?.numbers ?? []).forEach((x: any) => { tierOf[x.number] = x.tier; });

  return (
    <EngineSection
      tone="success"
      title="🎯 통합 마스터 엔진 V8~V12 · 현재 회차 후보"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      defaultOpen={false}
      chips={v12 ? <EngineStatusChip color="info" label={`${v12.target_round}회 대상`} /> : undefined}
      intent={<>모든 엔진의 과거 예측을 공식 결과와 대조하고 누수를 차단(V8)한 뒤, 신뢰도(V9)·번호 편향(V10)·같은 조건 무작위 비교(V11)를 거쳐 현재 회차 번호를 A/B/C로 나누고 10조합을 만듭니다(V12). 점수는 과거 데이터 요약이며 당첨 확률을 바꾸지 않습니다.</>}
    >
      {q.isLoading && <LinearProgress />}
      {r && !v12 && <Alert severity="info">아직 실행 기록이 없습니다. 일일 파이프라인이 자동 실행합니다.</Alert>}

      {v12 && (
        <Section title={`V12 현재 회차 — ${v12.target_round}회 (추첨 ${v12.draw_date}, 마감 ${v12.data_cutoff_kst})`}>
          <Typography variant="caption" component="div">
            데이터 기준: {v12.data_basis} · 최신 {v12.latest_official_round}회({v12.latest_draw_date}) {(v12.latest_numbers ?? []).join(', ')} + 보너스 {v12.latest_bonus}
          </Typography>
          <Typography variant="caption" component="div" color="text.secondary">
            엔진 추천 출처: {v12.vote_source} · {(v12.engines_voting ?? []).length}개 엔진 · 가중치 {v12.weights_version}(사전 고정)
            {v12.combos_frozen_at ? ` · 사전 예측 저장 ${new Date(v12.combos_frozen_at).toLocaleString('ko-KR', { hour12: false })}(불변)` : ''}
            {v12.save_note ? ` · ${v12.save_note}` : ''}
          </Typography>
          {(['A', 'B', 'C'] as const).map((t) => (
            <Box key={t} sx={{ mt: 0.5 }}>
              <Typography variant="caption" sx={{ fontWeight: 700, mr: 0.5 }}>
                {t === 'A' ? 'A 통합 후보' : t === 'B' ? 'B 보완 후보' : 'C 실험 후보'}
              </Typography>
              {(v12.groups?.[t] ?? []).map((n: number) => <Ball key={n} n={n} tier={t} />)}
            </Box>
          ))}
          <Stack spacing={0.5} sx={{ mt: 1 }}>
            {(v12.combos as any[]).map((c) => (
              <Box key={c.rank} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap', border: 1, borderColor: 'divider', borderRadius: 1.5, p: 0.5 }}>
                <Chip size="small" color={GROUP[c.group]?.color ?? 'default'} label={`${c.rank}. ${GROUP[c.group]?.label ?? c.group}`} />
                <Box>{c.numbers.map((n: number) => <Ball key={n} n={n} tier={tierOf[n]} />)}</Box>
                <Typography variant="caption" color="text.secondary">
                  조합점수 {c.combo_score} · 홀{c.structure?.odd}·저{c.structure?.low}·합{c.structure?.sum}·연속{c.structure?.consec}·끝수{c.structure?.last_digits}·구간최대{c.structure?.max_decade}
                </Typography>
              </Box>
            ))}
          </Stack>
          <Typography variant="caption" component="div" color="text.secondary" sx={{ mt: 0.5 }}>
            {v12.probability?.statement} 1조합 1등 {v12.probability?.each_combo_first_prize}, 서로 다른 10조합 {v12.probability?.ten_combos_first_prize}.
          </Typography>
        </Section>
      )}

      {v12 && (
        <Section title="1~45 번호 평가 순위">
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))', gap: 0.5 }}>
            {(v12.numbers as any[]).map((x) => (
              <Box key={x.number} sx={{ border: 1, borderColor: TIER_COLOR[x.tier] ?? 'divider', borderRadius: 1, p: 0.5 }}>
                <Typography variant="caption" sx={{ fontWeight: 800, display: 'block' }}>{x.rank}. {x.number}</Typography>
                <Typography variant="caption" sx={{ fontSize: 10, display: 'block' }}>점수 {x.score}</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, display: 'block' }}>
                  20회 {x.freq_20}·미출 {x.gap}·추천 {x.engine_votes}
                </Typography>
              </Box>
            ))}
          </Box>
        </Section>
      )}

      {val && (
        <Section title={`V12 독립 검증 — ${val.from}~${val.to}회 walk-forward (같은 10조합/회차 무작위와 비교)`}>
          {Object.entries(val.groups ?? {}).map(([g, x]: any) => (
            <Typography key={g} variant="caption" component="div">
              {g === 'all' ? '전체' : GROUP[g]?.label ?? g} {x.games}게임 · 평균 {x.mean} (무작위 95% {x.random_mean_ci95?.[0]}~{x.random_mean_ci95?.[1]}, p={x.p_ge_random}) · 3개+ {x.hit3}회(무작위 중앙 {x.random_hit3_p50})
            </Typography>
          ))}
          <Typography variant="caption" component="div" color="text.secondary">
            비교: 사후 최고 단일 엔진 {val.best_single_engine?.method} {val.best_single_engine?.mean} · 누수 위반 {val.leak_violations}건
          </Typography>
          <Alert severity={val.status === 'promoted' ? 'success' : 'info'} sx={{ py: 0.25, mt: 0.5 }}>
            <Typography variant="caption">{val.verdict}</Typography>
          </Alert>
        </Section>
      )}

      {r?.v8 && (
        <Section title="V8 사후 백테스트 · 누수 차단">
          <Typography variant="caption" component="div">
            상태 {r.v8.status === 'ok' ? '이상 없음' : '문제 발견'} · 격리 {r.v8.quarantine?.total ?? 0}건 · 재계산 일치 검사 {r.v8.replay_check?.checked}건 중 불일치 {r.v8.replay_check?.mismatched}건
          </Typography>
          <Typography variant="caption" component="div" color="text.secondary">
            {Object.entries(r.v8.by_type ?? {}).map(([t, x]: any) => `${t} ${x.rows}건`).join(' · ')} — live=사전 예측, historical_replay=사후 재현(실시간 성과 아님)
          </Typography>
        </Section>
      )}

      {r?.v9 && (
        <Section title="V9 엔진 신뢰도 (최근 20·50·100회·전체, 무작위 0.8)">
          <Stack spacing={0.25}>
            {(r.v9.methods as any[]).filter((m) => m.type === 'backtest' || m.periods.all.rounds >= 5).map((m) => (
              <Typography key={`${m.type}-${m.method}`} variant="caption" component="div">
                <b>{m.method}</b>({m.type}) 20회 {m.periods.last20.mean ?? '-'} · 50회 {m.periods.last50.mean ?? '-'} · 100회 {m.periods.last100.mean ?? '-'} · 전체 {m.periods.all.mean}
                ({m.periods.all.rounds}회, 95% {m.periods.all.ci95?.[0]}~{m.periods.all.ci95?.[1]}) · 3+ {m.periods.all.hit3} · 4+ {m.periods.all.hit4} · 변동성 {m.volatility_rolling20 ?? '-'} · {m.grade}
              </Typography>
            ))}
          </Stack>
        </Section>
      )}

      {r?.v10 && (
        <Section title="V10 번호 편향">
          <Typography variant="caption" component="div">
            추천 과다 번호 {(r.v10.most_over_recommended ?? []).join(', ')} · 유효 독립 엔진 {r.v10.engine_overlap?.effective_independent_engines}/{r.v10.engine_overlap?.engines} ·
            추천 상관 최고 {(r.v10.recommendation_correlation_top ?? []).slice(0, 3).map((p: any) => `${p.a}~${p.b} ${p.corr}`).join(' · ')}
          </Typography>
          <Typography variant="caption" component="div" color="text.secondary">
            번호별 적중률 보정 후 유의: {r.v10.any_number_hit_rate_significant ? '있음(재현 확인 필요)' : '없음'} — {r.v10.note}
          </Typography>
        </Section>
      )}

      {r?.v11 && (
        <Section title={`V11 무작위 시뮬레이션 (${r.v11.simulations}회, 같은 게임 수)`}>
          {(r.v11.methods as any[]).map((m) => (
            <Typography key={`${m.type}-${m.method}`} variant="caption" component="div">
              {m.method}({m.type}) {m.games}게임 평균 {m.engine_mean} · 무작위 95% {m.random_mean_ci95?.[0]}~{m.random_mean_ci95?.[1]} · 백분위 {(m.percentile_vs_random * 100).toFixed(0)}% · 3+ {m.engine_hit3}(무작위 중앙 {m.random_hit3_p50})
            </Typography>
          ))}
        </Section>
      )}
    </EngineSection>
  );
}
