/**
 * 당첨 패턴 아틀라스 — 전 회차 당첨 조합을 '1/8,145,060 공간'으로 역산해 DB(draw_pattern_atlas·pattern_exact_distribution)에
 * 저장한 결과. 패턴별 정확한 조합 수(8,145,060개 전수) vs 실제 당첨 횟수, 회차별 조합 순번·패턴 클래스, walk-forward 검증.
 */
import { Alert, Box, Chip, LinearProgress, Stack, Table, TableBody, TableCell, TableHead, TableRow, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EngineSection, EngineStatusChip } from './EngineSection';
import { v1Api } from '../api/v1Api';

const pct = (x?: number | null, d = 1) => (x == null ? '-' : `${(x * 100).toFixed(d)}%`);
const FEATS = ['odd', 'low', 'consec', 'ac', 'prime', 'decades_used', 'decade_max', 'last_digits', 'sum'];

function DistBars({ rows, sum }: { rows: any[]; sum?: boolean }) {
  // 합계는 값이 235개라 20 단위로 묶어 표시
  let data = rows;
  if (sum) {
    const m = new Map<number, any>();
    rows.forEach((r) => {
      const k = Math.min(Math.max(Math.floor((r.value - 1) / 20), 3), 11);
      const a = m.get(k) ?? { value: k, label: k === 3 ? '~80' : k === 11 ? '221~' : `${k * 20 + 1}~${k * 20 + 20}`, combos: 0, exact_prob: 0, observed: 0, expected: 0 };
      a.combos += r.combos; a.exact_prob += r.exact_prob; a.observed += r.observed; a.expected += r.expected;
      m.set(k, a);
    });
    data = [...m.values()].sort((a, b) => a.value - b.value);
  }
  const n = data.reduce((s, r) => s + r.observed, 0) || 1;
  const mx = Math.max(...data.map((r) => Math.max(r.exact_prob, r.observed / n)), 0.0001);
  return (
    <Stack spacing={0.4}>
      {data.map((r) => (
        <Tooltip key={r.value} title={`정확 조합 수 ${r.combos.toLocaleString()} / 8,145,060 = ${pct(r.exact_prob, 2)} · 실제 ${r.observed}회 · 기대 ${Number(r.expected).toFixed(1)}회`}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography sx={{ width: 64, fontSize: 12, textAlign: 'right' }}>{r.label ?? r.value}</Typography>
            <Box sx={{ flex: 1, position: 'relative', height: 16 }}>
              <Box sx={{ position: 'absolute', top: 0, left: 0, height: 7, width: `${(r.exact_prob / mx) * 100}%`, bgcolor: 'grey.500', borderRadius: 1 }} />
              <Box sx={{ position: 'absolute', top: 8, left: 0, height: 7, width: `${(r.observed / n / mx) * 100}%`, bgcolor: 'primary.main', borderRadius: 1 }} />
            </Box>
            <Typography sx={{ width: 120, fontSize: 11 }} color="text.secondary">정확 {pct(r.exact_prob)} · 실제 {pct(r.observed / n)}</Typography>
          </Stack>
        </Tooltip>
      ))}
    </Stack>
  );
}

