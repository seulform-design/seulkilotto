export const palette = {
  background: '#121417',
  surface: '#1C1F24',
  surfaceAlt: '#262A30',
  border: '#33383F',
  textPrimary: '#FFFFFF',
  textSecondary: '#9BA1A9',
  point: {
    yellow: '#FBC400',
    blue: '#69C8F2',
    red: '#FF7272',
    gray: '#AAAAAA',
    green: '#B0D840',
  },
  odd: '#69C8F2',
  even: '#FF7272',
};

export function getBallColor(num: number): string {
  if (num <= 10) return palette.point.yellow;
  if (num <= 20) return palette.point.blue;
  if (num <= 30) return palette.point.red;
  if (num <= 40) return palette.point.gray;
  return palette.point.green;
}
