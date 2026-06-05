/**
 * 45×45 Pair 히트맵 (ECharts)
 */
import ReactECharts from 'echarts-for-react';
import { Box, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../api/fetchJson';

type Metric = 'cooccurrence' | 'lift' | 'pmi' | 'conditional';

const METRIC_LABEL: Record<Metric, string> = {
  cooccurrence: '동시출현',
  lift: 'Lift',
  pmi: 'PMI',
  conditional: '조건부 P',
};

export default function PairHeatmap() {
  const [metric, setMetric] = useState<Metric>('cooccurrence');
  const { data, isLoading, error } = useQuery({
    queryKey: ['pair-matrix', metric],
    queryFn: () =>
      fetchJson<{ labels?: string[]; data?: [number, number, number][]; max?: number }>(
        `/api/pair-matrix?metric=${metric}`
      ),
  });

  const labels: string[] = data?.labels ?? [];
  const chartData: [number, number, number][] = data?.data ?? [];

  const option = {
    tooltip: {
      position: 'top',
      formatter: (p: { data: [number, number, number] }) => {
        const [xj, yi, v] = p.data;
        return `${labels[yi]} × ${labels[xj]}<br/>${METRIC_LABEL[metric]}: ${v}`;
      },
    },
    grid: { height: '72%', top: '8%', left: '12%', right: '4%' },
    xAxis: {
      type: 'category',
      data: labels,
      splitArea: { show: true },
      axisLabel: { fontSize: 8, interval: 4 },
    },
    yAxis: {
      type: 'category',
      data: labels,
      splitArea: { show: true },
      axisLabel: { fontSize: 8, interval: 4 },
    },
    visualMap: {
      min: 0,
      max: data?.max ?? 10,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: '0%',
      inRange: { color: ['#1a1d21', '#2e5a8a', '#f4d03f', '#e74c3c'] },
    },
    series: [
      {
        name: METRIC_LABEL[metric],
        type: 'heatmap',
        data: chartData,
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.5)' } },
      },
    ],
  };

  return (
    <Box>
      <ToggleButtonGroup
        size="small"
        value={metric}
        exclusive
        onChange={(_, v) => v && setMetric(v)}
        sx={{ mb: 1 }}
      >
        {(Object.keys(METRIC_LABEL) as Metric[]).map((m) => (
          <ToggleButton key={m} value={m}>
            {METRIC_LABEL[m]}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      {isLoading && <Typography>히트맵 로딩…</Typography>}
      {error && <Typography color="error">히트맵 로드 실패 (API 8100 확인)</Typography>}
      {data && (
        <ReactECharts option={option} style={{ height: 520, width: '100%' }} opts={{ renderer: 'canvas' }} />
      )}
    </Box>
  );
}