export default function PatternAtlasPanel() {
  const [open, setOpen] = useState(false);
  const [feat, setFeat] = useState('odd');
  const q = useQuery({ queryKey: ['v1-pattern-atlas'], queryFn: v1Api.getPatternAtlas, enabled: open, staleTime: 600_000, retry: false });
  const r = q.data;
  const d = r?.distributions?.[feat];
  const wf = r?.walk_forward;
  const fits = FEATS.map((f) => r?.distributions?.[f]?.fit?.p).filter((p) => p != null) as number[];
  const minP = fits.length ? Math.min(...fits) : null;

  return (
    <EngineSection
      tone="info"
      title="🧬 당첨 패턴 아틀라스 · 1/8,145,060 역산 DB"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      defaultOpen={false}
      chips={r ? <EngineStatusChip color="default" label={`${r.rounds}회 저장 · 패턴 클래스 ${r.classes_total}개`} /> : undefined}
      intent={<>가능한 모든 당첨 조합 <b>8,145,060개</b>를 전수 열거해 패턴(홀짝·저고·연속·AC·소수·구간·끝수·합계)별 정확한 조합 수를 구하고,
        전 회차 당첨 조합을 그 공간에 역산해(조합 순번 1~8,145,060 · 패턴 클래스 · 정확 확률) DB에 저장합니다.
        실제 당첨이 정확 확률대로 나왔는지, 과거 빈출 패턴이 다음 회차를 더 잘 맞히는지 이전 회차만으로 검증합니다.</>}
    >
      {q.isLoading && <LinearProgress />}
      {q.isError && <Alert severity="warning">아틀라스를 불러오지 못했습니다.</Alert>}
      {r && (
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Chip size="small" label={`${r.range} · ${r.rounds}회`} />
            <Chip size="small" label={`서로 다른 1등 조합 ${r.repeats?.distinct_winning_combos}개(반복 0)`} />
            <Chip size="small" label={`조합 순번 평균 ${r.combo_index_spread?.mean?.toLocaleString()} (균등이면 ${r.combo_index_spread?.uniform_mean?.toLocaleString()})`} />
            <Chip size="small" color={minP != null && minP < 0.01 ? 'warning' : 'default'}
              label={`패턴 9종 적합도 최소 p=${minP ?? '-'} (무작위와 일치)`} />
          </Stack>

          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>패턴별 정확 확률(회색) vs 실제 당첨 비율(파랑)</Typography>
            <ToggleButtonGroup size="small" exclusive value={feat} onChange={(_, v) => v && setFeat(v)} sx={{ flexWrap: 'wrap', mb: 1 }}>
              {FEATS.map((f) => <ToggleButton key={f} value={f} sx={{ py: 0.2, fontSize: 11 }}>{r.distributions?.[f]?.label ?? f}</ToggleButton>)}
            </ToggleButtonGroup>
            {d && <DistBars rows={d.rows} sum={feat === 'sum'} />}
            {d?.fit && <Typography variant="caption" color="text.secondary">카이제곱 {d.fit.chi2} (자유도 {d.fit.dof}) · p={d.fit.p} — p≥0.05면 실제 당첨이 정확 확률과 통계적으로 같음</Typography>}
          </Box>

          <Box>
            <Typography variant="subtitle2">가장 많이 나온 패턴 클래스 TOP 10 (홀짝·저고·연속·AC·합계 결합)</Typography>
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small" sx={{ minWidth: 560, '& td, & th': { px: 0.75, py: 0.3, fontSize: 12 } }}>
                <TableHead><TableRow><TableCell>패턴</TableCell><TableCell align="right">조합 수</TableCell><TableCell align="right">정확 확률</TableCell>
                  <TableCell align="right">기대</TableCell><TableCell align="right">실제</TableCell></TableRow></TableHead>
                <TableBody>
                  {(r.top_classes ?? []).map((c: any) => (
                    <TableRow key={c.class_key}><TableCell>{c.desc}</TableCell><TableCell align="right">{c.combos.toLocaleString()}</TableCell>
                      <TableCell align="right">{pct(c.exact_prob, 2)}</TableCell><TableCell align="right">{c.expected}</TableCell>
                      <TableCell align="right">{c.observed}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
            <Typography variant="caption" color="text.secondary">많이 나온 패턴은 '조합 수가 많은' 패턴입니다 — 그 안의 조합 하나하나는 여전히 1/8,145,060.</Typography>
          </Box>

          <Box>
            <Typography variant="subtitle2">최근 회차 역산 (조합 순번 · 패턴 클래스)</Typography>
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small" sx={{ minWidth: 640, '& td, & th': { px: 0.75, py: 0.3, fontSize: 12 } }}>
                <TableHead><TableRow><TableCell>회차</TableCell><TableCell>당첨 번호</TableCell><TableCell align="right">순번 / 8,145,060</TableCell>
                  <TableCell>패턴 클래스</TableCell><TableCell align="right">클래스 확률</TableCell><TableCell align="right">전형도</TableCell></TableRow></TableHead>
                <TableBody>
                  {(r.recent ?? []).map((x: any) => (
                    <TableRow key={x.round}><TableCell>{x.round}</TableCell><TableCell>{x.numbers.join(', ')}</TableCell>
                      <TableCell align="right">{x.combo_index.toLocaleString()}</TableCell><TableCell>{x.class_desc}</TableCell>
                      <TableCell align="right">{pct(x.class_prob, 3)}</TableCell><TableCell align="right">{pct(x.typicality, 0)}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
            <Typography variant="caption" color="text.secondary">
              전형도 = 이 클래스보다 조합 수가 적거나 같은 클래스들의 확률 합(낮을수록 드문 패턴). 무작위라면 0~100%에 고르게 퍼집니다 —
              10분위 회차 수 [{(r.typicality_deciles?.counts ?? []).join(', ')}] (기대 각 {r.typicality_deciles?.expected_each}, p={r.typicality_deciles?.fit?.p}).
            </Typography>
          </Box>

          {wf && (
            <Alert severity={wf.p_two_sided < 0.05 ? 'warning' : 'info'}>
              <b>walk-forward 검증({wf.rounds}회):</b> 매 회차 직전까지 가장 많이 나온 패턴 클래스 {wf.top_k_classes}개를 고르면,
              다음 회차 당첨 조합이 그 안에 들어간 비율 <b>{pct(wf.observed_rate)}</b> vs 그 클래스들의 정확 확률 <b>{pct(wf.exact_rate)}</b>
              (z={wf.z}, p={wf.p_two_sided}). {wf.verdict}
            </Alert>
          )}
          <Typography variant="caption" color="text.secondary">{r.honesty}</Typography>
          {r.set_ceiling && (
            <Alert severity="success">
              <b>V12 10장 세트 확률 한계:</b> 10장 중 1장 이상 5등+ 확률은 이론상 최대 <b>{pct(r.set_ceiling.upper_bound, 2)}</b>
              (= 10장의 기대 당첨 장수, 서로 절대 겹치지 않을 때). 현재 세트 {r.set_ceiling.version} = <b>{pct(r.set_ceiling.current, 2)}</b>
              (한계의 {pct(r.set_ceiling.current / r.set_ceiling.upper_bound, 1)}) · 이전 w3 {pct(r.set_ceiling.w3_range?.[0])}~{pct(r.set_ceiling.w3_range?.[1])} · 무작위 10장 {pct(r.set_ceiling.random_10, 2)}.
              {' '}{r.set_ceiling.note}
            </Alert>
          )}
        </Stack>
      )}
    </EngineSection>
  );
}
