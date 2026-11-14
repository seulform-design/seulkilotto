/**
 * 회차별 예측 기록 — 회차를 고르면 엔진별 예측 번호·실제 당첨·일치 개수·등수를 한눈에.
 * + 엔진별 성능(일치 분포·3+/4+ 비율·평균·95% CI·무작위 대비). 실제 저장된 기록만 표시.
 * 모드: live(추첨 전 저장된 사전 예측) / backtest(walk-forward 사후 재현) / historical_replay(보관 용지 재현).
 */
import { Alert, Box, Chip, LinearProgress, MenuItem, Stack, Switch, TextField, Typography, FormControlLabel } from '@mui/material';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EngineSection, EngineStatusChip } from './EngineSection';
import { v1Api } from '../api/v1Api';
import ConsensusRankingCard from './ConsensusRankingCard';

const TYPE_LABEL: Record<string, { label: string; color: 'success' | 'default' | 'info' }> = {
  live: { label: '사전 예측', color: 'success' },
  backtest: { label: '사후 백테스트', color: 'default' },
  historical_replay: { label: '용지 재현', color: 'info' },
};

function Ball({ n, hit, bonus }: { n: number; hit?: boolean; bonus?: boolean }) {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24,
        borderRadius: '50%', fontSize: 11, fontWeight: 700, mr: 0.4, mb: 0.3,
        bgcolor: hit ? 'warning.main' : bonus ? 'info.light' : 'action.hover',
        color: hit ? 'warning.contrastText' : 'text.primary',
        border: 1, borderColor: hit ? 'warning.dark' : 'divider',
      }}
    >
      {n}
    </Box>
  );
}

