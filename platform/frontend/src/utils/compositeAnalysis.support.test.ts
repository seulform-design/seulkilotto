/**
 * 양쪽 지지(고정수 제외) — extractPhotoExpectedNumbers 스모크.
 * 실행: npx tsx src/utils/compositeAnalysis.support.test.ts
 */
import { detectFixedSemiNumbers, extractPhotoExpectedNumbers } from './compositeAnalysis';
import type { PhotoAnalysisAccumulated } from '../api/v1Api';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// 반자동 12줄: 고정수 7이 100% 반복
const semi = Array.from({ length: 12 }, (_, i) => [7, i + 1, i + 2, i + 3, i + 4, i + 5]);
const auto = [
  ...Array.from({ length: 6 }, () => [7, 20, 21, 22, 23, 24]),
  ...Array.from({ length: 6 }, () => [10, 11, 12, 13, 14, 15]),
];

const fixed = detectFixedSemiNumbers(semi);
assert(fixed.has(7), '고정수 7 감지');
assert(detectFixedSemiNumbers(semi.slice(0, 5)).size === 0, '표본 부족 시 미감지');

const photo = {
  by_intent: {
    current_round: {
      saved_auto_lines: auto,
      saved_semi_lines: semi,
    },
  },
} as unknown as PhotoAnalysisAccumulated;

const ranked = extractPhotoExpectedNumbers(photo, 'current_round');
assert(ranked.every((r) => r.number !== 7), '고정수 7은 예상번호에서 제외');
assert(ranked.some((r) => r.number === 10), '양쪽 지지 번호(10)는 포함');
assert(ranked[0].support > 0, '1위는 양쪽 지지 > 0');
assert(ranked.length <= 24, '기본 최대 top-24(확장망)');

const ranked18 = extractPhotoExpectedNumbers(photo, 'current_round', 18);
assert(ranked18.length <= 18, '명시 topN=18 존중');

console.log('compositeAnalysis.support.test.ts OK', {
  fixed: [...fixed],
  top: ranked.slice(0, 6).map((r) => `${r.number}(s${r.support})`),
});
