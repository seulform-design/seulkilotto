import { Box, Typography } from '@mui/material';
import { getBallColor } from '../theme/colors';

interface LottoBallProps {
  number: number;
  size?: number;
}

export default function LottoBall({ number, size = 44 }: LottoBallProps) {
  const bg = getBallColor(number);
  const isLight = number <= 10 || number > 40;
  const textColor = isLight ? '#2A2A2A' : '#FFFFFF';

  return (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: '50%',
        bgcolor: bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 2px 6px rgba(0,0,0,0.35)',
        flexShrink: 0,
      }}
    >
      <Typography sx={{ color: textColor, fontWeight: 700, fontSize: size * 0.4 }}>
        {number}
      </Typography>
    </Box>
  );
}
