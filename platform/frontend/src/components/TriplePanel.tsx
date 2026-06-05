/**
 * Triple 분석 — TOP 막대 + 앵커 히트맵
 */
import ReactECharts from 'echarts-for-react';
import { Box, Slider, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../api/fetchJson';

export default function TriplePanel() {
  const [anchor, setAnchor] = useState(7);
  const [view, setView] = useState<'top' | 'anchor'>('top');

  const topQ = useQuery({
    queryKey: ['triple-top'],
    queryFn: () =>
      fetchJson<{ items?: { triple: string; occurrence_count: number }[] }>(
        '/api/triple-matrix?mode=top&limit=40'
      ),
    enabled: view === 'top',
  });

  const heatQ = useQuery({
    queryKey: ['triple-anchor', anchor],
    queryFn: () =>
      fetchJson<{
        labels?: string[];
        data?: [number, number, number][];
        max?: number;
      }>(`/api/triple-matrix?mode=anchor&anchor=${anchor}&metric=cooccurrence`),
    enabled: view === 'anchor',
  });

  const barOption =
    view === 'top' && topQ.data?.items
      ? {
          tooltip: {},
          xAxis: { type: 'value' },
          yAxis: {
            type: 'category',
            data: topQ.data.items.map((x: { triple: string }) => x.triple).reverse(),
            axisLabel: { fontSize: 9 },
          },
          series: [
            {
              type: 'bar',
              data: topQ.data.items
                .map((x: { occurrence_count: number }) => x.occurrence_count)
                .reverse(),
              itemStyle: { color: '#f4d03f' },
            },
          ],
        }
      : null;

  const heatData = heatQ.data;
  const heatOption = heatData?.data
    ? {
        tooltip: { position: 'top' },
        grid: { height: '70%', top: '10%' },
        xAxis: { type: 'category', data: heatData.labels, axisLabel: { fontSize: 8, interval: 4 } },
        yAxis: { type: 'category', data: heatData.labels, axisLabel: { fontSize: 8, interval: 4 } },
        visualMap: {
          min: 0,
          max: heatData.max || 5,
          calculable: true,
          orient: 'horizontal',
          left: 'center',
          bottom: 0,
          inRange: { color: ['#1a1d21', '#2e5a8a', '#9b59b6', '#e74c3c'] },
        },
        series: [{ type: 'heatmap', data: heatData.data }],
      }
    : null;

  return (
    <Box>
      <ToggleButtonGroup
        size="small"
        value={view}
        exclusive
        onChange={(_, v) => v && setView(v)}
        sx={{ mb: 1 }}
      >
        <ToggleButton value="top">TOP Triple</ToggleButton>
        <ToggleButton value="anchor">앵커 히트맵</ToggleButton>
      </ToggleButtonGroup>
      {view === 'anchor' && (
        <Box sx={{ px: 2, mb: 1 }}>
          <Typography variant="caption">앵커 번호: {anchor}</Typography>
          <Slider
            min={1}
            max={45}
            value={anchor}
            onChange={(_, v) => setAnchor(v as number)}
            valueLabelDisplay="auto"
          />
        </Box>
      )}
      {view === 'top' && barOption && (
        <ReactECharts option={barOption} style={{ height: 480 }} />
      )}
      {view === 'anchor' && heatOption && (
        <ReactECharts option={heatOption} style={{ height: 480 }} />
      )}
    </Box>
  );
}
