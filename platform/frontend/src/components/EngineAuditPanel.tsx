/**
 * 엔진 감사 대시보드 — A 성능 순위 · B 번호별(1~45) · C 공통번호 교차분석 · D 저성과/개선 실험 · F 통계 신뢰도.
 * (E 회차별 예측 비교는 '회차별 예측 기록' 패널.) 모두 저장된 실제 예측·평가 기록에서 계산.
 */
import { Alert, Box, Chip, LinearProgress, Stack, Typography } from '@mui/material';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EngineSection, EngineStatusChip } from './EngineSection';
import { v1Api } from '../api/v1Api';

const LABEL: Record<string, string> = {
  stats_hot: '통계·핫', stats_cold: '통계·콜드', stats_overdue: '통계·미출', stats_recent: '통계·최근',
  stats_pair_hot: '통계·동반', stats_last_avoid: '통계·직전회피', engine_machine: '추첨기', engine_classic: '클래식',
  engine_parallel: '평행회차', engine_decade: '구간미출', random_baseline: '무작위 기준선', ensemble: '앙상블',
};
const STATUS: Record<string, { label: string; color: 'default' | 'warning' | 'error' | 'success' | 'info' }> = {
  normal: { label: '무작위와 구분 안 됨', color: 'default' },
  insufficient_data: { label: '표본 부족', color: 'info' },
  underperform_significant: { label: '유의한 저성과', color: 'error' },
  outperform_significant: { label: '유의한 우위(재현 필요)', color: 'success' },
  recent_drop_watch: { label: '최근 하락 관찰', color: 'warning' },
  leak_detected: { label: '누수 감지', color: 'error' },
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 0.5 }}>{title}</Typography>
      {children}
    </Box>
  );
}

