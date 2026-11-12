/**
 * V5 Prediction Reverse Analysis · V6 Auto Correction · V7 Self Optimization · 모듈 재검증 · 확률 검증.
 * 서버에 저장된 마지막 실행 결과를 보여 준다(새 회차가 들어오면 일일 파이프라인이 자동 갱신).
 */
import { Alert, Box, Chip, LinearProgress, Stack, Typography } from '@mui/material';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EngineSection, EngineStatusChip } from './EngineSection';
import { v1Api } from '../api/v1Api';

const CAUSE: Record<string, string> = {
  data_collection: '데이터 수집·갱신', preprocessing: '전처리', feature: 'Feature', weight: '가중치·결합',
  pattern: '패턴', combination_generation: '조합 생성 조건', validation: '검증', chance: '통계적 우연',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 0.5 }}>{title}</Typography>
      {children}
    </Box>
  );
}

const fmt = (s?: string) => (s ? new Date(s).toLocaleString('ko-KR', { hour12: false }) : '—');

export default function ReverseAnalysisPanel() {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['v1-reverse-report'], queryFn: v1Api.getReverseReport, enabled: open, staleTime: 300_000 });
  const r = q.data;
  const v5 = r?.v5;
  const v6 = r?.v6;
  const v7 = r?.v7;
  const mod = r?.modules;
  const approved = (r?.approved_models ?? []) as any[];

  return (
    <EngineSection
      tone="info"
      title="🔁 V5 역분석 · V6 자동 보정 · V7 자기개선"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      defaultOpen={false}
      chips={r ? <EngineStatusChip color={approved.length ? 'success' : 'default'} label={`승인 모델 ${approved.length}`} /> : undefined}
      intent={<>과거 회차별 예측과 실제 당첨을 대조해 고성과·저성과 구간을 역산하고, 원인 후보를 기존 모델의 복사본으로 만들어 같은 검증 구간에서 비교합니다. 선택에 쓰지 않은 홀드아웃에서 보정 후 유의할 때만 승인하며, 승인되지 않으면 기존 모델을 유지합니다.</>}
    >
      {q.isLoading && <LinearProgress />}
      {r && !v5 && !v7 && <Alert severity="info">아직 실행 기록이 없습니다. 새 회차가 반영되면 일일 파이프라인이 자동 실행합니다.</Alert>}

      {v5 && (
        <Section title={`V5 Prediction Reverse Analysis · ${v5.block_size}회 구간 · 저장 ${fmt(v5.saved_at)}`}>
          <Alert severity="info" sx={{ py: 0.25, mb: 0.5 }}><Typography variant="caption">{v5.summary?.conclusion}</Typography></Alert>
          <Typography variant="caption" component="div" color="text.secondary">
            격리된 예측 {v5.inventory?.quarantine?.total ?? 0}건(원본 보존·집계 제외) · 분석 엔진 {v5.summary?.methods_analyzed}개 ·
            구간 효과 유의 {(v5.summary?.methods_with_real_period_effect ?? []).length}개 · 변화점 유의 {(v5.summary?.methods_with_change_point ?? []).length}개
          </Typography>
          <Stack spacing={0.5} sx={{ mt: 0.5 }}>
            {(v5.methods as any[]).map((m) => (
              <Box key={m.method} sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 0.75 }}>
                <Typography variant="caption" sx={{ fontWeight: 700 }}>{m.method} · {m.rounds}회 평균 {m.mean}</Typography>
                <Typography variant="caption" component="div">
                  고성과 {m.high_blocks.map((b: any) => `${b.from}~${b.to}(${b.mean})`).join(', ')} · 저성과{' '}
                  {m.low_blocks.map((b: any) => `${b.from}~${b.to}(${b.mean})`).join(', ')}
                </Typography>
                <Typography variant="caption" component="div" color="text.secondary">
                  구간 이질성 p={m.heterogeneity?.p ?? '-'} · 변화점 {m.change_point?.round ?? '-'}회(p={m.change_point?.p_perm ?? '-'})
                  {m.drop_start_round ? ` · 하락 시작 ${m.drop_start_round}회 · 회복 ${m.recovery_round ?? '미회복'}` : ''}
                </Typography>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.25 }}>
                  {(m.causes as any[]).map((c, i) => (
                    <Chip key={i} size="small" variant="outlined" color={c.category === 'chance' ? 'default' : 'warning'}
                      label={`${CAUSE[c.category] ?? c.category}: ${c.finding}`} sx={{ maxWidth: '100%', height: 'auto', '& .MuiChip-label': { whiteSpace: 'normal' } }} />
                  ))}
                </Stack>
                <Typography variant="caption" component="div" color="text.secondary">{m.verdict}</Typography>
              </Box>
            ))}
          </Stack>
          <Typography variant="caption" component="div" sx={{ mt: 0.5 }}>
            특징 ↔ 일치 수(전체 {v5.feature_vs_matches?.[0]?.n}건):{' '}
            {(v5.feature_vs_matches as any[]).map((f) => `${f.label} ρ=${f.spearman_vs_matches}${f.significant_bonferroni ? '★' : ''}`).join(' · ')}
          </Typography>
        </Section>
      )}

      {v6 && (
        <Section title={`V6 Auto Correction · 모델 버전 ${String(v6.version_id ?? '').slice(0, 8)}`}>
          <Typography variant="caption" component="div">
            후보 {v6.candidates}개(원본 복사 + 한 가지 변경, 회차당 1조합·동일 비용) · 선택 {v6.selection_range} → 홀드아웃 {v6.holdout_range}
          </Typography>
          <Typography variant="caption" component="div" sx={{ fontWeight: 700 }}>
            최고 후보 {v6.best_candidate}({v6.axis}) 선택기간 {v6.selection_mean_best} → 홀드아웃 {v6.holdout_mean_candidate} vs 원본 {v6.base}{' '}
            {v6.holdout_mean_base} (무작위 0.8, p_원본={v6.p_vs_base}, p_무작위={v6.p_vs_random}, α={v6.alpha_bonferroni})
          </Typography>
          <Chip size="small" color={v6.status === 'promoted' ? 'success' : 'default'} label={v6.status === 'promoted' ? '승인' : '기각 — 기존 모델 유지'} sx={{ my: 0.5 }} />
          <Typography variant="caption" component="div" color="text.secondary">{v6.reason} · 과적합 격차(선택−홀드아웃) {v6.overfit_gap}</Typography>
          <Typography variant="caption" component="div" color="text.secondary">
            선택기간 상위: {(v6.selection_table as any[]).slice(0, 5).map((t) => `${t.candidate} ${t.selection_mean}(원본 ${t.base_selection_mean})`).join(' · ')}
          </Typography>
        </Section>
      )}

      {v7 && (
        <Section title={`V7 Self Optimization · ${v7.latest_round}회 결과 반영 → ${v7.next_round}회 적용 결정`}>
          {(v7.steps as any[]).map((s, i) => (
            <Typography key={i} variant="caption" component="div">
              {i + 1}. {s.step}
              {s.step.startsWith('적중') && Array.isArray(s.result) && `: ${s.result.length ? s.result.map((x: any) => `${x.method} ${x.matches}개`).join(', ') : '이 회차 사전 예측 없음'}`}
            </Typography>
          ))}
          <Alert severity={approved.length ? 'success' : 'info'} sx={{ py: 0.25, mt: 0.5 }}>
            <Typography variant="caption">{v7.decision}</Typography>
          </Alert>
        </Section>
      )}

      {mod && (
        <Section title={`기존 모듈 재검증 (입력: ${mod.input_source === 'youtube' ? '유튜브 확정 용지' : mod.input_source}, 표본 ${mod.samples}회)`}>
          <Typography variant="caption" component="div">V1 Walk-Forward: {mod.v1?.walk_forward?.detail}</Typography>
          <Typography variant="caption" component="div">V1 Permutation: {mod.v1?.permutation?.issue}</Typography>
          <Typography variant="caption" component="div">
            V1 무작위 당첨 대입 시 거짓 채택: {mod.v1?.null_gate_false_adoption?.status === 'measured'
              ? `실행당 ${mod.v1.null_gate_false_adoption.adopted_per_run}개(${mod.v1.null_gate_false_adoption.runs_with_any_adoption}/${mod.v1.null_gate_false_adoption.runs}회)`
              : '표본 부족으로 미측정'}
          </Typography>
          <Typography variant="caption" component="div">Nested CV: 시간순 {mod.nested_cv?.time_order} · {mod.nested_cv?.inner_split}</Typography>
          <Typography variant="caption" component="div">SHAP/Drift: {mod.shap_drift?.detail}</Typography>
          <Typography variant="caption" component="div">V2: {mod.v2_pattern_mining?.detail}</Typography>
          <Typography variant="caption" component="div">
            V3·V4-A 기록: {Object.entries(mod.v3_v4a_recorded_performance ?? {}).map(([k, v]: any) => `${v.label} ${v.rounds}회${v.mean != null ? ` 평균 ${v.mean}` : ''}`).join(' · ')}
          </Typography>
          <Typography variant="caption" component="div" color="text.secondary">{mod.overall}</Typography>
        </Section>
      )}

      {r?.probability && (
        <Section title="확률 검증">
          <Typography variant="caption" component="div">
            수학적 확률: 1등 {r.probability.mathematical.first_prize} · 3개 이상 일치 {(r.probability.mathematical.match3plus * 100).toFixed(2)}% · 기대 일치 {r.probability.mathematical.expected_matches}
          </Typography>
          <Typography variant="caption" component="div">
            과거 관측(백테스트 {r.probability.observed_backtest.predictions}건): 3+ {((r.probability.observed_backtest.rates?.['3+'] ?? 0) * 100).toFixed(2)}% · 4+{' '}
            {((r.probability.observed_backtest.rates?.['4+'] ?? 0) * 100).toFixed(3)}%
          </Typography>
          <Typography variant="caption" component="div" color="text.secondary">{r.probability.calibration}</Typography>
          <Typography variant="caption" component="div" color="text.secondary">{r.probability.statement}</Typography>
        </Section>
      )}
    </EngineSection>
  );
}
