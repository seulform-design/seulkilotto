import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 45×45 Pair 히트맵 (ECharts)
 */
import ReactECharts from 'echarts-for-react';
import { Box, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../api/fetchJson';
const METRIC_LABEL = {
    cooccurrence: '동시출현',
    lift: 'Lift',
    pmi: 'PMI',
    conditional: '조건부 P',
};
export default function PairHeatmap() {
    const [metric, setMetric] = useState('cooccurrence');
    const { data, isLoading, error } = useQuery({
        queryKey: ['pair-matrix', metric],
        queryFn: () => fetchJson(`/api/pair-matrix?metric=${metric}`),
    });
    const labels = data?.labels ?? [];
    const chartData = data?.data ?? [];
    const option = {
        tooltip: {
            position: 'top',
            formatter: (p) => {
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
    return (_jsxs(Box, { children: [_jsx(ToggleButtonGroup, { size: "small", value: metric, exclusive: true, onChange: (_, v) => v && setMetric(v), sx: { mb: 1 }, children: Object.keys(METRIC_LABEL).map((m) => (_jsx(ToggleButton, { value: m, children: METRIC_LABEL[m] }, m))) }), isLoading && _jsx(Typography, { children: "\uD788\uD2B8\uB9F5 \uB85C\uB529\u2026" }), error && _jsx(Typography, { color: "error", children: "\uD788\uD2B8\uB9F5 \uB85C\uB4DC \uC2E4\uD328 (API 8100 \uD655\uC778)" }), data && (_jsx(ReactECharts, { option: option, style: { height: 520, width: '100%' }, opts: { renderer: 'canvas' } }))] }));
}
