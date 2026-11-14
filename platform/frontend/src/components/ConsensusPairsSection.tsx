/**
 * 엔진 중복 '쌍' — 여러 엔진이 같은 두 번호를 함께 고른 쌍의 순위(선택 회차) + 이전 회차 학습 TOP10 쌍 + 전 회차 쌍 기록.
 * 학습: 엔진별 쌍 적중률 × 개별 쌍의 과거 '두 번호 모두 당첨' 기록(그 회차 이전만). 무작위 쌍당 1.515%.
 */
import { Box, Chip, Stack, Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';

function PairBalls({ pair, drawn, winning }: { pair: number[]; drawn?: number | null; winning?: Set<number> }) {
  return (
    <Stack direction="row" spacing={0.25} justifyContent="center">
      {pair.map((n) => {
        const hit = winning ? winning.has(n) : drawn === 2;
        return (
          <Box key={n} component="span" sx={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: '50%',
            fontSize: 11, fontWeight: 800, bgcolor: hit ? 'warning.main' : 'action.hover', color: hit ? 'warning.contrastText' : 'text.primary',
            border: 1, borderColor: hit ? 'warning.dark' : 'divider',
          }}>{n}</Box>
        );
      })}
    </Stack>
  );
}

const pct = (x?: number | null, d = 2) => (x == null ? '-' : `${(x * 100).toFixed(d)}%`);

