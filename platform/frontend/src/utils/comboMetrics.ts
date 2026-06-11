/**
 * 조합 메트릭 — 클라이언트 사이드 순수 함수.
 *
 * 백엔드 EPO 의 backend/app/epo/filters.py 와 동일 로직을 TypeScript 로
 * 재구현하여, 임의 GenerateResponse 의 combination 에 대해서도
 * 동일한 메트릭을 노출할 수 있게 한다.
 */

export const HIGH_THRESHOLD = 23;

export function sumTotal(nums: number[]): number {
  let s = 0;
  for (const n of nums) s += n;
  return s;
}

export function oddCount(nums: number[]): number {
  let c = 0;
  for (const n of nums) if (n % 2 === 1) c += 1;
  return c;
}

export function evenCount(nums: number[]): number {
  return nums.length - oddCount(nums);
}

export function highCount(nums: number[], threshold = HIGH_THRESHOLD): number {
  let c = 0;
  for (const n of nums) if (n >= threshold) c += 1;
  return c;
}

export function lowCount(nums: number[], threshold = HIGH_THRESHOLD): number {
  return nums.length - highCount(nums, threshold);
}

export function maxConsecutiveRun(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  let longest = 1;
  let current = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] - sorted[i - 1] === 1) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 1;
    }
  }
  return longest;
}

export function consecutivePairs(nums: number[]): number[][] {
  const sorted = [...nums].sort((a, b) => a - b);
  const pairs: number[][] = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    if (sorted[i + 1] - sorted[i] === 1) pairs.push([sorted[i], sorted[i + 1]]);
  }
  return pairs;
}

/**
 * Arithmetic Complexity (AC 값).
 * AC = (조합 내 모든 쌍의 양의 차이값 종류 수) - (k - 1), k = 6.
 * 최대값 = C(6,2) - 5 = 10. 역사적 1등 조합의 90% 이상이 AC >= 7.
 */
export function acValue(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const diffs = new Set<number>();
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      diffs.add(sorted[j] - sorted[i]);
    }
  }
  return diffs.size - (sorted.length - 1);
}

/** 십의자리 그룹별 개수. 키: 0(1~9), 1(10~19), 2(20~29), 3(30~39), 4(40~45). */
export function decadeBuckets(nums: number[]): Record<number, number> {
  const buckets: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const n of nums) {
    const idx = Math.min(Math.floor(n / 10), 4);
    buckets[idx] = (buckets[idx] ?? 0) + 1;
  }
  return buckets;
}

export function maxSameDecade(nums: number[]): number {
  const b = decadeBuckets(nums);
  return Math.max(b[0], b[1], b[2], b[3], b[4]);
}

export function lastDigitUnique(nums: number[]): number {
  const s = new Set<number>();
  for (const n of nums) s.add(n % 10);
  return s.size;
}

/**
 * 합계 구간 라벨링.
 * - low:   < 100 (한국 로또 1등 합계 p10 미만)
 * - mid:   100 ~ 175 (p10 ~ p90)
 * - high:  > 175
 */
export type SumBand = 'low' | 'mid' | 'high';

export function sumBand(sum: number): SumBand {
  if (sum < 100) return 'low';
  if (sum > 175) return 'high';
  return 'mid';
}
