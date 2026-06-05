/**
 * 백엔드 미연결 시 대시보드용 로컬 분석 폴백 (표준 로직만, fetch 불필요).
 */
import type { CombinationAnalysis } from './client';

export function localAnalyzeCombination(numbers: number[]): CombinationAnalysis {
  const nums = [...numbers].sort((a, b) => a - b);
  const odd_count = nums.filter((n) => n % 2 === 1).length;
  const even_count = 6 - odd_count;
  const sum_total = nums.reduce((a, b) => a + b, 0);
  let sum_band = '보통';
  if (sum_total < 100) sum_band = '낮음';
  else if (sum_total > 170) sum_band = '높음';

  const consecutive_pairs: number[][] = [];
  for (let i = 0; i < nums.length - 1; i += 1) {
    if (nums[i + 1] - nums[i] === 1) {
      consecutive_pairs.push([nums[i], nums[i + 1]]);
    }
  }

  return {
    numbers: nums,
    odd_count,
    even_count,
    sum_total,
    sum_band,
    has_consecutive: consecutive_pairs.length > 0,
    consecutive_pairs,
  };
}
