/**
 * 앱 전역 디자인 토큰 (다크 그레이 & 화이트 미니멀 톤).
 *
 * 컨셉: 배경/카드/텍스트는 무채색(그레이/화이트)으로 절제하고,
 *       로또 볼과 통계 차트에만 포인트 컬러를 사용해 시인성을 극대화한다.
 */

export const palette = {
  // --- 무채색 베이스 (다크 그레이 & 화이트) ---
  background: '#121417', // 앱 전체 배경 (딥 다크 그레이)
  surface: '#1C1F24', // 카드/패널 배경
  surfaceAlt: '#262A30', // 보조 패널/입력 배경
  border: '#33383F', // 구분선/테두리
  textPrimary: '#FFFFFF', // 주요 텍스트 (화이트)
  textSecondary: '#9BA1A9', // 보조 텍스트 (라이트 그레이)

  // --- 포인트 컬러 (볼/차트 전용) ---
  point: {
    yellow: '#FBC400', // 1~10
    blue: '#69C8F2', // 11~20
    red: '#FF7272', // 21~30
    gray: '#AAAAAA', // 31~40
    green: '#B0D840', // 41~45
  },

  // 홀짝 바 그래프용
  odd: '#69C8F2', // 홀수 (파랑)
  even: '#FF7272', // 짝수 (빨강)
};

/**
 * 한국 로또 공식 규칙에 따라 번호 → 볼 색상을 매핑한다.
 *  1~10: 노랑 / 11~20: 파랑 / 21~30: 빨강 / 31~40: 그레이 / 41~45: 초록
 */
export function getBallColor(num: number): string {
  if (num <= 10) return palette.point.yellow;
  if (num <= 20) return palette.point.blue;
  if (num <= 30) return palette.point.red;
  if (num <= 40) return palette.point.gray;
  return palette.point.green;
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};
