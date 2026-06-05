import { jsx as _jsx } from "react/jsx-runtime";
import { Box, Typography } from '@mui/material';
import { getBallColor } from '../theme/colors';
export default function LottoBall({ number, size = 44 }) {
    const bg = getBallColor(number);
    const isLight = number <= 10 || number > 40;
    const textColor = isLight ? '#2A2A2A' : '#FFFFFF';
    return (_jsx(Box, { sx: {
            width: size,
            height: size,
            borderRadius: '50%',
            bgcolor: bg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 2px 6px rgba(0,0,0,0.35)',
            flexShrink: 0,
        }, children: _jsx(Typography, { sx: { color: textColor, fontWeight: 700, fontSize: size * 0.4 }, children: number }) }));
}
