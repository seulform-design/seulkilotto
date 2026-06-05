import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
    const [view, setView] = useState('top');
    const topQ = useQuery({
        queryKey: ['triple-top'],
        queryFn: () => fetchJson('/api/triple-matrix?mode=top&limit=40'),
        enabled: view === 'top',
    });
    const heatQ = useQuery({
        queryKey: ['triple-anchor', anchor],
        queryFn: () => fetchJson(`/api/triple-matrix?mode=anchor&anchor=${anchor}&metric=cooccurrence`),
        enabled: view === 'anchor',
    });
    const barOption = view === 'top' && topQ.data?.items
        ? {
            tooltip: {},
            xAxis: { type: 'value' },
            yAxis: {
                type: 'category',
                data: topQ.data.items.map((x) => x.triple).reverse(),
                axisLabel: { fontSize: 9 },
            },
            series: [
                {
                    type: 'bar',
                    data: topQ.data.items
                        .map((x) => x.occurrence_count)
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
    return (_jsxs(Box, { children: [_jsxs(ToggleButtonGroup, { size: "small", value: view, exclusive: true, onChange: (_, v) => v && setView(v), sx: { mb: 1 }, children: [_jsx(ToggleButton, { value: "top", children: "TOP Triple" }), _jsx(ToggleButton, { value: "anchor", children: "\uC575\uCEE4 \uD788\uD2B8\uB9F5" })] }), view === 'anchor' && (_jsxs(Box, { sx: { px: 2, mb: 1 }, children: [_jsxs(Typography, { variant: "caption", children: ["\uC575\uCEE4 \uBC88\uD638: ", anchor] }), _jsx(Slider, { min: 1, max: 45, value: anchor, onChange: (_, v) => setAnchor(v), valueLabelDisplay: "auto" })] })), view === 'top' && barOption && (_jsx(ReactECharts, { option: barOption, style: { height: 480 } })), view === 'anchor' && heatOption && (_jsx(ReactECharts, { option: heatOption, style: { height: 480 } }))] }));
}
