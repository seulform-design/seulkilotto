import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Alert, Box, Button, Chip, CircularProgress, Paper, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography, } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import LottoBall from '../components/LottoBall';
import OddEvenBar from '../components/OddEvenBar';
import { v1Api } from '../api/v1Api';
function StatChip({ label, value }) {
    return (_jsxs(Paper, { sx: { flex: 1, p: 2, bgcolor: '#262A30' }, children: [_jsx(Typography, { variant: "caption", color: "text.secondary", children: label }), _jsx(Typography, { variant: "body1", fontWeight: 700, children: value })] }));
}
export default function DashboardPage() {
    const qc = useQueryClient();
    const [recentN, setRecentN] = useState('all');
    const [inputs, setInputs] = useState(['', '', '', '', '', '']);
    const meta = useQuery({ queryKey: ['v1-meta'], queryFn: v1Api.getMeta });
    const upgradeStatus = useQuery({
        queryKey: ['v1-upgrade-status'],
        queryFn: v1Api.getUpgradeStatus,
        staleTime: 60000,
    });
    const latest = useQuery({ queryKey: ['v1-latest'], queryFn: v1Api.getLatestDraw });
    const frequency = useQuery({
        queryKey: ['v1-frequency', recentN],
        queryFn: () => v1Api.getFrequency(recentN === 'all' ? undefined : recentN),
    });
    const analysis = useQuery({
        queryKey: ['v1-analysis', latest.data?.numbers],
        queryFn: () => v1Api.analyzeCombination(latest.data.numbers),
        enabled: !!latest.data?.numbers?.length,
    });
    const customAnalyze = useMutation({
        mutationFn: (numbers) => v1Api.analyzeCombination(numbers),
    });
    const draw = latest.data;
    const m = meta.data;
    const hot = frequency.data?.items.slice(0, 5) ?? [];
    const cold = frequency.data?.items.slice(-5).reverse() ?? [];
    const handleCustomAnalyze = () => {
        const nums = inputs.map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
        if (nums.length !== 6 || new Set(nums).size !== 6)
            return;
        customAnalyze.mutate(nums);
    };
    return (_jsxs(Box, { children: [_jsx(Typography, { variant: "h5", fontWeight: 800, gutterBottom: true, children: "\uB85C\uB610 \uBD84\uC11D \uB300\uC2DC\uBCF4\uB4DC" }), m && (_jsxs(Typography, { variant: "body2", color: "warning.main", sx: { mb: 1 }, children: ["\uD604\uC7AC ", m.current_round, "\uD68C \u00B7 \uCD5C\uC2E0 \uCD94\uCCA8 ", m.latest_round, "\uD68C \u00B7 \uB370\uC774\uD130 ", m.source, m.is_complete ? ' · 전체 OK' : ''] })), _jsx(Button, { size: "small", variant: "outlined", sx: { mb: 2 }, onClick: () => {
                    qc.invalidateQueries({ queryKey: ['v1-meta'] });
                    qc.invalidateQueries({ queryKey: ['v1-latest'] });
                    qc.invalidateQueries({ queryKey: ['v1-frequency'] });
                    qc.invalidateQueries({ queryKey: ['v1-analysis'] });
                }, children: "\uC0C8\uB85C\uACE0\uCE68" }), upgradeStatus.data?.can_upgrade && (_jsxs(Alert, { severity: "info", sx: { mb: 2 }, children: ["\uC2E0\uADDC ", upgradeStatus.data.pending_count, "\uD68C\uCC28 \uC5C5\uADF8\uB808\uC774\uB4DC \uAC00\uB2A5 \u2014 \u300C\uD68C\uCC28\u300D \uD0ED\uC5D0\uC11C \uBC18\uC601\uD558\uC138\uC694."] })), latest.isError && (_jsx(Alert, { severity: "warning", sx: { mb: 2 }, children: "API \uC5F0\uACB0 \uC2E4\uD328 \u2014 \uC11C\uBC84\uAC00 \uC2E4\uD589 \uC911\uC778\uC9C0 \uD655\uC778\uD558\uC138\uC694." })), latest.isLoading ? (_jsx(CircularProgress, {})) : draw ? (_jsxs(_Fragment, { children: [_jsxs(Paper, { sx: { p: 2, mb: 2 }, children: [_jsxs(Box, { sx: { display: 'flex', justifyContent: 'space-between', mb: 2 }, children: [_jsxs(Typography, { variant: "h6", children: [draw.round, "\uD68C \uB2F9\uCCA8 \uBC88\uD638"] }), _jsx(Typography, { variant: "body2", color: "text.secondary", children: draw.draw_date })] }), _jsxs(Stack, { direction: "row", spacing: 1, alignItems: "center", flexWrap: "wrap", useFlexGap: true, children: [draw.numbers.map((n) => (_jsx(LottoBall, { number: n }, n))), _jsx(Typography, { sx: { mx: 0.5, color: 'text.secondary', fontWeight: 700 }, children: "+" }), _jsx(LottoBall, { number: draw.bonus }), _jsx(Chip, { label: "\uBCF4\uB108\uC2A4", size: "small", variant: "outlined" })] })] }), _jsxs(Paper, { sx: { p: 2, mb: 2 }, children: [_jsx(Typography, { variant: "h6", gutterBottom: true, children: "\uD640\uC9DD \uBE44\uC728" }), analysis.isLoading && _jsx(CircularProgress, { size: 24 }), analysis.data && (_jsxs(Box, { sx: { mt: 2 }, children: [_jsx(OddEvenBar, { odd: analysis.data.odd_count, even: analysis.data.even_count }), _jsxs(Stack, { direction: "row", spacing: 1, sx: { mt: 2 }, children: [_jsx(StatChip, { label: "\uCD1D\uD569", value: `${analysis.data.sum_total} (${analysis.data.sum_band})` }), _jsx(StatChip, { label: "\uC5F0\uC18D \uBC88\uD638", value: analysis.data.has_consecutive ? '있음' : '없음' })] })] }))] }), _jsxs(Paper, { sx: { p: 2, mb: 2 }, children: [_jsx(Typography, { variant: "h6", gutterBottom: true, children: "\uBC88\uD638 \uCD9C\uD604 \uBE48\uB3C4" }), _jsxs(ToggleButtonGroup, { exclusive: true, size: "small", value: recentN, onChange: (_, v) => v && setRecentN(v), sx: { mb: 2 }, children: [_jsx(ToggleButton, { value: "all", children: "\uC804\uCCB4" }), _jsx(ToggleButton, { value: 50, children: "\uCD5C\uADFC 50\uD68C" }), _jsx(ToggleButton, { value: 100, children: "\uCD5C\uADFC 100\uD68C" })] }), frequency.isLoading && _jsx(CircularProgress, { size: 20 }), frequency.data && (_jsxs(Stack, { direction: { xs: 'column', md: 'row' }, spacing: 2, children: [_jsxs(Box, { sx: { flex: 1 }, children: [_jsx(Typography, { variant: "caption", color: "success.main", children: "HOT TOP 5" }), _jsx(Stack, { direction: "row", spacing: 0.75, flexWrap: "wrap", useFlexGap: true, sx: { mt: 1 }, children: hot.map((h) => (_jsx(Chip, { label: `${h.number} (${h.count}회)`, size: "small" }, h.number))) })] }), _jsxs(Box, { sx: { flex: 1 }, children: [_jsx(Typography, { variant: "caption", color: "info.main", children: "COLD TOP 5" }), _jsx(Stack, { direction: "row", spacing: 0.75, flexWrap: "wrap", useFlexGap: true, sx: { mt: 1 }, children: cold.map((c) => (_jsx(Chip, { label: `${c.number} (${c.count}회)`, size: "small", variant: "outlined" }, c.number))) })] })] }))] }), _jsxs(Paper, { sx: { p: 2 }, children: [_jsx(Typography, { variant: "h6", gutterBottom: true, children: "\uB0B4 \uBC88\uD638 \uBD84\uC11D" }), _jsx(Stack, { direction: "row", spacing: 1, flexWrap: "wrap", useFlexGap: true, sx: { mb: 2 }, children: inputs.map((val, i) => (_jsx(TextField, { label: `${i + 1}`, type: "number", size: "small", value: val, onChange: (e) => {
                                        const next = [...inputs];
                                        next[i] = e.target.value;
                                        setInputs(next);
                                    }, inputProps: { min: 1, max: 45 }, sx: { width: 72 } }, i))) }), _jsx(Button, { variant: "contained", size: "small", onClick: handleCustomAnalyze, children: "\uBD84\uC11D\uD558\uAE30" }), customAnalyze.data && (_jsxs(Box, { sx: { mt: 2 }, children: [_jsx(OddEvenBar, { odd: customAnalyze.data.odd_count, even: customAnalyze.data.even_count }), _jsxs(Typography, { variant: "body2", sx: { mt: 1 }, children: ["\uCD1D\uD569 ", customAnalyze.data.sum_total, " (", customAnalyze.data.sum_band, ") \u00B7 \uC5F0\uC18D", ' ', customAnalyze.data.has_consecutive ? '있음' : '없음'] })] })), customAnalyze.isError && (_jsx(Alert, { severity: "error", sx: { mt: 1 }, children: "1~45 \uC0AC\uC774 \uC11C\uB85C \uB2E4\uB978 6\uAC1C \uBC88\uD638\uB97C \uC785\uB825\uD558\uC138\uC694." }))] })] })) : null] }));
}
