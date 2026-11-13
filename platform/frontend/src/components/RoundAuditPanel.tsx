/**
 * 회차별 후보군 성적 감사 — 이번 회차뿐 아니라 과거 전 회차에 같은 후보군(통계·엔진·앙상블·V12 10조합·유튜브 용지)을
 * 그 회차 이전 데이터로 만들어 두고, 실제 당첨번호와 대조한 '당첨 확률(일치 분포·3개 이상·등수)'을 무작위와 비교한다.
 * 보정 후에도 무작위보다 유의하게 낮은 후보군은 원인을 진단하고 다음 회차 V12 투표에서 자동 제외한다(원본 기록 유지).
 */
import { Alert, Box, Chip, LinearProgress, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EngineSection, EngineStatusChip } from './EngineSection';
import { v1Api } from '../api/v1Api';

const VERDICT: Record<string, { label: string; color: 'error' | 'warning' | 'default' | 'success' | 'info' }> = {
  below_random: { label: '하락(보정 후 유의)', color: 'error' },
  below_trend: { label: '낮은 경향', color: 'warning' },
  random_equivalent: { label: '무작위 수준', color: 'default' },
  above_random: { label: '높음(재현 필요)', color: 'success' },
  insufficient: { label: '표본 부족', color: 'info' },
};
const TYPE_LABEL: Record<string, string> = { backtest: '사후 백테스트', live: '사전 예측', historical_replay: '용지 재현' };

const pct = (x?: number | null, d = 1) => (x == null ? '-' : `${(x * 100).toFixed(d)}%`);

