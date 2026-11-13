/**
 * 엔진 중복 추천 번호 순위 — 선택 회차에서 여러 엔진이 함께 고른 번호를 '몇 개 엔진이 골랐는지' 순으로 묶어 보여 주고,
 * 전체 회차에서 같은 중복 수의 번호가 실제로 몇 % 당첨됐는지(무작위 13.3% 대비)를 함께 보여 준다.
 */
import { Box, Chip, LinearProgress, Stack, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { v1Api } from '../api/v1Api';

function Ball({ n, drawn, size = 28 }: { n: number; drawn?: boolean | null; size?: number }) {
  return (
    <Box component="span" sx={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, borderRadius: '50%',
      fontSize: 12, fontWeight: 800, mr: 0.5, mb: 0.4,
      bgcolor: drawn ? 'warning.main' : 'action.hover', color: drawn ? 'warning.contrastText' : 'text.primary',
      border: 1, borderColor: drawn ? 'warning.dark' : 'divider',
    }}>{n}</Box>
  );
}

const MEDAL = ['🥇', '🥈', '🥉'];

export default function ConsensusRankingCard({ round }: { round: number }) {
  const q = useQuery({ queryKey: ['v1-pred-consensus', round], queryFn: () => v1Api.getPredictionConsensus(round), staleTime: 300_000 });
  const [view, setView] = useState<'backtest' | 'live'>('backtest');
  const data = q.data;
  const cur = data?.[view] ?? data?.backtest ?? data?.live;
  const groups = useMemo(() => {
    const g: { engines: number; rank: number; items: any[] }[] = [];
    (cur?.numbers ?? []).filter((x: any) => x.engines >= 2).forEach((x: any) => {
      const last = g[g.length - 1];
      if (last && last.engines === x.engines) last.items.push(x);
      else g.push({ engines: x.engines, rank: x.rank, items: [x] });
    });
    return g;
  }, [cur]);
  const all = data?.all_rounds;
  const maxRate = Math.max(0.2, ...((all?.by_engine_count ?? []) as any[]).map((x) => x.ci95?.[1] ?? 0));

  return (
    <Box sx={{ border: 2, borderColor: 'primary.main', borderRadius: 2, p: 1, mb: 1.25 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>🔢 {round}회 엔진 중복 추천 번호 순위</Typography>
        {data?.backtest && data?.live && (
          <ToggleButtonGroup size="small" exclusive value={view} onChange={(_, v) => v && setView(v)}>
            <ToggleButton value="backtest" sx={{ py: 0, fontSize: 11 }}>사후 백테스트</ToggleButton>
            <ToggleButton value="live" sx={{ py: 0, fontSize: 11 }}>사전 예측</ToggleButton>
          </ToggleButtonGroup>
        )}
        <Box sx={{ flexGrow: 1 }} />
        {cur && (
          <Chip size="small" variant="outlined"
            label={`엔진 ${cur.engine_count}개 · 2개+ 중복 ${cur.multi_engine_numbers.length}개${cur.result_known ? ` · 그중 당첨 ${cur.multi_engine_hits}개` : ' · 추첨 전'}`} />
        )}
      </Stack>
      {q.isLoading && <LinearProgress sx={{ mt: 0.5 }} />}
      {data && !cur && <Typography variant="caption" color="text.secondary">이 회차는 엔진 예측 기록이 없습니다.</Typography>}

      {groups.length > 0 && (
        <Stack spacing={0.5} sx={{ mt: 0.75 }}>
          {groups.map((g, i) => (
            <Stack key={g.engines} direction="row" spacing={1} alignItems="center"
              sx={{ bgcolor: i === 0 ? 'action.selected' : 'transparent', borderRadius: 1, px: 0.75, py: 0.25 }}>
              <Box sx={{ minWidth: 92 }}>
                <Typography variant="caption" sx={{ fontWeight: 800, display: 'block' }}>
                  {MEDAL[i] ?? `${g.rank}위`} {g.engines}개 엔진
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>{g.items.length}개 번호</Typography>
              </Box>
              <Box sx={{ display: 'flex', flexWrap: 'wrap' }}>
                {g.items.map((x: any) => (
                  <Tooltip key={x.number} arrow title={x.labels.join(' · ')}>
                    <span><Ball n={x.number} drawn={x.drawn} /></span>
                  </Tooltip>
                ))}
              </Box>
            </Stack>
          ))}
        </Stack>
      )}
      {cur && (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.25 }}>
          주황 = 실제 당첨번호 · 번호에 마우스를 올리면 고른 엔진 목록 · 1개 엔진만 고른 번호 {cur.numbers.filter((x: any) => x.engines === 1).length}개는 생략
        </Typography>
      )}

      {all && (
        <Box sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: 'divider' }}>
          <Typography variant="caption" sx={{ fontWeight: 800, display: 'block', mb: 0.5 }}>
            {round}회 기준 · 직전 {all.rounds}회({all.range}) 실측 — 중복 수별 실제 당첨 비율 (무작위 13.3%)
          </Typography>
          <Stack spacing={0.4}>
            {(all.by_engine_count as any[]).map((x) => (
              <Stack key={x.engines} direction="row" spacing={1} alignItems="center">
                <Typography variant="caption" sx={{ minWidth: 64 }}>{x.engines} 엔진</Typography>
                <Box sx={{ position: 'relative', flexGrow: 1, height: 14, bgcolor: 'action.hover', borderRadius: 1 }}>
                  <Box sx={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(x.hit_rate / maxRate) * 100}%`, bgcolor: 'primary.main', borderRadius: 1, opacity: 0.8 }} />
                  <Box sx={{ position: 'absolute', top: -2, bottom: -2, left: `${(x.random_rate / maxRate) * 100}%`, borderLeft: 2, borderColor: 'error.main' }} />
                </Box>
                <Typography variant="caption" sx={{ minWidth: 150, textAlign: 'right' }}>
                  {(x.hit_rate * 100).toFixed(1)}% ({x.hits}/{x.picks}) · ±{(((x.ci95[1] - x.ci95[0]) / 2) * 100).toFixed(1)}
                </Typography>
              </Stack>
            ))}
          </Stack>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.25 }}>
            빨간 선 = 무작위(6/45=13.3%) · 막대 = 실제 당첨 비율. {all.verdict}
          </Typography>
          {(all.selected_round_track ?? []).length > 0 && (
            <>
              <Typography variant="caption" sx={{ fontWeight: 800, display: 'block', mt: 0.75 }}>
                {round}회 중복 번호의 직전 {all.rounds}회 기록 — 중복 상위였던 횟수 · 그때 실제 당첨 비율
              </Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: 0.5, mt: 0.25 }}>
                {(all.selected_round_track as any[]).slice(0, 12).map((x) => (
                  <Box key={x.number} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 0.5, textAlign: 'center' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, display: 'block' }}>이번 {x.engines_now}개 엔진</Typography>
                    <Ball n={x.number} drawn={x.drawn} />
                    <Typography variant="caption" sx={{ fontSize: 10, display: 'block' }}>직전 중복 {x.past_times_top}회</Typography>
                    <Typography variant="caption" color={x.past_hit_rate != null && x.past_hit_rate > 0.1333 ? 'warning.main' : 'text.secondary'} sx={{ fontSize: 10, display: 'block' }}>
                      {x.past_hit_rate == null ? '기록 없음' : `실제 당첨 ${(x.past_hit_rate * 100).toFixed(1)}%`}
                    </Typography>
                  </Box>
                ))}
              </Box>
            </>
          )}
          <Typography variant="caption" sx={{ fontWeight: 800, display: 'block', mt: 0.75 }}>회차별 중복 상위 번호와 실제 당첨 (최근 {(all.recent_history ?? []).length}회)</Typography>
          <Stack spacing={0.25} sx={{ mt: 0.25 }}>
            {(all.recent_history as any[] ?? []).map((h) => (
              <Stack key={h.round} direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                <Typography variant="caption" sx={{ minWidth: 120, fontWeight: 700 }}>
                  {h.round}회 · {h.max_overlap}개 엔진 겹침
                </Typography>
                <Box sx={{ display: 'flex', flexWrap: 'wrap' }}>
                  {(h.top_numbers as number[]).map((n) => <Ball key={n} n={n} drawn={(h.top_hits as number[]).includes(n)} size={22} />)}
                </Box>
                <Typography variant="caption" color={h.top_hits.length ? 'warning.main' : 'text.secondary'}>
                  적중 {h.top_hits.length}/{h.top_numbers.length}
                </Typography>
              </Stack>
            ))}
          </Stack>
        </Box>
      )}
      {data?.note && <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>ⓘ {data.note}</Typography>}
    </Box>
  );
}