export default function RoundPredictionPanel() {
  const [open, setOpen] = useState(true);
  const [round, setRound] = useState<number | null>(null);
  const [ptype, setPtype] = useState<'backtest' | 'live' | 'historical_replay'>('backtest');
  const [common, setCommon] = useState(true);
  const sum = useQuery({ queryKey: ['v1-pred-summary'], queryFn: v1Api.getPredictionSummary, staleTime: 120_000 });
  useEffect(() => {
    if (round == null && sum.data?.by_type) {
      const last = Math.max(...Object.values(sum.data.by_type as Record<string, any>).map((v: any) => v.last_round ?? 0));
      if (last > 0) setRound(last);
    }
  }, [sum.data, round]);
  const det = useQuery({
    queryKey: ['v1-pred-round', round],
    queryFn: () => v1Api.getPredictionRound(round as number),
    enabled: open && round != null,
  });
  const perf = useQuery({
    queryKey: ['v1-pred-perf', ptype, common],
    queryFn: () => v1Api.getPredictionPerformance(ptype, common),
    enabled: open,
    staleTime: 300_000,
  });
  const d = det.data;
  const win = new Set<number>(d?.winning ?? []);
  const [showOld, setShowOld] = useState(false);
  const [sortBy, setSortBy] = useState<'default' | 'match' | 'overlap'>('default');
  const all: any[] = d?.predictions ?? [];
  const oldCount = all.filter((p) => p.superseded).length;
  const shown = all.filter((p) => showOld || !p.superseded);
  const [ovK, setOvK] = useState<'all' | 3 | 4 | 5>('all');
  const [ovSameEngine, setOvSameEngine] = useState(false);
  const [ovLimit, setOvLimit] = useState(20);
  useEffect(() => setOvLimit(20), [round, ovK, ovSameEngine]);
  // 이 회차 예측끼리 공유하는 3·4·5·6개 번호 묶음 — 각 조합의 k-부분집합을 전수 열거해 몇 개 예측(엔진)이 같은 묶음을
  // 담고 있는지 센다(쌍별 교집합 방식은 A∩B=5개면 그 안의 3개 묶음을 다른 예측과 공유해도 따로 세지 못했음).
  // 기본: 서로 다른 엔진 ≥2 · 현재 버전만 · 무작위 기준선 제외 · 같은 엔진 안의 완전히 동일한 조합은 1건으로.
  const overlaps = (() => {
    const cur = all.filter((p) => !p.superseded && p.method !== 'random_baseline');
    const map = new Map<string, { nums: number[]; preds: any[] }>();
    const subsets = (arr: number[], k: number, start = 0, acc: number[] = [], out: number[][] = []) => {
      if (acc.length === k) { out.push([...acc]); return out; }
      for (let i = start; i <= arr.length - (k - acc.length); i++) { acc.push(arr[i]); subsets(arr, k, i + 1, acc, out); acc.pop(); }
      return out;
    };
    for (const p of cur) {
      const nums = [...(p.numbers as number[])].sort((x, y) => x - y);
      for (let k = 3; k <= nums.length; k++) {
        for (const s of subsets(nums, k)) {
          const key = s.join(',');
          const e = map.get(key) ?? { nums: s, preds: [] };
          e.preds.push(p);
          map.set(key, e);
        }
      }
    }
    const out: { nums: number[]; preds: any[]; methods: number; combos: number; hits: number }[] = [];
    for (const e of map.values()) {
      const methods = new Set(e.preds.map((p) => p.method)).size;
      const combos = new Set(e.preds.map((p) => [...p.numbers].sort((x: number, y: number) => x - y).join(','))).size; // 서로 다른 6개 조합 수(엔진이 달라도 번호가 같으면 1개)
      if (methods < 2 && !(ovSameEngine && combos >= 2)) continue; // 기본: 엔진 2개+ · 스위치 켜면 같은 엔진의 서로 다른 조합끼리도
      out.push({ ...e, methods, combos, hits: e.nums.filter((x) => win.has(x)).length });
    }
    // 같은 예측 집합이 공유하는 묶음은 가장 큰 묶음만 남김(예: 두 조합이 5개 공유 → 그 안의 3·4개 묶음 10+5개 중복 표시 방지)
    const sig = (o: { preds: any[] }) => o.preds.map((p) => p.prediction_id).sort().join('|');
    const best = new Map<string, number>();
    for (const o of out) best.set(sig(o), Math.max(best.get(sig(o)) ?? 0, o.nums.length));
    return out
      .filter((o) => best.get(sig(o)) === o.nums.length)
      .sort((a, b) => b.methods - a.methods || b.combos - a.combos || b.nums.length - a.nums.length || a.nums.join(',').localeCompare(b.nums.join(','), undefined, { numeric: true }));
  })();
  const ovCount = { 3: 0, 4: 0, 5: 0 } as Record<3 | 4 | 5, number>;
  overlaps.forEach((o) => { ovCount[Math.min(o.nums.length, 5) as 3 | 4 | 5] += 1; });
  const ovShown = overlaps.filter((o) => ovK === 'all' || (ovK === 5 ? o.nums.length >= 5 : o.nums.length === ovK));
  const maxOverlap = new Map<string, number>();
  overlaps.forEach((o) => {
    if (o.methods < 2) return; // 카드의 '다른 엔진과 N개 겹침' 칩은 서로 다른 엔진 기준만
    o.preds.forEach((p) => maxOverlap.set(p.prediction_id, Math.max(maxOverlap.get(p.prediction_id) ?? 0, o.nums.length)));
  });
  const ov = (p: any) => maxOverlap.get(p.prediction_id) ?? 0;
  const list = [...shown].sort((a, b) =>
    sortBy === 'match' ? (b.match_count ?? -1) - (a.match_count ?? -1) || ov(b) - ov(a)
      : sortBy === 'overlap' ? ov(b) - ov(a) || (b.match_count ?? -1) - (a.match_count ?? -1) : 0);
  // 표시 중인 목록 안에서 6개가 완전히 같은 조합(예: 가중치 버전만 다른 V12 w1·w2·w3) 표시
  const sameKey = (p: any) => [...p.numbers].sort((x: number, y: number) => x - y).join(',');
  const sameCount = new Map<string, number>();
  shown.forEach((p) => sameCount.set(sameKey(p), (sameCount.get(sameKey(p)) ?? 0) + 1));

  return (
    <EngineSection
      tone="primary"
      title="📒 회차별 예측 기록 · 엔진 성적"
      collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      chips={
        sum.data ? (
          <EngineStatusChip
            color="info"
            label={`기록 ${Object.values((sum.data.by_type ?? {}) as Record<string, any>).reduce((a: number, v: any) => a + v.count, 0)} · 평가 ${sum.data.evaluated}`}
          />
        ) : undefined
      }
      intent={
        <>
          각 회차에 엔진이 예측한 6개 번호를 영구 저장하고, 공식 당첨번호가 확인되면 자동 대조합니다. <strong>사전 예측</strong>은 추첨 전
          저장된 기록이고, <strong>사후 백테스트</strong>는 그 회차 이전 데이터만으로 지금 재현한 기록입니다(사전 예측 아님).
        </>
      }
    >
      {(sum.isLoading || det.isLoading) && <LinearProgress />}
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        <TextField
          size="small"
          label="회차"
          type="number"
          value={round ?? ''}
          onChange={(e) => setRound(e.target.value ? Number(e.target.value) : null)}
          sx={{ width: 110 }}
        />
        {d?.winning ? (
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              실제 당첨 ({d.draw_date})
            </Typography>
            {d.winning.map((n: number) => <Ball key={n} n={n} hit />)}
            <Typography component="span" variant="caption" sx={{ mx: 0.5 }}>+</Typography>
            <Ball n={d.bonus} bonus />
          </Box>
        ) : (
          d && <Typography variant="caption" color="text.secondary">아직 추첨 전이거나 공식 결과가 없는 회차입니다.</Typography>
        )}
      </Stack>

      {round != null && open && <ConsensusRankingCard round={round} />}

      {d && d.predictions.length === 0 && <Alert severity="info" sx={{ py: 0.25 }}>이 회차의 예측 기록이 없습니다.</Alert>}
      {d && d.predictions.length > 0 && (
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 0.75, mb: 1 }}>
          <Typography variant="caption" sx={{ fontWeight: 800, display: 'block' }}>
            🧩 {round}회 예측끼리 겹친 번호 순위 — 여러 조합이 같은 번호 3·4·5개 이상을 함께 담은 묶음 (이전 버전·무작위 기준선 제외)
          </Typography>
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
            {([['all', `전체 ${overlaps.length}`], [3, `3개 ${ovCount[3]}`], [4, `4개 ${ovCount[4]}`], [5, `5개+ ${ovCount[5]}`]] as const).map(([k, lbl]) => (
              <Chip key={String(k)} size="small" clickable color={ovK === k ? 'primary' : 'default'} variant={ovK === k ? 'filled' : 'outlined'}
                label={lbl} onClick={() => setOvK(k)} />
            ))}
            <FormControlLabel sx={{ ml: 0.5 }} control={<Switch size="small" checked={ovSameEngine} onChange={(e) => setOvSameEngine(e.target.checked)} />}
              label={<Typography variant="caption">같은 엔진 안의 다른 조합끼리도 포함</Typography>} />
          </Stack>
          {ovShown.length === 0 ? (
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
              조건에 맞는 겹침 묶음이 없습니다.{!ovSameEngine ? ' (같은 엔진 안의 조합끼리 보려면 위 스위치를 켜세요)' : ''}
            </Typography>
          ) : (
            <Stack spacing={0.4} sx={{ mt: 0.5, maxHeight: 360, overflowY: 'auto' }}>
              {ovShown.slice(0, ovLimit).map((o, i) => (
                <Stack key={o.nums.join(',')} direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Typography variant="caption" sx={{ fontWeight: 800, minWidth: 30 }}>{i + 1}위</Typography>
                  <Chip size="small" color={o.nums.length >= 4 ? 'secondary' : 'default'} label={`${o.nums.length}개 겹침`} />
                  <Box>{o.nums.map((n: number) => <Ball key={n} n={n} hit={win.has(n)} />)}</Box>
                  <Typography variant="caption" color="text.secondary">
                    {o.methods}개 엔진 · 서로 다른 조합 {o.combos}개 — {o.preds.map((p: any) => `[${p.label}${p.rank > 1 ? ` #${p.rank}` : ''}]`).join(' ')}
                    {d?.winning ? ` · 그중 당첨 ${o.hits}개` : ''}
                  </Typography>
                </Stack>
              ))}
              {ovShown.length > ovLimit && (
                <Chip size="small" clickable variant="outlined" sx={{ alignSelf: 'flex-start' }}
                  label={`더 보기 (${ovShown.length - ovLimit}개 남음)`} onClick={() => setOvLimit((v) => v + 30)} />
              )}
            </Stack>
          )}
          <Typography variant="caption" color="text.disabled" component="div">
            순위 = 그 묶음을 담은 엔진 수 → 조합 수 → 묶음 크기 순. 같은 조합들이 공유하는 묶음은 가장 큰 것만 표시합니다(5개 공유 안의 3·4개 묶음 중복 제외).
            겹침은 엔진들이 같은 과거 데이터로 비슷하게 계산했다는 뜻일 뿐 당첨 확률을 높이지 않습니다. 학습 기반 순위와 전 회차 검증은 위 '엔진 중복 묶음'(2·3·4개)에 있습니다.
          </Typography>
        </Box>
      )}
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
        <TextField select size="small" value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} sx={{ minWidth: 150 }}>
          <MenuItem value="default">엔진 순</MenuItem>
          <MenuItem value="match">일치 많은 순</MenuItem>
          <MenuItem value="overlap">겹침 많은 순</MenuItem>
        </TextField>
        {oldCount > 0 && (
          <FormControlLabel control={<Switch size="small" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} />}
            label={<Typography variant="caption">이전 가중치 버전 {oldCount}건 보기(대체됨 · 집계 제외)</Typography>} />
        )}
      </Stack>
      <Stack spacing={0.75}>
        {list.map((p: any, idx: number) => (
          <Box key={p.prediction_id} sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 0.75, opacity: p.superseded ? 0.55 : 1 }}>
            <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
              {sortBy !== 'default' && <Typography variant="caption" sx={{ fontWeight: 800, minWidth: 26 }}>{idx + 1}위</Typography>}
              <Chip size="small" variant="outlined" color={TYPE_LABEL[p.type]?.color ?? 'default'} label={TYPE_LABEL[p.type]?.label ?? p.type} />
              <Typography variant="caption" sx={{ fontWeight: 700 }}>
                {p.label}
                {p.rank > 1 ? ` #${p.rank}` : ''}
              </Typography>
              {p.superseded && <Chip size="small" variant="outlined" label="이전 버전(대체됨)" />}
              {(maxOverlap.get(p.prediction_id) ?? 0) >= 3 && !p.superseded && (
                <Chip size="small" color="secondary" variant="outlined" label={`다른 엔진과 ${maxOverlap.get(p.prediction_id)}개 겹침`} />
              )}
              {(sameCount.get(sameKey(p)) ?? 0) > 1 && (
                <Chip size="small" variant="outlined" label={`동일 조합 ×${sameCount.get(sameKey(p))}`} />
              )}
              <Box sx={{ flexGrow: 1 }} />
              {p.match_count != null ? (
                <Chip
                  size="small"
                  color={p.prize_tier ? 'warning' : p.match_count >= 2 ? 'info' : 'default'}
                  label={`${p.match_count}개 일치${p.bonus_matched && p.match_count === 5 ? '+보너스' : ''}${p.prize_tier ? ` · ${p.prize_tier}등` : ''}`}
                />
              ) : (
                <Chip size="small" label="평가 대기" />
              )}
            </Stack>
            <Box sx={{ mt: 0.5 }}>
              {p.numbers.map((n: number) => <Ball key={n} n={n} hit={win.has(n)} />)}
            </Box>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ wordBreak: 'break-all' }}>
              생성 {new Date(p.created_at).toLocaleString('ko-KR', { hour12: false })}
              {p.cutoff_at ? ` · 마감 ${new Date(p.cutoff_at).toLocaleString('ko-KR', { hour12: false })}` : ''}
              {p.created_before_cutoff != null ? (p.created_before_cutoff ? ' · 마감 전 저장' : ' · 마감 후 생성') : ''} · 데이터 {p.training_range ?? '—'}
              {p.training_count != null ? ` (${p.training_count})` : ''} · {p.engine_version}
              {p.note ? ` · ${p.note}` : ''}
            </Typography>
          </Box>
        ))}
      </Stack>

      <Box sx={{ mt: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>엔진별 성적</Typography>
          <TextField select size="small" value={ptype} onChange={(e) => setPtype(e.target.value as any)} sx={{ minWidth: 140 }}>
            <MenuItem value="backtest">사후 백테스트</MenuItem>
            <MenuItem value="live">사전 예측</MenuItem>
            <MenuItem value="historical_replay">용지 재현</MenuItem>
          </TextField>
          <FormControlLabel control={<Switch size="small" checked={common} onChange={(e) => setCommon(e.target.checked)} />}
            label={<Typography variant="caption">공통 회차만 비교</Typography>} />
        </Stack>
        {perf.isLoading && <LinearProgress />}
        {perf.data && (
          <>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
              이론(무작위) 1조합 평균 일치 {perf.data.theoretical.mean_matches} · 3개+ {perf.data.theoretical.rate_3plus} · 4개+{' '}
              {perf.data.theoretical.rate_4plus} · 1등 {perf.data.theoretical.jackpot_per_combo}
              {perf.data.common_rounds ? ` · 공통 회차 ${perf.data.common_rounds[0]}~${perf.data.common_rounds[1]} (${perf.data.common_rounds[2]}회)` : ''}
              {' '}· 다중검정 Bonferroni α={perf.data.multiple_testing.bonferroni_alpha}
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 0.75 }}>
              {(perf.data.methods as any[]).map((m) => (
                <Box key={m.method} sx={{ border: 1, borderColor: m.method === 'random_baseline' ? 'info.main' : 'divider', borderRadius: 1.5, p: 0.75 }}>
                  <Typography variant="caption" sx={{ fontWeight: 700, display: 'block' }}>{m.label}</Typography>
                  <Typography variant="caption" component="div">
                    {m.rounds}회 · 평균 {m.mean_matches} (95% {m.ci95[0]}~{m.ci95[1]}) · 최고 {m.max_match}개
                  </Typography>
                  <Typography variant="caption" color="text.secondary" component="div">
                    0~6개 비율 {[0, 1, 2, 3, 4, 5, 6].map((k) => `${k}:${(m.match_rates[String(k)] * 100).toFixed(1)}%`).join(' ')}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" component="div">
                    3+ {(m.rate_3plus * 100).toFixed(2)}% · 4+ {(m.rate_4plus * 100).toFixed(2)}% · 5+보너스 {(m.five_plus_bonus_rate * 100).toFixed(3)}% · 등수{' '}
                    {Object.entries(m.prize_counts as Record<string, number>).map(([k, v]) => `${k}등×${v}`).join(' ') || '없음'}
                  </Typography>
                  <Typography variant="caption" component="div" color={m.significant_bonferroni ? 'warning.main' : 'text.secondary'}>
                    무작위 대비 {m.vs_random_mean_diff >= 0 ? '+' : ''}{m.vs_random_mean_diff} · p={m.p_value}
                    {m.small_sample ? ' · 표본 부족(30회 미만, 결론 보류)' : m.significant_bonferroni ? ' · 보정 후 유의(재현 확인 필요)' : ' · 무작위와 구분 안 됨'}
                  </Typography>
                </Box>
              ))}
            </Box>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>{perf.data.honesty}</Typography>
          </>
        )}
      </Box>
    </EngineSection>
  );
}
