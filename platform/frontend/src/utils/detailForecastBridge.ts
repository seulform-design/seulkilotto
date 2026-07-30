/**
 * 용지분석 [상세 분석] 산출 예상번호 → Venus/학습 추첨 브리지.
 *
 * intent별 localStorage 슬롯으로 복기·이번회차가 서로 덮어쓰지 않게 한다.
 * 복기 검증: expand18(넓은 그물) 우선.
 */

export type DetailForecastSource =
  | 'forecast'
  | 'predicted'
  | 'hero'
  | 'lines'
  | 'merged';

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
  ranked: DetailForecastNumber[];
  core6: number[];
  expand18: number[];
  representative: number[];
  primarySource: DetailForecastSource;
}

const LEGACY_STORAGE_KEY = 'lotto:detailForecast:v1';

function storageKey(intent: 'current_round' | 'review'): string {
  return `lotto:detailForecast:v1:${intent}`;
}

function cleanNums(arr: number[] | undefined | null): number[] {
  return Array.from(
    new Set((arr ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= 45)),
  );
}

export function saveDetailForecast(snapshot: DetailForecastSnapshot): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(snapshot.intent), JSON.stringify(snapshot));
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
    const raw =
      window.localStorage.getItem(storageKey(intent)) ??
      // 구버전 단일 키 마이그레이션
      (intent === 'current_round' ? window.localStorage.getItem(LEGACY_STORAGE_KEY) : null);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DetailForecastSnapshot;
    if (!parsed || parsed.version !== 1) return null;
    if (parsed.intent !== intent) return null;
    if (!Array.isArray(parsed.ranked) || parsed.ranked.length < 6) return null;
    const age = Date.now() - new Date(parsed.savedAt).getTime();
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
    // 레거시 키에서 읽었으면 intent 슬롯으로 승격
    if (!window.localStorage.getItem(storageKey(intent))) {
      window.localStorage.setItem(storageKey(intent), raw);
    }
    return parsed;
  } catch {
    return null;
  }
}

/** intent 생략 시 복기·이번회차·레거시 전부 삭제. */
export function clearDetailForecast(intent?: 'current_round' | 'review'): void {
  if (typeof window === 'undefined') return;
  try {
    if (intent) {
      window.localStorage.removeItem(storageKey(intent));
      return;
    }
    window.localStorage.removeItem(storageKey('current_round'));
    window.localStorage.removeItem(storageKey('review'));
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
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
    .slice(0, 24);
  const predicted = (input.predictedRanked ?? [])
    .filter((r) => Number.isInteger(r.number) && r.number >= 1 && r.number <= 45)
    .slice(0, 24);
  const expand18 = cleanNums(input.expand18).slice(0, 24);
  const core6 = cleanNums(input.core6).slice(0, 6);
  const representative = cleanNums(input.representative).slice(0, 6);

  const scoreOf = new Map<number, number>();
  forecast.forEach((r, i) => scoreOf.set(r.number, 2000 - i));
  predicted.forEach((r, i) => {
    if (!scoreOf.has(r.number)) scoreOf.set(r.number, 1000 - i);
  });

  let primarySource: DetailForecastSource = 'forecast';
  let ranked: DetailForecastNumber[] = [];

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
    expand18: expand18.length >= 6 ? expand18 : ranked.map((r) => r.number).slice(0, 24),
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
