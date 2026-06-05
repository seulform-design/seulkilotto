import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { Box, Typography } from '@mui/material';
import { palette } from '../theme/colors';
export default function OddEvenBar({ odd, even }) {
    const total = odd + even || 1;
    const oddPct = (odd / total) * 100;
    const evenPct = (even / total) * 100;
    return (_jsxs(Box, { children: [_jsxs(Box, { sx: { display: 'flex', justifyContent: 'space-between', mb: 1 }, children: [_jsxs(Typography, { variant: "body2", color: "text.secondary", children: ["\uD640\uC218 ", odd, "\uAC1C"] }), _jsxs(Typography, { variant: "body2", color: "text.secondary", children: ["\uC9DD\uC218 ", even, "\uAC1C"] })] }), _jsxs(Box, { sx: {
                    display: 'flex',
                    height: 28,
                    borderRadius: 14,
                    overflow: 'hidden',
                    bgcolor: palette.surfaceAlt,
                }, children: [_jsx(Box, { sx: {
                            flex: oddPct,
                            bgcolor: palette.odd,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            minWidth: oddPct > 0 ? 24 : 0,
                        }, children: oddPct >= 15 && (_jsxs(Typography, { variant: "caption", sx: { color: '#fff', fontWeight: 700 }, children: [Math.round(oddPct), "%"] })) }), _jsx(Box, { sx: {
                            flex: evenPct,
                            bgcolor: palette.even,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            minWidth: evenPct > 0 ? 24 : 0,
                        }, children: evenPct >= 15 && (_jsxs(Typography, { variant: "caption", sx: { color: '#fff', fontWeight: 700 }, children: [Math.round(evenPct), "%"] })) })] })] }));
}