export default function ConsensusPairsSection({ round, pairs, view, winning }: { round: number; pairs: any; view: 'backtest' | 'live'; winning?: number[] | null }) {
  const [tab, setTab] = useState<'top' | 'overlap' | 'all'>('top');
  if (!pairs) return null;
  const cur = pairs[view] ?? pairs.backtest ?? pairs.live;
  const v = pairs.validation;
  const all = pairs.all_rounds;
  const W = winning ? new Set<number>(winning) : undefined;
  const status = (d?: number | null) => (d == null ? '추첨 전' : d === 2 ? '쌍 적중' : d === 1 ? '1개' : '-');

  return (
    <Box sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: 'divider' }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="caption" sx={{ fontWeight: 800 }}>🔗 {round}회 엔진 중복 쌍 — 여러 엔진이 같은 두 번호를 함께 고른 쌍</Typography>
        {cur?.pair_hits != null && <Chip size="small" color={cur.pair_hits > 0 ? 'warning' : 'default'} label={`학습 TOP10 쌍 중 ${cur.pair_hits}쌍 적중`} />}
        {cur && <Chip size="small" variant="outlined" label={`중복 쌍 ${cur.overlap_pairs_total}개`} />}
      </Stack>
      <Stack direction="row" spacing={0.5} sx={{ my: 0.5 }}>
        {([['top', '학습 TOP10 쌍'], ['overlap', '중복 쌍 순위'], ['all', '전 회차 쌍 기록']] as const).map(([k, l]) => (
          <Chip key={k} size="small" label={l} color={tab === k ? 'primary' : 'default'} onClick={() => setTab(k)} />
        ))}
      </Stack>

      {tab === 'top' && cur && (
        <>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: 0.5 }}>
            {(cur.top10 as any[]).map((x) => (
              <Tooltip key={x.pair.join('-')} arrow title={`${x.labels.join(' · ')} · 점수 ${x.score} · 쌍 계수 ${x.pair_factor} · 이전 중복 ${x.past_consensus}회 중 둘 다 당첨 ${x.past_both_drawn}회${x.past_hit_rounds.length ? ` (${x.past_hit_rounds.join(', ')}회)` : ''}`}>
                <Box sx={{ textAlign: 'center', border: 1, borderColor: x.drawn === 2 ? 'warning.main' : 'divider', borderRadius: 1, py: 0.3 }}>
                  <Typography variant="caption" sx={{ fontSize: 10, fontWeight: 800, display: 'block' }}>{x.rank}위</Typography>
                  <PairBalls pair={x.pair} winning={W} />
                  <Typography variant="caption" color="text.secondary" sx={{ fontSize: 9, display: 'block' }}>
                    엔진 {x.engines} · 과거 {x.past_both_drawn}/{x.past_consensus}
                  </Typography>
                </Box>
              </Tooltip>
            ))}
          </Box>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
            TOP10 쌍에서 나온 번호: <b>{(cur.numbers_from_pairs ?? []).join(', ')}</b>
            {cur.number_hits && ` · 그중 당첨 ${cur.number_hits.length ? cur.number_hits.join(', ') : '없음'}`}
            {' '}· 점수 = 고른 엔진들의 쌍 적중 가중치 합 × 이 쌍의 과거 '둘 다 당첨' 기록 계수 ({round}회 이전만 학습)
          </Typography>
        </>
      )}

      {tab === 'overlap' && cur && (
        <Box sx={{ overflowX: 'auto', maxHeight: 320 }}>
          <Table size="small" stickyHeader sx={{ minWidth: 520, '& td, & th': { px: 0.75, py: 0.3, fontSize: 12 } }}>
            <TableHead><TableRow><TableCell>순위</TableCell><TableCell align="center">쌍</TableCell><TableCell align="right">엔진 수</TableCell>
              <TableCell>고른 엔진</TableCell><TableCell align="right">이전 중복 · 둘 다 당첨</TableCell><TableCell align="right">이번 회차</TableCell></TableRow></TableHead>
            <TableBody>
              {(cur.overlap_pairs as any[]).map((x) => (
                <TableRow key={x.pair.join('-')}>
                  <TableCell>{x.rank}위</TableCell><TableCell><PairBalls pair={x.pair} winning={W} /></TableCell>
                  <TableCell align="right">{x.engines}</TableCell><TableCell sx={{ fontSize: '11px !important' }}>{x.labels.join(' · ')}</TableCell>
                  <TableCell align="right">{x.past_consensus}회 · {x.past_both_drawn}회</TableCell><TableCell align="right">{status(x.drawn)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}

      {tab === 'all' && all && (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
          {([['most_frequent', '가장 자주 중복된 쌍'], ['most_hit', '중복 쌍일 때 둘 다 가장 많이 당첨된 쌍']] as const).map(([k, l]) => (
            <Box key={k} sx={{ flex: 1, overflowX: 'auto' }}>
              <Typography variant="caption" sx={{ fontWeight: 700 }}>{l} ({round}회 이전 {all.rounds}회)</Typography>
              <Table size="small" sx={{ '& td, & th': { px: 0.5, py: 0.25, fontSize: 12 } }}>
                <TableHead><TableRow><TableCell align="center">쌍</TableCell><TableCell align="right">중복</TableCell><TableCell align="right">둘 다 당첨</TableCell>
                  <TableCell align="right">비율</TableCell><TableCell>최근 적중 회차</TableCell></TableRow></TableHead>
                <TableBody>
                  {(all[k] as any[]).slice(0, 10).map((x) => (
                    <TableRow key={x.pair.join('-')}><TableCell><PairBalls pair={x.pair} /></TableCell><TableCell align="right">{x.times_consensus}</TableCell>
                      <TableCell align="right">{x.both_drawn}</TableCell><TableCell align="right">{pct(x.rate, 1)}</TableCell>
                      <TableCell sx={{ fontSize: '11px !important' }}>{x.hit_rounds.slice(0, 4).join(', ')}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          ))}
        </Stack>
      )}

      {v && v.rounds > 0 && (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
          모든 이전 회차 검증({v.range}, {v.rounds}회 · 회차마다 그 이전만 학습): 학습 TOP10 쌍 '둘 다 당첨' 합계 <b>{v.pair_hits}쌍</b>
          (회당 {v.mean_pair_hits}) · 가중 없는 중복순 {v.unweighted_pair_hits}쌍 · 무작위 10쌍 기대 {v.random_expected}쌍 · 쌍 적중률 {pct(v.pair_rate)} vs 무작위 {pct(v.random_rate)}
          · p={v.p_two_sided}. {pairs.verdict}
        </Typography>
      )}
      <Typography variant="caption" color="text.disabled" component="div">ⓘ {pairs.honesty}</Typography>
    </Box>
  );
}
