import { Box, Chip, Grid, Paper, Stack, Typography } from '@mui/material';
import LottoBall from '../LottoBall';
import type { PostOccurrenceResponse } from '../../api/v1Api';

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <Paper sx={{ p: 1.5, bgcolor: '#262A30' }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body1" fontWeight={700}>
        {value}
      </Typography>
    </Paper>
  );
}

function FreqTable({
  title,
  rows,
}: {
  title: string;
  rows: { number: number; count: number }[];
}) {
  if (!rows.length) return null;
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        {title}
      </Typography>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        {rows.map((r) => (
          <Stack key={r.number} direction="row" alignItems="center" spacing={0.5}>
            <LottoBall number={r.number} size={24} />
            <Typography variant="caption">{r.count}회</Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

export default function PatternAnalysisPanel({
  pattern,
  bonus,
}: {
  pattern?: PostOccurrenceResponse['pattern_analysis'];
  bonus?: PostOccurrenceResponse['bonus_analysis'];
}) {
  if (!pattern || !pattern.sample_count) {
    return (
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        패턴 분석 표본이 없습니다.
      </Typography>
    );
  }

  const p = pattern as {
    sample_count?: number;
    frequencies?: { simple?: { number: number; count: number }[]; recent?: { number: number; count: number }[] };
    carryover?: { count?: number; rate?: number; pair_rate?: number; triple_rate?: number };
    rates?: { consecutive?: number; same_ending?: number; mirror_pairs?: number; cluster_density?: number };
    distribution?: {
      zones?: { zone: string; count: number }[];
      odd_ratio_avg?: number;
      low_high_ratio_avg?: number;
      sum_mean?: number;
      sum_std?: number;
      gap_mean?: number;
    };
    number_states?: { long_absent?: number[]; overheated?: number[]; cooled?: number[] };
  };

  const b = bonus as {
    sample_count?: number;
    bonus_next_counts?: { number: number; count: number }[];
    bonus_in_main_numbers?: { number: number; count: number }[];
    bonus_repeat_count?: number;
    main_number_top10?: { number: number; count: number; rate: number }[];
  };

  return (
    <Box>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
        후속 회차 표본 {p.sample_count}건 기준
      </Typography>

      <FreqTable title="① 단순 출현 빈도 TOP10" rows={p.frequencies?.simple ?? []} />
      <FreqTable title="② 최근 출현 빈도 TOP10" rows={p.frequencies?.recent ?? []} />

      <Typography variant="subtitle2" sx={{ mt: 1, mb: 1 }}>
        ③~⑤ 이월·쌍이월·삼중이월
      </Typography>
      <Grid container spacing={1} sx={{ mb: 2 }}>
        <Grid item xs={6} md={3}>
          <Metric label="이월수 건수" value={p.carryover?.count ?? 0} />
        </Grid>
        <Grid item xs={6} md={3}>
          <Metric label="이월 비율" value={`${((p.carryover?.rate ?? 0) * 100).toFixed(1)}%`} />
        </Grid>
        <Grid item xs={6} md={3}>
          <Metric label="쌍이월 비율" value={`${((p.carryover?.pair_rate ?? 0) * 100).toFixed(1)}%`} />
        </Grid>
        <Grid item xs={6} md={3}>
          <Metric label="삼중이월 비율" value={`${((p.carryover?.triple_rate ?? 0) * 100).toFixed(1)}%`} />
        </Grid>
      </Grid>

      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        ⑥~⑲ 패턴 지표
      </Typography>
      <Grid container spacing={1} sx={{ mb: 2 }}>
        <Grid item xs={6} md={3}>
          <Metric label="연속수 비율" value={`${((p.rates?.consecutive ?? 0) * 100).toFixed(1)}%`} />
        </Grid>
        <Grid item xs={6} md={3}>
          <Metric label="동일끝수 비율" value={`${((p.rates?.same_ending ?? 0) * 100).toFixed(1)}%`} />
        </Grid>
        <Grid item xs={6} md={3}>
          <Metric label="거울수 쌍" value={p.rates?.mirror_pairs ?? 0} />
        </Grid>
        <Grid item xs={6} md={3}>
          <Metric label="밀집도" value={`${((p.rates?.cluster_density ?? 0) * 100).toFixed(1)}%`} />
        </Grid>
        <Grid item xs={6} md={3}>
          <Metric label="홀수 비율(평균)" value={p.distribution?.odd_ratio_avg ?? '-'} />
        </Grid>
        <Grid item xs={6} md={3}>
          <Metric label="저번호 비율(평균)" value={p.distribution?.low_high_ratio_avg ?? '-'} />
        </Grid>
        <Grid item xs={6} md={3}>
          <Metric label="총합 평균" value={p.distribution?.sum_mean ?? '-'} />
        </Grid>
        <Grid item xs={6} md={3}>
          <Metric label="총합 표준편차" value={p.distribution?.sum_std ?? '-'} />
        </Grid>
        <Grid item xs={6} md={3}>
          <Metric label="번호 간격 평균" value={p.distribution?.gap_mean ?? '-'} />
        </Grid>
      </Grid>

      {p.distribution?.zones && p.distribution.zones.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle2" gutterBottom>
            ⑨ 구간 분포 (1~10 / 11~20 / 21~30 / 31~40 / 41~45)
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {p.distribution.zones.map((z) => (
              <Chip key={z.zone} label={`${z.zone}: ${z.count}회`} />
            ))}
          </Stack>
        </Box>
      )}

      <Stack spacing={1.5} sx={{ mb: 2 }}>
        {p.number_states?.long_absent && p.number_states.long_absent.length > 0 && (
          <Box>
            <Typography variant="subtitle2">⑲ 장기 미출현</Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
              {p.number_states.long_absent.map((n) => (
                <LottoBall key={n} number={n} size={28} />
              ))}
            </Stack>
          </Box>
        )}
        {p.number_states?.overheated && p.number_states.overheated.length > 0 && (
          <Box>
            <Typography variant="subtitle2">⑳ 과열 번호</Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
              {p.number_states.overheated.map((n) => (
                <LottoBall key={n} number={n} size={28} />
              ))}
            </Stack>
          </Box>
        )}
        {p.number_states?.cooled && p.number_states.cooled.length > 0 && (
          <Box>
            <Typography variant="subtitle2">㉑ 냉각 번호</Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
              {p.number_states.cooled.map((n) => (
                <LottoBall key={n} number={n} size={28} />
              ))}
            </Stack>
          </Box>
        )}
      </Stack>

      {b && b.sample_count ? (
        <>
          <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
            ⑪ 보너스 분석
          </Typography>
          <Grid container spacing={1} sx={{ mb: 1 }}>
            <Grid item xs={12} md={4}>
              <Metric label="보너스 반복 출현" value={b.bonus_repeat_count ?? 0} />
            </Grid>
          </Grid>
          <FreqTable title="후속 보너스 TOP" rows={b.bonus_next_counts ?? []} />
          <FreqTable title="보너스→본번호 전환" rows={b.bonus_in_main_numbers ?? []} />
        </>
      ) : null}
    </Box>
  );
}
