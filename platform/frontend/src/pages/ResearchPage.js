import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Alert, Box, Button, Chip, CircularProgress, Grid, Paper, Stack, Typography, } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import CopyButton from '../components/CopyButton';
import PairHeatmap from '../components/PairHeatmap';
import TriplePanel from '../components/TriplePanel';
import RulesPanel from '../components/RulesPanel';
import { AdvancedResearchGrid } from '../components/research/AdvancedPanels';
import { fetchJson } from '../api/fetchJson';
function KpiCard({ label, value }) {
    return (_jsxs(Paper, { sx: { p: 2 }, children: [_jsx(Typography, { variant: "caption", color: "text.secondary", children: label }), _jsx(Typography, { variant: "h5", children: value })] }));
}
export default function ResearchPage() {
    const status = useQuery({
        queryKey: ['status'],
        queryFn: () => fetchJson('/api/data/status'),
    });
    const kpi = useQuery({
        queryKey: ['kpi'],
        queryFn: () => fetchJson('/api/dashboard/kpi'),
    });
    const score = useQuery({
        queryKey: ['score'],
        queryFn: () => fetchJson('/api/score'),
    });
    const rec = useQuery({
        queryKey: ['recommend'],
        queryFn: () => fetchJson('/api/recommend?n_sets=5'),
        enabled: false,
    });
    const backtest = useQuery({
        queryKey: ['backtest'],
        queryFn: () => fetchJson('/api/backtest'),
        enabled: false,
    });
    const cond = useQuery({
        queryKey: ['cond'],
        queryFn: () => fetchJson('/api/conditional/pair?a=7&b=11'),
    });
    const k = kpi.data;
    return (_jsxs(Box, { children: [_jsx(Typography, { variant: "h5", fontWeight: 800, gutterBottom: true, children: "\uD328\uD134 \uC5F0\uAD6C \u00B7 \uAC80\uC99D" }), _jsxs(Alert, { severity: "info", sx: { mb: 2 }, children: ["\uB3C5\uB9BD\uC2DC\uD589 \uD655\uB960 \uAC8C\uC784 \u2014 \uBAA8\uB4E0 \uC218\uCE58\uB294 \uACFC\uAC70 \uB370\uC774\uD130 \uAE30\uBC18\uC774\uBA70 \uB2F9\uCCA8\uC744 \uBCF4\uC7A5\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.", status.data?.ok && (_jsxs(_Fragment, { children: [" (\uB370\uC774\uD130 ", status.data.row_count, "\uAC74 \u00B7 ", status.data.source, ")"] }))] }), status.isError && (_jsx(Alert, { severity: "warning", sx: { mb: 2 }, children: "v2 API \uC5F0\uACB0 \uC2E4\uD328 \u2014 \uC5F0\uAD6C \uBC31\uC5D4\uB4DC(\uD3EC\uD2B8 8100)\uAC00 \uC2E4\uD589 \uC911\uC778\uC9C0 \uD655\uC778\uD558\uC138\uC694." })), kpi.isLoading && _jsx(CircularProgress, { size: 24, sx: { mb: 2 } }), _jsxs(Grid, { container: true, spacing: 2, sx: { mb: 2 }, children: [_jsx(Grid, { item: true, xs: 6, md: 2, children: _jsx(KpiCard, { label: "\uCD5C\uC2E0 \uD68C\uCC28", value: k?.latest_round ?? '—' }) }), _jsx(Grid, { item: true, xs: 6, md: 2, children: _jsx(KpiCard, { label: "AC", value: k?.ac ?? '—' }) }), _jsx(Grid, { item: true, xs: 6, md: 2, children: _jsx(KpiCard, { label: "\uC774\uC6D4\uC218", value: k?.repeat_count ?? '—' }) }), _jsx(Grid, { item: true, xs: 6, md: 2, children: _jsx(KpiCard, { label: "\uC774\uC6C3\uC218", value: k?.neighbor_count ?? '—' }) }), _jsx(Grid, { item: true, xs: 6, md: 2, children: _jsx(KpiCard, { label: "\uD638\uAE30", value: k?.machine_no ?? '—' }) })] }), k?.numbers && (_jsxs(Paper, { sx: { p: 2, mb: 2 }, children: [_jsx(Typography, { variant: "subtitle1", children: "\uCD5C\uC2E0 \uB2F9\uCCA8" }), _jsxs(Stack, { direction: "row", spacing: 1, flexWrap: "wrap", useFlexGap: true, children: [k.numbers.map((n) => (_jsx(Chip, { label: n, color: "primary" }, n))), _jsx(Chip, { label: `+${k.bonus}`, variant: "outlined" })] })] })), _jsxs(Paper, { sx: { p: 2, mb: 2 }, children: [_jsx(Typography, { variant: "h6", gutterBottom: true, children: "45\u00D745 Pair \uD788\uD2B8\uB9F5" }), _jsx(PairHeatmap, {})] }), _jsxs(Paper, { sx: { p: 2, mb: 2 }, children: [_jsx(Typography, { variant: "h6", gutterBottom: true, children: "Triple \uD328\uD134" }), _jsx(TriplePanel, {})] }), _jsxs(Grid, { container: true, spacing: 2, children: [_jsx(Grid, { item: true, xs: 12, md: 6, children: _jsxs(Paper, { sx: { p: 2 }, children: [_jsx(Typography, { variant: "h6", children: "\uC870\uAC74\uBD80 \uD655\uB960 (7-11)" }), cond.isLoading && _jsx(CircularProgress, { size: 20 }), cond.isError && _jsx(Typography, { color: "error", children: "\uB85C\uB4DC \uC2E4\uD328" }), _jsx(Typography, { variant: "body2", color: "text.secondary", children: cond.data?.evidence }), cond.data?.top_next_numbers?.slice(0, 5).map((t) => (_jsxs(Typography, { children: [t.number, "\uBC88 P=", t.probability] }, t.number)))] }) }), _jsx(Grid, { item: true, xs: 12, md: 6, children: _jsx(RulesPanel, {}) }), _jsx(Grid, { item: true, xs: 12, md: 6, children: _jsxs(Paper, { sx: { p: 2 }, children: [_jsx(Typography, { variant: "h6", children: "\uBC88\uD638 \uC810\uC218 TOP 8" }), score.isLoading && _jsx(CircularProgress, { size: 20 }), score.data?.ranking?.slice(0, 8).map((r) => (_jsxs(Typography, { variant: "body2", children: [r.number, ": ", r.score, " \u2014 ", r.reasons.join(', ')] }, r.number)))] }) })] }), _jsx(AdvancedResearchGrid, {}), _jsxs(Stack, { direction: "row", spacing: 2, sx: { mt: 2 }, flexWrap: "wrap", useFlexGap: true, children: [_jsx(Button, { variant: "contained", onClick: () => rec.refetch(), disabled: rec.isFetching, children: rec.isFetching ? _jsx(CircularProgress, { size: 20 }) : '추천 5조합' }), _jsx(Button, { variant: "outlined", onClick: () => backtest.refetch(), disabled: backtest.isFetching, children: backtest.isFetching ? _jsx(CircularProgress, { size: 20 }) : '백테스트' })] }), rec.data?.combinations && (_jsxs(Paper, { sx: { p: 2, mt: 2 }, children: [_jsx(Typography, { variant: "h6", children: "\uCD94\uCC9C \uC870\uD569" }), rec.data.combinations.map((c, i) => (_jsxs(Box, { sx: { mb: 1, display: 'flex', alignItems: 'center', gap: 1 }, children: [_jsxs(Typography, { sx: { flex: 1 }, children: [i + 1, ". ", c.numbers.join(' ')] }), _jsx(CopyButton, { numbers: c.numbers })] }, i)))] })), backtest.data?.hit_rate_top6 != null && (_jsxs(Paper, { sx: { p: 2, mt: 2 }, children: [_jsx(Typography, { variant: "h6", children: "Walk-Forward \uBC31\uD14C\uC2A4\uD2B8" }), _jsxs(Typography, { children: ["Top6 Hit: ", backtest.data.hit_rate_top6] }), backtest.data.hit_rate_top4 != null && (_jsxs(Typography, { variant: "body2", children: ["Top4 Hit: ", backtest.data.hit_rate_top4] })), backtest.data.rounds_tested != null && (_jsxs(Typography, { variant: "caption", color: "text.secondary", children: ["\uAC80\uC99D \uD68C\uCC28: ", backtest.data.rounds_tested] })), _jsx(Typography, { variant: "caption", display: "block", children: backtest.data.disclaimer })] }))] }));
}
