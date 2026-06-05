import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * FP-Growth 연관규칙 테이블
 */
import { Paper, Table, TableBody, TableCell, TableHead, TableRow, Typography, Button, } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../api/fetchJson';
export default function RulesPanel() {
    const { data, refetch, isFetching } = useQuery({
        queryKey: ['rules-fp'],
        queryFn: () => fetchJson('/api/rules?method=fpgrowth&min_support=0.015&min_confidence=0.12'),
        enabled: false,
    });
    return (_jsxs(Paper, { sx: { p: 2 }, children: [_jsx(Typography, { variant: "h6", gutterBottom: true, children: "FP-Growth \uC5F0\uAD00\uADDC\uCE59" }), _jsx(Button, { variant: "outlined", size: "small", onClick: () => refetch(), disabled: isFetching, children: "\uADDC\uCE59 \uB9C8\uC774\uB2DD \uC2E4\uD589" }), _jsxs(Typography, { variant: "caption", display: "block", sx: { mt: 1, mb: 1 }, children: [data?.method, " \u00B7 \uD2B8\uB79C\uC7AD\uC158 ", data?.transactions ?? '—', "\uAC74"] }), _jsxs(Table, { size: "small", children: [_jsx(TableHead, { children: _jsxs(TableRow, { children: [_jsx(TableCell, { children: "\uC120\uD589" }), _jsx(TableCell, { children: "\uACB0\uACFC" }), _jsx(TableCell, { children: "Support" }), _jsx(TableCell, { children: "Conf" }), _jsx(TableCell, { children: "Lift" })] }) }), _jsx(TableBody, { children: data?.rules?.slice(0, 15).map((r, i) => (_jsxs(TableRow, { children: [_jsx(TableCell, { children: r.antecedent?.join(', ') }), _jsx(TableCell, { children: r.consequent?.join(', ') }), _jsx(TableCell, { children: r.support }), _jsx(TableCell, { children: r.confidence }), _jsx(TableCell, { children: r.lift })] }, i))) })] }), _jsx(Typography, { variant: "caption", color: "text.secondary", children: data?.disclaimer })] }));
}
