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
  // 이 회차 예측끼리 3개 이상 같은 번호 — 서로 다른 엔진(방법) 사이만, 현재 버전만
  const overlaps = (() => {
    const cur = all.filter((p) => !p.superseded && p.method !== 'random_baseline');
    const map = new Map<string, { nums: number[]; preds: any[] }>();
    for (let i = 0; i < cur.length; i++) {
      for (let j = i + 1; j < cur.length; j++) {
        if (cur[i].method === cur[j].method) continue;
        const b = new Set<number>(cur[j].numbers);
        const common = (cur[i].numbers as number[]).filter((x) => b.has(x)).sort((x, y) => x - y);
        if (common.length < 3) continue;
        const key = common.join(',');
        const e = map.get(key) ?? { nums: common, preds: [] };
        for (const p of [cur[i], cur[j]]) if (!e.preds.some((q) => q.prediction_id === p.prediction_id)) e.preds.push(p);
        map.set(key, e);
      }
    }
    return [...map.values()]
      .map((e) => ({ ...e, methods: new Set(e.preds.map((p) => p.method)).size, hits: e.nums.filter((x) => win.has(x)).length }))
      .sort((a, b) => b.nums.length - a.nums.length || b.methods - a.methods || b.preds.length - a.preds.length || a.nums[0] - b.nums[0]);
  })();
  const maxOverlap = new Map<string, number>();
  overlaps.forEach((o) => o.preds.forEach((p) => maxOverlap.set(p.prediction_id, Math.max(maxOverlap.get(p.prediction_id) ?? 0, o.nums.length))));
  const list = [...shown].sort((a, b) =>
    sortBy === 'match' ? (b.match_count ?? -1) - (a.match_count ?? -1)
      : sortBy === 'overlap' ? (maxOverlap.get(b.prediction_id) ?? 0) - (maxOverlap.get(a.prediction_id) ?? 0) : 0);

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
      {overlaps.length > 0 && (
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 0.75, mb: 1 }}>
          <Typography variant="caption" sx={{ fontWeight: 800, display: 'block' }}>
            🧩 {round}회 예측끼리 3개 이상 겹친 번호 순위 — 서로 다른 엔진의 6개 조합이 같은 번호를 3·4·5개 공유 (이전 버전 제외)
          </Typography>
          <Stack spacing={0.4} sx={{ mt: 0.5, maxHeight: 320, overflowY: 'auto' }}>
            {overlaps.slice(0, 20).map((o, i) => (
              <Stack key={o.nums.join(',')} direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="caption" sx={{ fontWeight: 800, minWidth: 30 }}>{i + 1}위</Typography>
                <Chip size="small" color={o.nums.length >= 4 ? 'secondary' : 'default'} label={`${o.nums.length}개 겹침`} />
                <Box>{o.nums.map((n: number) => <Ball key={n} n={n} hit={win.has(n)} />)}</Box>
                <Typography variant="caption" color="text.secondary">
                  {o.methods}개 엔진 · {o.preds.map((p: any) => `${p.label}${p.rank > 1 ? ` #${p.rank}` : ''}`).join(' · ')}
                  {d?.winning ? ` · 그중 당첨 ${o.hits}개` : ''}
                </Typography>
              </Stack>
            ))}
          </Stack>
          <Typography variant="caption" color="text.disabled" component="div">
            겹침은 엔진들이 같은 과거 데이터로 비슷하게 계산했다는 뜻입니다. 학습 기반 순위와 전 회차 검증은 위 '엔진 중복 묶음'(2·3·4개)에 있습니다.
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
        {list.map((p: any) => (
          <Box key={p.prediction_id} sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 0.75, opacity: p.superseded ? 0.55 : 1 }}>
            <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
              <Chip size="small" variant="outlined" color={TYPE_LABEL[p.type]?.color ?? 'default'} label={TYPE_LABEL[p.type]?.label ?? p.type} />
              <Typography variant="caption" sx={{ fontWeight: 700 }}>
                {p.label}
                {p.rank > 1 ? ` #${p.rank}` : ''}
              </Typography>
              {p.superseded && <Chip size="small" variant="outlined" label="이전 버전(대체됨)" />}
              {(maxOverlap.get(p.prediction_id) ?? 0) >= 3 && !p.superseded && (
                <Chip size="small" color="secondary" variant="outlined" label={`다른 엔진과 ${maxOverlap.get(p.prediction_id)}개 겹침`} />
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
