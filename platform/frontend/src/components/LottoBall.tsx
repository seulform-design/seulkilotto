import { Box, Typography } from '@mui/material';
import { memo } from 'react';
import { getBallColor } from '../theme/colors';

interface LottoBallProps {
  number: number;
  size?: number;
  /** 복기 등 — 당첨번호가 아닐 때 회색 처리 */
  dimmed?: boolean;
}

/**
 * 로또 번호 공.
 *
 * 성능: 대시보드/패널/그리드에서 수십 회 렌더되므로 React.memo 적용.
 * props 가 모두 primitive(number/boolean) 라 얕은 비교로 충분.
 */
function LottoBallImpl({ number, size = 44, dimmed = false }: LottoBallProps) {
  const bg = dimmed ? '#4a4f57' : getBallColor(number);
  const isLight = dimmed || number <= 10 || number > 40;
  const textColor = dimmed ? '#9ba1a9' : isLight ? '#2A2A2A' : '#FFFFFF';

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
        boxShadow: dimmed ? '0 1px 3px rgba(0,0,0,0.25)' : '0 2px 6px rgba(0,0,0,0.35)',
        opacity: dimmed ? 0.72 : 1,
        flexShrink: 0,
      }}
    >
      <Typography sx={{ color: textColor, fontWeight: 700, fontSize: size * 0.4 }}>
        {number}
      </Typography>
    </Box>
  );
}

const LottoBall = memo(LottoBallImpl);
LottoBall.displayName = 'LottoBall';

export default LottoBall;
