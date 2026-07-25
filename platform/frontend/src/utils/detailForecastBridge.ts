/**
 * 용지분석 [상세 분석 모두 보기]에서 산출된 예상번호를
 * 종합분석 1호기 물리/학습 추첨기로 넘기는 브리지.
 *
 * SemiAutoComparePanel 이 계산한 종합예측·당첨예상·핵심추천을 localStorage 에
 * 스냅샷으로 남겨, 종합분석이 동일 순위로 favor/가중 추첨에 쓰게 한다.
 *
 * 복기 검증 진단: top-6 집중 픽은 구조적으로 실패하고 top-18 커버리지가 당첨을
 * 잡으므로, 추첨 풀(ranked)은 expand18(넓은 그물)을 우선한다.
 */

export type DetailForecastSource =
  | 'forecast' // 이번회차 종합 예측 (용지교차+통합+평행)
  | 'predicted' // 당첨 예상번호 (전수비교 심층 역산)
  | 'hero' // 핵심 추천 확장18 (커버리지)
  | 'lines' // 줄 빈도 폴백
  | 'merged'; // 종합분석 측 재합성 폴백

export interface DetailForecastNumber {
  number: number;
  rank: number;
  confidence: number;
  sources?: string[];
}

export interface DetailForecastSnapshot {
  version: 1;
  intent: 'current_round' | 'review';
  round: number | null;
  savedAt: string;
  /** 추첨기 favor·풀에 쓰는 순위 리스트 (앞쪽이 강함, 보통 top-18 커버리지) */
  ranked: DetailForecastNumber[];
  core6: number[];
  expand18: number[];
  representative: number[];
  primarySource: DetailForecastSource;
}

const STORAGE_KEY = 'lotto:detailForecast:v1';

function cleanNums(arr: number[] | undefined | null): number[] {
  return Array.from(
    new Set((arr ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= 45)),
  );
}

export function saveDetailForecast(snapshot: DetailForecastSnapshot): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* quota / private mode */
  }
}

export function loadDetailForecast(
  intent: 'current_round' | 'review' = 'current_round',
  maxAgeMs = 1000 * 60 * 60 * 24 * 14,
): DetailForecastSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DetailForecastSnapshot;
    if (!parsed || parsed.version !== 1) return null;
    if (parsed.intent !== intent) return null;
    if (!Array.isArray(parsed.ranked) || parsed.ranked.length < 6) return null;
    const age = Date.now() - new Date(parsed.savedAt).getTime();
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearDetailForecast(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** SemiAutoComparePanel → 브리지 스냅샷 빌드 */
export function buildDetailForecastSnapshot(input: {
  intent: 'current_round' | 'review';
  round: number | null;
  forecastRanked?: { number: number; pct?: number; sources?: string[] }[] | null;
  predictedRanked?: { number: number; confidence?: number; sources?: string[] }[] | null;
  core6?: number[] | null;
  expand18?: number[] | null;
  representative?: number[] | null;
}): DetailForecastSnapshot | null {
  const forecast = (input.forecastRanked ?? [])
    .filter((r) => Number.isInteger(r.number) && r.number >= 1 && r.number <= 45)
    .slice(0, 18);
  const predicted = (input.predictedRanked ?? [])
    .filter((r) => Number.isInteger(r.number) && r.number >= 1 && r.number <= 45)
    .slice(0, 18);
  const expand18 = cleanNums(input.expand18).slice(0, 18);
  const core6 = cleanNums(input.core6).slice(0, 6);
  const representative = cleanNums(input.representative).slice(0, 6);

  // 상세분석 순위 점수 — expand18 내부 정렬용(고지지 집중이 아닌 상대 순서만)
  const scoreOf = new Map<number, number>();
  forecast.forEach((r, i) => scoreOf.set(r.number, 2000 - i));
  predicted.forEach((r, i) => {
    if (!scoreOf.has(r.number)) scoreOf.set(r.number, 1000 - i);
  });

  let primarySource: DetailForecastSource = 'forecast';
  let ranked: DetailForecastNumber[] = [];

  // ① 넓은 그물(expand18) 우선 — 복기 검증상 top-18 커버리지만 당첨을 대부분 잡음
  if (expand18.length >= 6) {
    primarySource = 'hero';
    const ordered = [...expand18].sort(
      (a, b) => (scoreOf.get(b) ?? 0) - (scoreOf.get(a) ?? 0) || a - b,
    );
    ranked = ordered.map((n, i) => ({
      number: n,
      rank: i + 1,
      confidence: Math.round(((ordered.length - i) / ordered.length) * 100),
      sources: forecast.find((r) => r.number === n)?.sources
        ?? predicted.find((r) => r.number === n)?.sources,
    }));
  } else if (forecast.length >= 6) {
    primarySource = 'forecast';
    ranked = forecast.map((r, i) => ({
      number: r.number,
      rank: i + 1,
      confidence: Math.max(1, Math.min(100, r.pct ?? Math.round(((forecast.length - i) / forecast.length) * 100))),
      sources: r.sources,
    }));
  } else if (predicted.length >= 6) {
    primarySource = 'predicted';
    ranked = predicted.map((r, i) => ({
      number: r.number,
      rank: i + 1,
      confidence: Math.max(1, Math.min(100, r.confidence ?? Math.round(((predicted.length - i) / predicted.length) * 100))),
      sources: r.sources,
    }));
  } else {
    return null;
  }

  return {
    version: 1,
    intent: input.intent,
    round: input.round,
    savedAt: new Date().toISOString(),
    ranked,
    core6: core6.length >= 6 ? core6 : ranked.slice(0, 6).map((r) => r.number).sort((a, b) => a - b),
    expand18: expand18.length >= 6 ? expand18 : ranked.map((r) => r.number).slice(0, 18),
    representative:
      representative.length >= 6
        ? representative
        : ranked
            .slice(0, 6)
            .map((r) => r.number)
            .sort((a, b) => a - b),
    primarySource,
  };
}