export default function EngineAuditPanel() {
  const [open, setOpen] = useState(false);
  const [num, setNum] = useState<number | null>(null);
  const rep = useQuery({ queryKey: ['v1-audit-report'], queryFn: v1Api.getAuditReport, enabled: open, staleTime: 300_000 });
  const nums = useQuery({ queryKey: ['v1-audit-numbers'], queryFn: v1Api.getAuditNumbers, enabled: open, staleTime: 300_000 });
  const nd = useQuery({ queryKey: ['v1-audit-number', num], queryFn: () => v1Api.getAuditNumber(num as number), enabled: num != null });
  const r = rep.data;
  const ans = r?.answers;

  return (
    <EngineSection
      tone="warning"
      title="🧪 엔진 성능 감사 · 공통번호 교차검증"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      defaultOpen={false}
      chips={r ? <EngineStatusChip color={r.audit?.alerts?.length ? 'warning' : 'success'} label={`경고 ${r.audit?.alerts?.length ?? 0}`} /> : undefined}
      intent={<>모든 엔진의 회차별 예측 기록(그 회차 이전 데이터만 사용)으로 성능·저성과 원인·공통번호의 실제 적중·엔진 간 독립성·앙상블 개선 여부를 무작위 기준선과 비교합니다. 입증되지 않은 결과는 미검증으로 표시합니다.</>}
    >
      {(rep.isLoading || nums.isLoading) && <LinearProgress />}
      {r && (
        <>
          <Alert severity="info" sx={{ py: 0.25 }}>
            <Typography variant="caption">{ans?.statistically_supported_claims}</Typography>
          </Alert>

          <Section title="A. 엔진 성능 순위 (1조합/회차, 무작위 기대 0.8개)">
            <Stack spacing={0.5}>
              {(r.performance.methods as any[]).map((m) => {
                const st = STATUS[m.diagnosis.status] ?? STATUS.normal;
                const a = m.periods.all;
                return (
                  <Box key={m.method} sx={{ border: 1, borderColor: m.method === 'random_baseline' ? 'info.main' : 'divider', borderRadius: 1.5, p: 0.75 }}>
                    <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Typography variant="caption" sx={{ fontWeight: 700 }}>{LABEL[m.method] ?? m.method}</Typography>
                      <Chip size="small" variant="outlined" color={st.color} label={st.label} />
                    </Stack>
                    <Typography variant="caption" component="div">
                      전체 {a.rounds}회 평균 {a.mean} (95% {a.ci95?.[0]}~{a.ci95?.[1]}) · 최근100 {m.periods.last100.mean ?? '-'} · 최근30 {m.periods.last30.mean ?? '-'} · 3+ {((a.rate_3plus ?? 0) * 100).toFixed(1)}% · 보너스 {((a.bonus_rate ?? 0) * 100).toFixed(1)}%
                    </Typography>
                    <Typography variant="caption" color="text.secondary" component="div">{m.diagnosis.causes.join(' / ')}</Typography>
                  </Box>
                );
              })}
            </Stack>
          </Section>

          <Section title="B. 번호별 통계 (번호를 누르면 선택 엔진·회차)">
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(58px, 1fr))', gap: 0.5 }}>
              {(nums.data?.stats?.numbers ?? []).map((n: any) => {
                const sel = (nums.data?.selection ?? [])[n.number - 1];
                return (
                  <Box key={n.number} onClick={() => setNum(n.number)}
                    sx={{ border: 1, borderColor: num === n.number ? 'primary.main' : 'divider', borderRadius: 1, p: 0.5, cursor: 'pointer' }}>
                    <Typography variant="caption" sx={{ fontWeight: 800, display: 'block' }}>{n.number}</Typography>
                    <Typography variant="caption" sx={{ fontSize: 10, display: 'block' }}>z {n.all.z}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, display: 'block' }}>
                      선택 {sel?.rounds_selected ?? 0}·적중 {sel?.hits_when_selected ?? 0}
                    </Typography>
                  </Box>
                );
              })}
            </Box>
            <Typography variant="caption" color="text.secondary" component="div">
              {nums.data?.stats?.note} 보정 후 유의한 번호: {nums.data?.stats?.any_significant ? '있음' : '없음'}.
            </Typography>
            {nd.data && (
              <Box sx={{ mt: 0.5, border: 1, borderColor: 'divider', borderRadius: 1.5, p: 0.75 }}>
                <Typography variant="caption" sx={{ fontWeight: 700 }}>
                  {nd.data.number}번 — {nd.data.rounds_selected}개 회차에서 선택, 그중 실제 당첨 {nd.data.hits}회
                  (무작위 기대 {(nd.data.rounds_selected * 6 / 45).toFixed(1)}회)
                </Typography>
                {(nd.data.recent as any[]).slice(0, 8).map((x) => (
                  <Typography key={x.round} variant="caption" component="div" color={x.was_drawn ? 'warning.main' : 'text.secondary'}>
                    {x.round}회 · {x.engines.map((e: string) => LABEL[e] ?? e).join(', ')}{x.was_drawn ? ' · 당첨' : ''}
                  </Typography>
                ))}
              </Box>
            )}
          </Section>

          <Section title="C. 공통번호 교차분석">
            <Typography variant="caption" component="div">
              최근 회차({r.consensus.latest_consensus?.round}) 엔진 {r.consensus.latest_consensus?.engines}개 · 전체 공통{' '}
              {(r.consensus.latest_consensus?.A_all_engines ?? []).join(', ') || '없음'} · 과반 {(r.consensus.latest_consensus?.B_majority ?? []).join(', ') || '없음'}
            </Typography>
            {(r.consensus.threshold_tests as any[]).map((t) => (
              <Typography key={t.min_engines} variant="caption" component="div" color={t.significant ? 'warning.main' : 'text.secondary'}>
                {t.min_engines}개 이상 엔진이 고른 번호: {t.rounds}회·{t.numbers_selected}개 → 적중률 {(t.hit_rate * 100).toFixed(1)}% (무작위 13.3%, lift {t.lift}, p={t.p_value})
              </Typography>
            ))}
            <Typography variant="caption" component="div" sx={{ mt: 0.5 }}>
              유효 독립 엔진 {r.consensus.independence.effective_independent_engines} / {r.consensus.independence.engines}개 · 유사 쌍:{' '}
              {(r.consensus.independence.pairs as any[]).slice(0, 3).map((p) => `${LABEL[p.a] ?? p.a}~${LABEL[p.b] ?? p.b} J=${p.jaccard}`).join(' · ')}
            </Typography>
            <Typography variant="caption" color="text.secondary" component="div">{r.consensus.verdict} {r.consensus.independence.note}</Typography>
          </Section>

          <Section title="D. 저성과 진단 · 개선 실험(후보 → 홀드아웃 → 승격)">
            {(r.versions as any[]).length === 0 && <Typography variant="caption">아직 개선 실험 기록이 없습니다.</Typography>}
            {(r.versions as any[]).slice(0, 3).map((v) => (
              <Box key={v.version_id} sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 0.75, mb: 0.5 }}>
                <Typography variant="caption" sx={{ fontWeight: 700 }}>
                  {v.engine} · 후보 {v.metrics?.best_candidate} · {v.status === 'promoted' ? '승격' : '기각(기존 유지)'}
                </Typography>
                <Typography variant="caption" component="div">
                  선택기간 {v.selection_range} 최고 {v.metrics?.selection_mean?.[v.metrics?.best_candidate]} → 홀드아웃 {v.holdout_range}: 후보 {v.metrics?.holdout_mean_candidate} vs 현행 {v.metrics?.holdout_mean_current} (무작위 0.8, p={v.metrics?.p_vs_random})
                </Typography>
                <Typography variant="caption" color="text.secondary" component="div">{v.reason}</Typography>
              </Box>
            ))}
          </Section>

          <Section title="V7. 상관 보정 앙상블 검증">
            <Typography variant="caption" component="div">
              {r.ensemble.rounds}회 · 가중 앙상블 {r.ensemble.weighted_ensemble?.mean} (p={r.ensemble.weighted_ensemble?.p_above}) · 계열보정 동일가중{' '}
              {r.ensemble.equal_ensemble_family_adjusted?.mean} · 최고 단일 {LABEL[r.ensemble.best_single?.method] ?? r.ensemble.best_single?.method}{' '}
              {r.ensemble.best_single?.mean}({r.ensemble.best_single?.rounds}회)
            </Typography>
            <Typography variant="caption" color="text.secondary" component="div">{r.ensemble.verdict}</Typography>
          </Section>

          <Section title="F. 통계 신뢰도 · 자동 감사">
            <Typography variant="caption" component="div">
              다중검정 Bonferroni α={r.performance.bonferroni_alpha} · 최근 감사 {r.audit?.created_at ? new Date(r.audit.created_at).toLocaleString('ko-KR', { hour12: false }) : '—'}
            </Typography>
            {(r.audit?.alerts ?? []).length === 0 ? (
              <Typography variant="caption" color="success.main">이상 경고 없음</Typography>
            ) : (
              (r.audit.alerts as any[]).map((a, i) => (
                <Typography key={i} variant="caption" component="div" color="warning.main">
                  ⚠ {a.type} · {a.method} — {a.detail.join(' / ')}
                </Typography>
              ))
            )}
          </Section>
        </>
      )}
    </EngineSection>
  );
}
