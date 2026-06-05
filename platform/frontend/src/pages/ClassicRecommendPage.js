import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Alert, Box, Button, CircularProgress, Paper, Stack, ToggleButton, ToggleButtonGroup, Typography, } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import CopyButton from '../components/CopyButton';
import LottoBall from '../components/LottoBall';
import { v1Api } from '../api/v1Api';
const METHODS = [
    { id: 'wilson', label: '윌슨법', hint: '안정 출현 순위' },
    { id: 'gauss', label: '가우스법', hint: '총합·홀짝 μ±σ' },
    { id: 'huygens', label: '호이겐스법', hint: '미출현 gap' },
    { id: 'fermat', label: '페르마법', hint: '동시출현 쌍' },
    { id: 'blend', label: '4법 통합', hint: '각 1게임씩' },
];
export default function ClassicRecommendPage() {
    const [method, setMethod] = useState('blend');
    const patterns = useQuery({
        queryKey: ['v1-patterns'],
        queryFn: () => v1Api.getPatterns(),
    });
    const recommend = useQuery({
        queryKey: ['v1-classic', method],
        queryFn: () => v1Api.getClassicRecommend(method),
    });
    const data = recommend.data;
    const pat = patterns.data?.patterns;
    return (_jsxs(Box, { children: [_jsx(Typography, { variant: "h5", fontWeight: 800, gutterBottom: true, children: "\uD074\uB798\uC2DD \uCD94\uCC9C" }), _jsx(Typography, { variant: "body2", color: "text.secondary", sx: { mb: 2 }, children: "\uC70C\uC2A8\u00B7\uAC00\uC6B0\uC2A4\u00B7\uD638\uC774\uAC90\uC2A4\u00B7\uD398\uB974\uB9C8 \uC218\uD559 \uD734\uB9AC\uC2A4\uD2F1 \uAE30\uBC18 5\uAC8C\uC784 (\uD1B5\uACC4 \uCC38\uACE0\uC6A9)" }), _jsxs(Paper, { sx: { p: 2, mb: 2 }, children: [_jsx(Typography, { variant: "subtitle2", gutterBottom: true, children: "\uCD94\uCC9C \uBC29\uC2DD" }), _jsx(ToggleButtonGroup, { exclusive: true, size: "small", value: method, onChange: (_, v) => v && setMethod(v), sx: { flexWrap: 'wrap' }, children: METHODS.map((m) => (_jsx(ToggleButton, { value: m.id, sx: { mb: 0.5 }, children: m.label }, m.id))) }), _jsx(Typography, { variant: "caption", color: "text.secondary", display: "block", sx: { mt: 1 }, children: METHODS.find((m) => m.id === method)?.hint })] }), pat && method !== 'blend' && pat[method] && (_jsxs(Paper, { sx: { p: 2, mb: 2, bgcolor: '#262A30' }, children: [_jsxs(Typography, { variant: "subtitle2", children: [pat[method].label, " \uD328\uD134 \uC694\uC57D"] }), _jsx(Typography, { variant: "body2", color: "text.secondary", children: pat[method].description }), pat[method].top10 && (_jsxs(Typography, { variant: "caption", sx: { mt: 1, display: 'block' }, children: ["TOP: ", pat[method].top10.slice(0, 5).map((t) => t.number).join(', ')] }))] })), _jsx(Button, { variant: "contained", color: "warning", onClick: () => recommend.refetch(), disabled: recommend.isFetching, sx: { mb: 2, fontWeight: 800 }, children: recommend.isFetching ? (_jsx(CircularProgress, { size: 24, color: "inherit" })) : ('클래식 추천 받기') }), recommend.isError && (_jsx(Alert, { severity: "error", sx: { mb: 2 }, children: recommend.error instanceof Error ? recommend.error.message : '추천 실패' })), data?.warning && (_jsx(Alert, { severity: "warning", sx: { mb: 2 }, children: data.warning })), data && (_jsxs(_Fragment, { children: [_jsxs(Paper, { sx: { p: 2, mb: 2, bgcolor: '#B0D840', color: '#1A2A10' }, children: [_jsx(Typography, { variant: "caption", fontWeight: 600, children: "\uCD94\uCC9C \uB300\uC0C1" }), _jsxs(Typography, { variant: "h4", fontWeight: 800, children: [data.next_round, "\uD68C"] }), _jsxs(Typography, { variant: "body2", children: [data.next_draw_date, " \u00B7 ", data.method] })] }), _jsxs(Typography, { variant: "caption", color: "text.secondary", sx: { mb: 1, display: 'block' }, children: [data.compose_rule, " \u00B7 ", data.filter_rule] }), data.combinations.map((combo, idx) => (_jsxs(Paper, { sx: { p: 2, mb: 1, display: 'flex', alignItems: 'center', gap: 1 }, children: [_jsx(Typography, { sx: { width: 22, fontWeight: 800, color: 'text.secondary' }, children: idx + 1 }), _jsx(Stack, { direction: "row", spacing: 0.75, flexWrap: "wrap", useFlexGap: true, sx: { flex: 1 }, children: combo.numbers.map((n) => (_jsx(LottoBall, { number: n, size: 36 }, n))) }), _jsxs(Box, { sx: { textAlign: 'right' }, children: [combo.pattern_label && (_jsx(Typography, { variant: "caption", color: "text.secondary", display: "block", children: combo.pattern_label })), _jsxs(Typography, { variant: "caption", color: "text.secondary", children: ["\uD569", combo.sum_total] }), _jsx(CopyButton, { numbers: combo.numbers })] })] }, idx)))] }))] }));
}
