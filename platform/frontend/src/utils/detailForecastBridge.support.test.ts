/**
 * detailForecastBridge intent 슬롯 분리 스모크.
 * 실행: npx tsx src/utils/detailForecastBridge.support.test.ts
 */
export {};

const mem: Record<string, string> = {};
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => {
      mem[k] = v;
    },
    removeItem: (k: string) => {
      delete mem[k];
    },
  },
};

const {
  buildDetailForecastSnapshot,
  clearDetailForecast,
  loadDetailForecast,
  saveDetailForecast,
} = await import('./detailForecastBridge');

const expand18 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

const review = buildDetailForecastSnapshot({
  intent: 'review',
  round: 1234,
  expand18,
  core6: [1, 2, 3, 4, 5, 6],
});
const current = buildDetailForecastSnapshot({
  intent: 'current_round',
  round: 1235,
  expand18: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  core6: [2, 3, 4, 5, 6, 7],
});

if (!review || !current) throw new Error('snapshot build failed');

clearDetailForecast();
saveDetailForecast(review);
saveDetailForecast(current);

const loadedReview = loadDetailForecast('review');
const loadedCurrent = loadDetailForecast('current_round');

if (!loadedReview || loadedReview.round !== 1234) throw new Error('review slot broken');
if (!loadedCurrent || loadedCurrent.round !== 1235) throw new Error('current slot broken');

clearDetailForecast('review');
if (loadDetailForecast('review')) throw new Error('clear review failed');
if (!loadDetailForecast('current_round')) throw new Error('current should remain');

clearDetailForecast();
console.log('detailForecastBridge.support.test.ts OK');