export default function RoundAuditPanel() {
  const [open, setOpen] = useState(false);
  const rep = useQuery({ queryKey: ['v1-round-audit'], queryFn: v1Api.getRoundAudit, enabled: open, staleTime: 300_000, retry: false });
  const tbl = useQuery({ queryKey: ['v1-round-audit-table'], queryFn: () => v1Api.getRoundAuditTable(30), enabled: open, staleTime: 300_000 });
  const r = rep.data;
  const methods: any[] = r?.methods ?? [];
  const cols: any[] = (tbl.data?.columns ?? []).filter((c: any) => c.method !== 'random_baseline' || c.type === 'backtest');
  const mainCols = cols.filter((c) => c.coverage >= 3 || c.type === 'live').slice(0, 14);

  return (
    <EngineSection
      tone="warning"
      title="📉 회차별 후보군 성적 감사 · 하락 엔진 진단·보정"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      defaultOpen={false}
      chips={r ? <EngineStatusChip color={r.summary?.below_random ? 'error' : 'default'}
        label={`하락 ${r.summary?.below_random ?? 0} · 경향 ${r.summary?.below_trend ?? 0} · 무작위 수준 ${r.summary?.random_equivalent ?? 0}`} /> : undefined}
      intent={<>이번 회차의 후보군(통계·엔진·앙상블·V12 10조합·유튜브 용지)을 과거 전 회차에도 <b>그 회차 이전 데이터만으로</b> 만들어 두고,
        실제 당첨번호와 대조해 후보군별 일치 분포·3개 이상 비율·등수를 무작위(평균 0.8개, 3개 이상 1.77%)와 비교합니다.
        보정 후에도 유의하게 낮으면 원인을 진단하고 다음 회차 V12 투표에서 자동 제외합니다.</>}
    >
      {(rep.isLoading || tbl.isLoading) && <LinearProgress />}
      {rep.isError && <Alert severity="info">아직 감사 기록이 없습니다. 일일 파이프라인(마스터 엔진)이 자동 실행합니다.</Alert>}

      {r && (
        <>
          <Typography variant="caption" component="div" color="text.secondary" sx={{ mb: 1 }}>
            기준 {r.latest_round}회까지 · 검정 {r.n_tested}개 후보군 · Bonferroni α={r.alpha_bonferroni} · 무작위 기준선 관측 평균 {r.random_baseline_observed?.mean ?? '-'}개
          </Typography>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: 760, '& td, & th': { px: 0.75, py: 0.4, fontSize: 12 } }}>
              <TableHead>
                <TableRow>
                  <TableCell>후보군</TableCell><TableCell>구분</TableCell><TableCell align="right">회차</TableCell>
                  <TableCell align="right">조합/회</TableCell><TableCell align="right">평균 일치</TableCell>
                  <TableCell align="right">3개+ (기대)</TableCell><TableCell align="right">회차 최고 평균 (무작위)</TableCell>
                  <TableCell align="right">최근 50회</TableCell><TableCell>등수</TableCell><TableCell>판정</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {methods.map((m) => (
                  <TableRow key={`${m.type}:${m.method}`} sx={m.verdict === 'below_random' ? { bgcolor: 'error.main', '& td': { color: 'error.contrastText' } } : undefined}>
                    <TableCell sx={{ fontWeight: 700 }}>{m.label}</TableCell>
                    <TableCell>{TYPE_LABEL[m.type] ?? m.type}</TableCell>
                    <TableCell align="right">{m.rounds} <Typography variant="caption" color="text.secondary">({m.first_round}~{m.last_round})</Typography></TableCell>
                    <TableCell align="right">{m.combos_per_round}</TableCell>
                    <TableCell align="right">{m.mean_matches} <Typography variant="caption" color="text.secondary">[{m.ci95?.[0]}, {m.ci95?.[1]}]</Typography></TableCell>
                    <TableCell align="right">{m.hit3} ({m.expected_hit3}) · {pct(m.rate_3plus, 2)}</TableCell>
                    <TableCell align="right">{m.best_per_round_mean} ({m.random_best_per_round_mean})</TableCell>
                    <TableCell align="right">{m.periods?.last50?.mean ?? '-'}</TableCell>
                    <TableCell>{Object.entries(m.prize_counts ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '-'}</TableCell>
                    <TableCell><Chip size="small" color={VERDICT[m.verdict]?.color ?? 'default'} label={VERDICT[m.verdict]?.label ?? m.verdict} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>

          <Typography variant="subtitle2" sx={{ fontWeight: 800, mt: 2, mb: 0.5 }}>원인 진단 · 자동 보정</Typography>
          {(r.actions?.excluded_now ?? []).length > 0 ? (
            <Alert severity="warning" sx={{ mb: 1 }}>
              다음 회차 V12 투표 제외: {(r.actions.excluded_now as string[]).join(', ')} — {r.actions.rule}
            </Alert>
          ) : (
            <Alert severity="success" sx={{ mb: 1 }}>보정 후 유의하게 하락한 후보군이 없어 투표 제외 조치가 없습니다. ({r.actions?.rule})</Alert>
          )}
          <Stack spacing={0.5}>
            {methods.filter((m) => (m.problems ?? []).length || m.verdict === 'below_random' || m.verdict === 'below_trend' || m.recent_drop).map((m) => (
              <Box key={`p-${m.type}:${m.method}`} sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 0.75 }}>
                <Typography variant="caption" sx={{ fontWeight: 800 }}>{m.label} ({TYPE_LABEL[m.type] ?? m.type}) — {m.verdict_label}{m.recent_drop ? ' · 최근 50회 하락' : ''}</Typography>
                {(m.problems ?? []).map((p: string, i: number) => (
                  <Typography key={i} variant="caption" component="div">· {p}</Typography>
                ))}
                {!(m.problems ?? []).length && (
                  <Typography variant="caption" component="div" color="text.secondary">· 구조·번호 집중 이상 없음 — 표본 변동으로 설명 가능</Typography>
                )}
                <Typography variant="caption" component="div" color="text.secondary">
                  자주 고른 번호(실제 출현율, 기대 13.3%): {(m.diagnostics?.favorite_numbers ?? []).map((f: any) => `${f.number}(${pct(f.hit_rate, 0)})`).join(' · ')}
                </Typography>
              </Box>
            ))}
          </Stack>
        </>
      )}

      {tbl.data && mainCols.length > 0 && (
        <>
          <Typography variant="subtitle2" sx={{ fontWeight: 800, mt: 2, mb: 0.5 }}>회차별 성적표 — 후보군별 최고 일치 개수(최근 {tbl.data.rounds.length}회)</Typography>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ '& td, & th': { px: 0.5, py: 0.3, fontSize: 11, whiteSpace: 'nowrap' } }}>
              <TableHead>
                <TableRow>
                  <TableCell>회차 · 당첨번호</TableCell>
                  {mainCols.map((c) => (
                    <TableCell key={c.key} align="center" title={`${c.label} (${TYPE_LABEL[c.type] ?? c.type})`}>
                      {c.label.length > 10 ? `${c.label.slice(0, 10)}…` : c.label}
                      <Typography variant="caption" component="div" color="text.secondary">{TYPE_LABEL[c.type] ?? c.type}</Typography>
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {(tbl.data.rounds as any[]).map((row) => (
                  <TableRow key={row.round}>
                    <TableCell>{row.round}회 <Typography variant="caption" color="text.secondary">{row.winning.join(' ')} +{row.bonus}</Typography></TableCell>
                    {mainCols.map((c) => {
                      const cell = row.cells[c.key];
                      if (!cell) return <TableCell key={c.key} align="center" sx={{ color: 'text.disabled' }}>-</TableCell>;
                      return (
                        <TableCell key={c.key} align="center" sx={{ fontWeight: cell.best >= 3 ? 800 : 400, color: cell.best >= 3 ? 'success.main' : undefined }}>
                          {cell.best}{cell.tier ? ` (${cell.tier}등)` : ''}{cell.combos > 1 ? <Typography variant="caption" color="text.secondary">/{cell.combos}</Typography> : null}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        </>
      )}
      {r && <Alert severity="info" variant="outlined" sx={{ mt: 1.5 }}>{r.honesty}</Alert>}
    </EngineSection>
  );
}
