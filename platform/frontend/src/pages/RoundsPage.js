import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Alert, Box, Button, Chip, CircularProgress, List, ListItemButton, ListItemText, Paper, Stack, Typography, } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import LottoBall from '../components/LottoBall';
import OddEvenBar from '../components/OddEvenBar';
import { v1Api } from '../api/v1Api';
export default function RoundsPage() {
    const qc = useQueryClient();
    const [selectedRound, setSelectedRound] = useState(null);
    const status = useQuery({
        queryKey: ['v1-upgrade-status'],
        queryFn: v1Api.getUpgradeStatus,
        refetchInterval: 60000,
    });
    const rounds = useQuery({
        queryKey: ['v1-rounds'],
        queryFn: () => v1Api.listRounds(50),
    });
    const roundDetail = useQuery({
        queryKey: ['v1-round', selectedRound],
        queryFn: () => v1Api.getRound(selectedRound),
        enabled: selectedRound != null,
    });
    const roundAnalysis = useQuery({
        queryKey: ['v1-round-analysis', selectedRound],
        queryFn: () => v1Api.analyzeCombination(roundDetail.data.numbers),
        enabled: !!roundDetail.data?.numbers,
    });
    const upgrade = useMutation({
        mutationFn: () => v1Api.runUpgrade(),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['v1-upgrade-status'] });
            qc.invalidateQueries({ queryKey: ['v1-rounds'] });
            qc.invalidateQueries({ queryKey: ['v1-meta'] });
            qc.invalidateQueries({ queryKey: ['v1-latest'] });
            qc.invalidateQueries({ queryKey: ['v1-frequency'] });
        },
    });
    const s = status.data;
    return (_jsxs(Box, { children: [_jsx(Typography, { variant: "h5", fontWeight: 800, gutterBottom: true, children: "\uD68C\uCC28 \uC5C5\uADF8\uB808\uC774\uB4DC" }), _jsx(Typography, { variant: "body2", color: "text.secondary", sx: { mb: 2 }, children: "\uB3D9\uD589\uBCF5\uAD8C \uCD5C\uC2E0 \uCD94\uCCA8\uC744 \uC790\uB3D9 \uC218\uC9D1\uD574 CSV\u00B7\uBD84\uC11D \uB370\uC774\uD130\uB97C \uAC31\uC2E0\uD569\uB2C8\uB2E4." }), _jsxs(Paper, { sx: { p: 2, mb: 2 }, children: [_jsxs(Stack, { direction: "row", spacing: 2, flexWrap: "wrap", useFlexGap: true, sx: { mb: 2 }, children: [_jsx(Chip, { label: `로컬 최신 ${s?.latest_round ?? '—'}회`, color: "primary" }), _jsx(Chip, { label: `API 최신 ${s?.api_latest_round ?? '—'}회`, variant: "outlined" }), _jsx(Chip, { label: `대기 ${s?.pending_count ?? 0}회`, color: s?.pending_count ? 'warning' : 'default' }), _jsx(Chip, { label: `데이터 ${s?.source ?? '—'}`, size: "small" })] }), s?.pending_rounds && s.pending_rounds.length > 0 && (_jsxs(Alert, { severity: "info", sx: { mb: 2 }, children: ["\uC2E0\uADDC \uD68C\uCC28: ", s.pending_rounds.join(', '), "\uD68C \uC5C5\uADF8\uB808\uC774\uB4DC \uAC00\uB2A5"] })), s?.api_error && (_jsxs(Alert, { severity: "warning", sx: { mb: 2 }, children: ["API \uC870\uD68C \uC2E4\uD328: ", s.api_error] })), _jsx(Button, { variant: "contained", color: "success", onClick: () => upgrade.mutate(), disabled: upgrade.isPending || status.isLoading, children: upgrade.isPending ? (_jsx(CircularProgress, { size: 22, color: "inherit" })) : ('최신 회차 업그레이드') })] }), upgrade.data && (_jsxs(Alert, { severity: upgrade.data.ok ? 'success' : 'warning', sx: { mb: 2 }, children: [upgrade.data.message ??
                        `${upgrade.data.before_latest}회 → ${upgrade.data.after_latest}회 (신규 ${upgrade.data.new_rounds}건)`, upgrade.data.v2_sync?.ok && ' · v2 DB 동기화 OK'] })), upgrade.isError && (_jsx(Alert, { severity: "error", sx: { mb: 2 }, children: upgrade.error instanceof Error ? upgrade.error.message : '업그레이드 실패' })), _jsxs(Paper, { sx: { p: 2 }, children: [_jsx(Typography, { variant: "h6", gutterBottom: true, children: "\uD68C\uCC28\uBCC4 \uB2F9\uCCA8 \uB0B4\uC5ED" }), rounds.isLoading && _jsx(CircularProgress, { size: 24 }), _jsxs(Stack, { direction: { xs: 'column', md: 'row' }, spacing: 2, children: [_jsx(List, { dense: true, sx: {
                                    width: { xs: '100%', md: 280 },
                                    maxHeight: 420,
                                    overflow: 'auto',
                                    bgcolor: '#262A30',
                                    borderRadius: 1,
                                }, children: rounds.data?.items.map((item) => (_jsx(ListItemButton, { selected: selectedRound === item.round, onClick: () => setSelectedRound(item.round), children: _jsx(ListItemText, { primary: `${item.round}회`, secondary: item.draw_date }) }, item.round))) }), _jsxs(Box, { sx: { flex: 1 }, children: [!selectedRound && (_jsx(Typography, { color: "text.secondary", children: "\uD68C\uCC28\uB97C \uC120\uD0DD\uD558\uC138\uC694" })), roundDetail.data && (_jsxs(_Fragment, { children: [_jsxs(Typography, { variant: "subtitle1", fontWeight: 700, gutterBottom: true, children: [roundDetail.data.round, "\uD68C \u00B7 ", roundDetail.data.draw_date] }), _jsxs(Stack, { direction: "row", spacing: 0.75, flexWrap: "wrap", useFlexGap: true, sx: { mb: 2 }, children: [roundDetail.data.numbers.map((n) => (_jsx(LottoBall, { number: n, size: 40 }, n))), _jsx(Typography, { sx: { alignSelf: 'center', mx: 0.5 }, children: "+" }), _jsx(LottoBall, { number: roundDetail.data.bonus, size: 40 })] }), roundAnalysis.data && (_jsxs(Box, { children: [_jsx(OddEvenBar, { odd: roundAnalysis.data.odd_count, even: roundAnalysis.data.even_count }), _jsxs(Typography, { variant: "body2", sx: { mt: 1 }, children: ["\uCD1D\uD569 ", roundAnalysis.data.sum_total, " (", roundAnalysis.data.sum_band, ")"] })] }))] }))] })] })] })] }));
}
