import { Box, Typography } from '@mui/material';
import { memo } from 'react';
import { getBallColor } from '../theme/colors';

interface LottoBallProps {
  number: number;
  size?: number;
  /** 복기 등 — 당첨번호가 아닐 때 회색 처리 */
  dimmed?: boolean;
  /** 입력 그리드 등 — 공식 볼 색 대신 무채색 표시 */
  neutral?: boolean;
}

/**
 * 로또 번호 공.
 *
 * 성능: 대시보드/패널/그리드에서 수십 회 렌더되므로 React.memo 적용.
 * props 가 모두 primitive(number/boolean) 라 얕은 비교로 충분.
 */
function LottoBallImpl({ number, size = 44, dimmed = false, neutral = false }: LottoBallProps) {
  // dimmed 는 공식 회색 — 1–10·41–45 공식색이 비당첨인데도 살아 보이던 착시 방지.
  const bg = dimmed
    ? (neutral ? '#353a42' : '#3a3f48')
    : neutral
      ? '#d7dde5'
      : getBallColor(number);
  const isLight = neutral ? !dimmed : (!dimmed && (number <= 10 || number > 40));
  const textColor = dimmed
    ? '#8b929b'
    : neutral
      ? '#1f2933'
      : isLight
        ? '#2A2A2A'
        : '#FFFFFF';
  const border = neutral && !dimmed ? '1px solid rgba(255,255,255,0.18)' : 'none';

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
        border,
        boxShadow: dimmed ? 'none' : '0 2px 6px rgba(0,0,0,0.35)',
        opacity: dimmed ? 0.55 : 1,
        filter: dimmed ? 'grayscale(1)' : 'none',
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
