import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Box, Button, CircularProgress, Grid, Paper, Typography, } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../../api/fetchJson';
function Panel({ title, loading, error, children, }) {
    return (_jsxs(Paper, { sx: { p: 2, height: '100%' }, children: [_jsx(Typography, { variant: "h6", gutterBottom: true, children: title }), loading && _jsx(CircularProgress, { size: 22 }), error && _jsx(Typography, { color: "error", children: "\uB85C\uB4DC \uC2E4\uD328" }), children] }));
}
export function SurvivalPanel() {
    const q = useQuery({
        queryKey: ['survival'],
        queryFn: () => fetchJson('/api/survival'),
    });
    const entries = q.data?.numbers
        ? Object.entries(q.data.numbers)
            .map(([n, lags]) => ({ n: Number(n), lag1: lags.lag_1 ?? 0 }))
            .sort((a, b) => b.lag1 - a.lag1)
            .slice(0, 6)
        : [];
    return (_jsxs(Panel, { title: "\uBC88\uD638 \uC0DD\uC874 \uD1B5\uACC4", loading: q.isLoading, error: q.isError, children: [_jsx(Typography, { variant: "caption", color: "text.secondary", children: "\uB2E4\uC74C \uD68C\uCC28 \uC7AC\uCD9C\uD604 \uD655\uB960(lag_1) \uC0C1\uC704" }), entries.map((x) => (_jsxs(Typography, { variant: "body2", children: [x.n, "\uBC88 \u2014 ", x.lag1] }, x.n)))] }));
}
export function MarkovPanel() {
    const q = useQuery({
        queryKey: ['markov'],
        queryFn: () => fetchJson('/api/markov'),
    });
    return (_jsxs(Panel, { title: "\uB9C8\uB974\uCF54\uD504 \uC804\uC774", loading: q.isLoading, error: q.isError, children: [_jsx(Typography, { variant: "body2", color: "text.secondary", gutterBottom: true, children: q.data?.evidence }), q.data?.transition_sample &&
                Object.entries(q.data.transition_sample)
                    .slice(0, 3)
                    .map(([state, next]) => (_jsxs(Typography, { variant: "caption", display: "block", children: [state, " \u2192 ", Object.keys(next)[0]] }, state)))] }));
}
export function PatternDecayPanel() {
    const q = useQuery({
        queryKey: ['pattern-decay'],
        queryFn: () => fetchJson('/api/pattern-decay?window=30'),
    });
    const d = q.data;
    return (_jsx(Panel, { title: "\uD328\uD134 \uAC10\uC1E0 (\uC774\uC6D4\uC218)", loading: q.isLoading, error: q.isError, children: d && (_jsxs(_Fragment, { children: [_jsxs(Typography, { variant: "body2", children: ["\uC0C1\uD0DC: ", _jsx("strong", { children: d.status })] }), _jsxs(Typography, { variant: "caption", color: "text.secondary", children: ["\uC804\uCCB4 ", d.full, " \u00B7 \uCD5C\uADFC30 ", d.recent_30, " \u00B7 \u0394", d.delta] })] })) }));
}
export function StatsValidationPanel() {
    const q = useQuery({
        queryKey: ['statistics'],
        queryFn: () => fetchJson('/api/statistics'),
    });
    const d = q.data;
    return (_jsx(Panel, { title: "\uD1B5\uACC4 \uAC80\uC99D (\u03C7\u00B2)", loading: q.isLoading, error: q.isError, children: d && (_jsxs(_Fragment, { children: [_jsxs(Typography, { variant: "body2", children: ["p-value: ", d.p_value, " \u00B7 ", d.is_random_like ? '균등에 가까움' : '편향 감지'] }), _jsx(Typography, { variant: "caption", color: "text.secondary", children: d.interpretation })] })) }));
}
export function SimulationPanel() {
    const q = useQuery({
        queryKey: ['simulation'],
        queryFn: () => fetchJson('/api/simulation?n=50000'),
        enabled: false,
    });
    return (_jsxs(Panel, { title: "\uBAAC\uD14C\uCE74\uB97C\uB85C \uAE30\uC900\uC120", loading: q.isFetching, error: q.isError, children: [_jsx(Button, { size: "small", variant: "outlined", onClick: () => q.refetch(), disabled: q.isFetching, children: "5\uB9CC \uD68C \uC2DC\uBBAC\uB808\uC774\uC158" }), q.data && (_jsxs(Box, { sx: { mt: 1 }, children: [_jsxs(Typography, { variant: "body2", children: ["\uCD1D\uD569 \u03BC=", q.data.sum_mean, " \u03C3=", q.data.sum_std] }), _jsx(Typography, { variant: "caption", color: "text.secondary", children: q.data.evidence })] }))] }));
}
export function AdvancedResearchGrid() {
    return (_jsxs(Grid, { container: true, spacing: 2, sx: { mt: 1 }, children: [_jsx(Grid, { item: true, xs: 12, md: 6, children: _jsx(SurvivalPanel, {}) }), _jsx(Grid, { item: true, xs: 12, md: 6, children: _jsx(MarkovPanel, {}) }), _jsx(Grid, { item: true, xs: 12, md: 4, children: _jsx(PatternDecayPanel, {}) }), _jsx(Grid, { item: true, xs: 12, md: 4, children: _jsx(StatsValidationPanel, {}) }), _jsx(Grid, { item: true, xs: 12, md: 4, children: _jsx(SimulationPanel, {}) })] }));
}
