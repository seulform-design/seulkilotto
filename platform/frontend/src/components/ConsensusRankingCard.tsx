/**
 * 엔진 중복 추천 번호 순위 — 선택 회차에서 여러 엔진이 함께 고른 번호를 '몇 개 엔진이 골랐는지' 순으로 묶어 보여 주고,
 * 그 회차 한 회의 중복 수별 실제 당첨(무작위 13.3% 기준선)만 보여 준다 — 다른 회차 누적·직전 N회 통계는 넣지 않는다.
 */
import { Box, Chip, LinearProgress, Stack, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { v1Api } from '../api/v1Api';

function Ball({ n, drawn, size = 28 }: { n: number; drawn?: boolean | null; size?: number }) {
  return (
    <Box component="span" sx={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, borderRadius: '50%',
      fontSize: size < 24 ? 10 : 12, fontWeight: 800, mr: 0.5, mb: 0.4, flexShrink: 0,
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
  const t10cur = data?.top10?.[view] ?? data?.top10?.backtest ?? data?.top10?.live;
  const tv = data?.top10?.validation;
  // 선택 회차 한 회만: 중복 수(엔진 수)별 고른 번호 · 그중 당첨 — 다른 회차 누적·직전 N회 없음
  const levels = groups.map((g) => {
    const hits = g.items.filter((x: any) => x.drawn).length;
    return { engines: g.engines, picks: g.items.length, hits, rate: cur?.result_known ? hits / g.items.length : null };
  });

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

      {t10cur && (
        <Box sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: 'divider' }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="caption" sx={{ fontWeight: 800 }}>
              🏆 {round}회 엔진별 유력 번호 TOP 10 — 엔진 과거 성적으로 가중 ({round}회 이전 회차만 학습)
            </Typography>
            {t10cur.hits != null && <Chip size="small" color={t10cur.hits >= 2 ? 'warning' : 'default'} label={`10개 중 ${t10cur.hits}개 당첨`} />}
          </Stack>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))', gap: 0.5, mt: 0.5 }}>
            {(t10cur.numbers as any[]).map((x) => (
              <Tooltip key={x.number} arrow title={`${x.labels.join(' · ')} · 가중 점수 ${x.score}`}>
                <Box sx={{ textAlign: 'center', border: 1, borderColor: x.drawn ? 'warning.main' : 'divider', borderRadius: 1, py: 0.25 }}>
                  <Typography variant="caption" sx={{ fontSize: 10, fontWeight: 800, display: 'block' }}>{x.rank}위</Typography>
                  <Ball n={x.number} drawn={x.drawn} />
                  <Typography variant="caption" color="text.secondary" sx={{ fontSize: 9, display: 'block' }}>엔진 {x.engines}개</Typography>
                </Box>
              </Tooltip>
            ))}
          </Box>
          {tv && tv.rounds > 0 && (
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
              모든 이전 회차 검증({tv.range}, {tv.rounds}회 · 회차마다 그 이전만 학습): 학습 TOP10 평균 {tv.mean_hits}개 적중 ·
              가중 없는 중복순 {tv.unweighted_mean_hits}개 · 무작위 10개 {tv.random_mean_hits}개 · 3개 이상 적중 {tv.rounds_3plus}회(무작위 기대 {tv.random_rounds_3plus}회).{' '}
              {data?.top10?.verdict}
            </Typography>
          )}
          <Typography variant="caption" color="text.disabled" component="div">ⓘ {data?.top10?.honesty}</Typography>
        </Box>
      )}

      {levels.length > 0 && (
        <Box sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: 'divider' }}>
          <Typography variant="caption" sx={{ fontWeight: 800, display: 'block', mb: 0.5 }}>
            {round}회 결과 — 중복 수별 고른 번호 중 실제 당첨 ({view === 'live' ? '사전 예측' : '사후 백테스트'} · 이 회차 한 회 기준)
          </Typography>
          <Stack spacing={0.4}>
            {levels.map((x) => (
              <Stack key={x.engines} direction="row" spacing={1} alignItems="center">
                <Typography variant="caption" sx={{ minWidth: 64, fontWeight: 700 }}>{x.engines}개 엔진</Typography>
                <Box sx={{ position: 'relative', flexGrow: 1, height: 12, bgcolor: 'action.hover', borderRadius: 1 }}>
                  {x.rate != null && (
                    <Box sx={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${x.rate * 100}%`, bgcolor: 'warning.main', borderRadius: 1 }} />
                  )}
                  <Box sx={{ position: 'absolute', top: -2, bottom: -2, left: `${(6 / 45) * 100}%`, borderLeft: 2, borderColor: 'error.main' }} />
                </Box>
                <Typography variant="caption" sx={{ minWidth: 150, textAlign: 'right' }}>
                  {x.rate == null ? `${x.picks}개 번호 · 추첨 전` : `${x.picks}개 중 ${x.hits}개 당첨 · ${(x.rate * 100).toFixed(1)}%`}
                </Typography>
              </Stack>
            ))}
          </Stack>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.25 }}>
            {cur?.result_known
              ? `합계 ${cur.multi_engine_hits}/${cur.multi_engine_numbers.length}개 당첨 (${((cur.multi_engine_hits / Math.max(1, cur.multi_engine_numbers.length)) * 100).toFixed(1)}%) · 빨간 선 = 무작위 6/45 = 13.3%`
              : '추첨 후 결과가 표시됩니다 · 빨간 선 = 무작위 6/45 = 13.3%'}
          </Typography>
        </Box>
      )}
      {data?.note && <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>ⓘ {data.note}</Typography>}
    </Box>
  );
}
