import { Box, Typography } from '@mui/material';
import { palette } from '../theme/colors';

interface OddEvenBarProps {
  odd: number;
  even: number;
}

export default function OddEvenBar({ odd, even }: OddEvenBarProps) {
  const total = odd + even || 1;
  const oddPct = (odd / total) * 100;
  const evenPct = (even / total) * 100;

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="body2" color="text.secondary">
          홀수 {odd}개
        </Typography>
        <Typography variant="body2" color="text.secondary">
          짝수 {even}개
        </Typography>
      </Box>
      <Box
        sx={{
          display: 'flex',
          height: 28,
          borderRadius: 14,
          overflow: 'hidden',
          bgcolor: palette.surfaceAlt,
        }}
      >
        <Box
          sx={{
            flex: oddPct,
            bgcolor: palette.odd,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: oddPct > 0 ? 24 : 0,
          }}
        >
          {oddPct >= 15 && (
            <Typography variant="caption" sx={{ color: '#fff', fontWeight: 700 }}>
              {Math.round(oddPct)}%
            </Typography>
          )}
        </Box>
        <Box
          sx={{
            flex: evenPct,
            bgcolor: palette.even,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: evenPct > 0 ? 24 : 0,
          }}
        >
          {evenPct >= 15 && (
            <Typography variant="caption" sx={{ color: '#fff', fontWeight: 700 }}>
              {Math.round(evenPct)}%
            </Typography>
          )}
        </Box>
      </Box>
    </Box>
  );
}
