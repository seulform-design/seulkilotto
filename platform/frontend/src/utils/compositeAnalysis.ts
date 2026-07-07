/**
 * 종합 분석 (Composite Analysis) — 3개 독립 신호의 교집합 산출.
 *
 * 신호 (출처):
 *   1. 추첨기 분석 (machine) → RoundRecommendResponse.stats.hot_top5
 *   2. 후속 출현 통계 (post) → PostOccurrenceResponse.grades.S 또는 top20_numbers
 *   3. 용지 분석 누적 (photo) → PhotoAnalysisAccumulated.final_predictions
 *
 * 등급 (per-number):
 *   S = 3개 신호 모두 favor       (최대 합의)
 *   A = 2개 신호 favor
 *   B = 1개 신호 favor
 *   C = 어떤 신호도 안 함         (중립)
 *   X = 어느 신호든 excluded      (배제)
 *
 * 정직성 선언:
 *   본 모듈은 어떤 번호의 다음 회차 출현 확률도 변경하지 않는다.
 *   모든 6-튜플은 균등 무작위와 동일한 1/8,145,060 의 확률을 가지며,
 *   합의 신호는 사용자의 '관심 집중점' 시각화 도구에 불과하다.
 */

import {
  acValue,
  maxConsecutiveRun,
  oddCount,
  sumTotal,
} from './comboMetrics';
import type {
  ParallelRoundAnalysisResponse,
  PhotoAnalysisAccumulated,
  RoundRecommendResponse,
  TemperatureResponse,
} from '../api/v1Api';

export type ConsensusGrade = 'S' | 'A' | 'B' | 'C' | 'X';

export interface ConsensusNumber {
  number: number;
  /** 우호적인 신호 수 (0~3) */
  score: number;
  /** 어떤 신호든 명시적으로 배제했나 */
  excluded: boolean;
  /** 우호 신호 ID 목록 */
  sources: string[];
  /** 배제 신호 ID 목록 */
  excludedBy: string[];
  grade: ConsensusGrade;
}

export interface SourceAvailability {
  /** 용지 1:1 자동↔반자동 전수비교 (강한 후보) */
  oneToOne: boolean;
  /** 평행회차 강수/기대수 */
  parallel: boolean;
  /** 미출수(gap) 강수/기대수 */
  missing: boolean;
  /** 추첨 엔진(1호기) — 등급 패밀리엔 미포함, 시뮬레이터 가중용 */
  machine: boolean;
}

export interface CompositeAnalysisResult {
  perNumber: Record<number, ConsensusNumber>;
  sourcesAvailable: SourceAvailability;
  sourceCount: number;
  /** score 내림차순 정렬, excluded 제외 */
  topNumbers: ConsensusNumber[];
  /** 등급별 번호 그룹 (S, A, B, C, X 각각) */
  byGrade: Record<ConsensusGrade, number[]>;
  /** EPO 필터 통과 + 합의 가중치 적용된 5게임 */
  recommendedSets: number[][];
}

const SOURCE_IDS = {
  oneToOne: 'photo-1to1',
  parallelStrong: 'parallel-strong',
  parallelExpected: 'parallel-expected',
  missingStrong: 'missing-strong',
  missingExpected: 'missing-expected',
  photoExcluded: 'photo-excluded',
} as const;

const PHOTO_TOP_COUNT = 10;

function emptyConsensus(): Record<number, ConsensusNumber> {
  const out: Record<number, ConsensusNumber> = {};
  for (let n = 1; n <= 45; n += 1) {
    out[n] = {
      number: n,
      score: 0,
      excluded: false,
      sources: [],
      excludedBy: [],
      grade: 'C',
    };
  }
  return out;
}

// 소스 ID → 분석 '패밀리'. score 는 sourceId 개수가 아니라 '서로 다른 분석 패밀리'
// 개수여야 한다(클래식 wilson+blend 가 한 번호를 2표로 부풀리던 버그 방지).
const FAMILY_OF: Record<string, string> = {
  [SOURCE_IDS.oneToOne]: 'oneToOne',
  [SOURCE_IDS.parallelStrong]: 'parallel',
  [SOURCE_IDS.parallelExpected]: 'parallel',
  [SOURCE_IDS.missingStrong]: 'missing',
  [SOURCE_IDS.missingExpected]: 'missing',
};

function addSignal(item: ConsensusNumber, sourceId: string): void {
  if (!item.sources.includes(sourceId)) {
    item.sources.push(sourceId);
    // score 는 아래에서 패밀리 기준으로 재계산 — 여기선 소스만 기록.
  }
}

function markExcluded(item: ConsensusNumber, sourceId: string): void {
  if (!item.excludedBy.includes(sourceId)) {
    item.excludedBy.push(sourceId);
    item.excluded = true;
  }
}

function assignGrade(item: ConsensusNumber): void {
  if (item.excluded) {
    item.grade = 'X';
  } else if (item.score >= 3) {
    item.grade = 'S';
  } else if (item.score >= 2) {
    item.grade = 'A';
  } else if (item.score >= 1) {
    item.grade = 'B';
  } else {
    item.grade = 'C';
  }
}

/** Fisher-Yates 셔플 (비순수 — Math.random 사용. seed 통제 필요 시 외부에서). */
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 통계적으로 1등 조합에서 거의 안 나오는 패턴 배제. */
function passesBasicFilters(combo: number[]): boolean {
  const sum = sumTotal(combo);
  if (sum < 90 || sum > 195) return false; // p5~p95 보수적 구간
  const oc = oddCount(combo);
  if (oc === 0 || oc === 6) return false; // 0:6, 6:0 차단
  if (maxConsecutiveRun(combo) >= 4) return false; // 4연속 차단
  if (acValue(combo) < 5) return false; // 등차수열 류 차단
  return true;
}

/**
 * 합의 기반 5게임 생성.
 *
 * 알고리즘:
 *   1. S, A 등급에서 우선 추출 (각 게임당 최대 4개)
 *   2. B 등급에서 나머지 채움
 *   3. C 등급은 마지막 폴백 (S+A+B 부족 시)
 *   4. X (excluded) 는 절대 사용 금지
 *   5. 합/AC/연속/홀짝 필터 통과해야 채택
 *   6. 게임 간 중복 금지
 */
function generateConsensusSets(
  byGrade: Record<ConsensusGrade, number[]>,
  targetCount = 5,
  maxAttempts = 2000
): number[][] {
  const pool: number[] = [];
  const sets: number[][] = [];
  const seen = new Set<string>();
  let attempts = 0;

  while (sets.length < targetCount && attempts < maxAttempts) {
    attempts += 1;
    const set = new Set<number>();

    // 1) S → 최대 4개
    for (const n of shuffle(byGrade.S)) {
      if (set.size >= 4) break;
      set.add(n);
    }
    // 2) A → 최대 5개까지
    for (const n of shuffle(byGrade.A)) {
      if (set.size >= 5) break;
      set.add(n);
    }
    // 3) B → 최대 6개까지
    for (const n of shuffle(byGrade.B)) {
      if (set.size >= 6) break;
      set.add(n);
    }
    // 4) 부족하면 C 폴백
    if (set.size < 6) {
      for (const n of shuffle(byGrade.C)) {
        if (set.size >= 6) break;
        set.add(n);
      }
    }
    if (set.size < 6) continue;

    const arr = [...set].sort((a, b) => a - b);
    if (!passesBasicFilters(arr)) continue;

    const key = arr.join('-');
    if (seen.has(key)) continue;
    seen.add(key);
    sets.push(arr);
  }

  // pool 사용 안 함 — 변수 자체는 미래 확장 위해 보존
  void pool;
  return sets;
}

export function buildComposite(
  machine: RoundRecommendResponse | null | undefined,
  parallel: ParallelRoundAnalysisResponse | null | undefined,
  temperature: TemperatureResponse | null | undefined,
  photo: PhotoAnalysisAccumulated | null | undefined,
  photoIntent: 'review' | 'current_round' = 'current_round'
): CompositeAnalysisResult {
  const perNumber = emptyConsensus();

  const sourcesAvailable: SourceAvailability = {
    oneToOne: false, // 아래 photoStrong 유무로 확정
    parallel: !!parallel && !parallel.error && (parallel.parallel_strong?.length ?? 0) > 0,
    missing: !!temperature && (temperature.items?.length ?? 0) > 0,
    machine: !!machine, // 추첨 엔진(1호기) — 등급 패밀리엔 미포함, 시뮬레이터용.
  };

  // ── 1) 평행회차 강수/기대수 ──────────────────────────────────
  if (parallel && !parallel.error) {
    (parallel.parallel_strong ?? []).slice(0, 8).forEach((number) => {
      const item = perNumber[number];
      if (item) addSignal(item, SOURCE_IDS.parallelStrong);
    });
    (parallel.parallel_expected ?? []).slice(0, 8).forEach((number) => {
      const item = perNumber[number];
      if (item) addSignal(item, SOURCE_IDS.parallelExpected);
    });
  }

  // ── 2) 미출수 강수/기대수 — gap(미출현 회차) 큰 순. tier cold/frozen 우선 ──
  if (temperature?.items?.length) {
    const byGap = [...temperature.items].sort((a, b) => b.gap - a.gap || a.number - b.number);
    byGap.slice(0, 6).forEach(({ number }) => {
      const item = perNumber[number];
      if (item) addSignal(item, SOURCE_IDS.missingStrong);
    });
    byGap.slice(6, 12).forEach(({ number }) => {
      const item = perNumber[number];
      if (item) addSignal(item, SOURCE_IDS.missingExpected);
    });
  }

  // ── 3) 용지 1:1 자동↔반자동 전수비교 (강한 후보) — intent 슬라이스 우선 ──
  const photoStrong =
    photo?.by_intent?.[photoIntent]?.final_predictions?.strong_candidates ??
    photo?.by_intent?.[photoIntent]?.accumulated_combo_patterns?.strong_candidates ??
    photo?.final_predictions?.strong_candidates ??
    [];
  const photoExcluded =
    photo?.by_intent?.[photoIntent]?.final_predictions?.excluded_candidates ??
    photo?.final_predictions?.excluded_candidates ??
    [];

  if (photoStrong.length) {
    sourcesAvailable.oneToOne = true;
    photoStrong.slice(0, PHOTO_TOP_COUNT).forEach((number) => {
      const item = perNumber[number];
      if (item) addSignal(item, SOURCE_IDS.oneToOne);
    });
  }

  if (photoExcluded.length) {
    photoExcluded.forEach((number) => {
      const item = perNumber[number];
      if (item) markExcluded(item, SOURCE_IDS.photoExcluded);
    });
  }

  // score = 서로 다른 분석 패밀리(oneToOne/parallel/missing) 개수 — 최대 3.
  for (let n = 1; n <= 45; n += 1) {
    const item = perNumber[n];
    item.score = new Set(item.sources.map((s) => FAMILY_OF[s] ?? s)).size;
  }
  // 등급 산정 패밀리 = 3개(용지1:1·평행·미출). 추첨 엔진(machine)은 별도.
  const sourceCount = [sourcesAvailable.oneToOne, sourcesAvailable.parallel, sourcesAvailable.missing].filter(Boolean).length;

  // 등급 부여
  for (let n = 1; n <= 45; n += 1) {
    assignGrade(perNumber[n]);
  }

  // 정렬 및 그룹화
  const allItems = Object.values(perNumber);
  const topNumbers = [...allItems]
    .filter((it) => !it.excluded)
    .sort((a, b) => b.score - a.score || a.number - b.number);

  const byGrade: Record<ConsensusGrade, number[]> = {
    S: allItems.filter((it) => it.grade === 'S').map((it) => it.number),
    A: allItems.filter((it) => it.grade === 'A').map((it) => it.number),
    B: allItems.filter((it) => it.grade === 'B').map((it) => it.number),
    C: allItems.filter((it) => it.grade === 'C').map((it) => it.number),
    X: allItems.filter((it) => it.grade === 'X').map((it) => it.number),
  };

  // 5게임 생성
  const recommendedSets = generateConsensusSets(byGrade);

  return {
    perNumber,
    sourcesAvailable,
    sourceCount,
    topNumbers,
    byGrade,
    recommendedSets,
  };
}

export const GRADE_COLORS: Record<ConsensusGrade, string> = {
  S: '#FF4D4D', // 빨강 — 가장 강한 합의
  A: '#FFA94D', // 주황 — 2개 신호
  B: '#69C8F2', // 파랑 — 1개 신호
  C: '#4F555E', // 회색 어둠 — 신호 없음
  X: '#7B61FF', // 보라 — 배제
};

export const GRADE_LABELS: Record<ConsensusGrade, string> = {
  S: 'S · 3+ 소스 합의',
  A: 'A · 2개 소스 합의',
  B: 'B · 1개 소스',
  C: 'C · 신호 없음',
  X: 'X · 배제 (용지)',
};

// ══════════════════════════════════════════════════════════════════
// 🎰 추첨기 시뮬레이터 — 용지분석(이번회차)을 학습한 가중 추첨.
// 실제 로또기는 모든 공이 균등하지만, 이 '학습 추첨기'는 종합분석 합의 등급 +
// 예상 호기(추첨일) 고빈도를 공 무게로 반영해 몬테카를로로 6개를 뽑는다. 수천 회
// 시뮬레이션의 등장 빈도가 예측 분포다. (정직성: 이건 관찰·가중 시뮬이며 실제
// 당첨 확률 1/8,145,060 을 바꾸지 않는다.)
// ══════════════════════════════════════════════════════════════════
export interface DrawMachineNumber {
  number: number;
  count: number;
  pct: number;
  lift: number;
  grade: ConsensusGrade;
}
export interface DrawMachineResult {
  drawDate: string | null;
  machineId: number | null;
  machineSource: string | null;
  nextRound: number | null;
  iterations: number;
  ranked: DrawMachineNumber[];
  representative: number[];
  samples: number[][];
}

function weightedDrawWithoutReplacement(weight: number[], pick: number, rand: () => number): number[] {
  // weight: index 1..45. 누적합 룰렛으로 비복원 6개 추출.
  const pool: number[] = [];
  const w: number[] = [];
  for (let n = 1; n <= 45; n += 1) {
    pool.push(n);
    w.push(Math.max(0.0001, weight[n] ?? 1));
  }
  const out: number[] = [];
  for (let k = 0; k < pick && pool.length > 0; k += 1) {
    let total = 0;
    for (const x of w) total += x;
    let r = rand() * total;
    let idx = 0;
    for (let i = 0; i < w.length; i += 1) {
      r -= w[i];
      if (r <= 0) { idx = i; break; }
      idx = i;
    }
    out.push(pool[idx]);
    pool.splice(idx, 1);
    w.splice(idx, 1);
  }
  return out;
}

function passesBasicDraw(nums: number[]): boolean {
  if (nums.length !== 6) return false;
  const s = sumTotal(nums);
  if (s < 90 || s > 195) return false;
  const odd = oddCount(nums);
  if (odd === 0 || odd === 6) return false;
  if (maxConsecutiveRun(nums) >= 4) return false;
  if (acValue(nums) < 5) return false;
  return true;
}

export function simulateDrawMachine(
  composite: CompositeAnalysisResult,
  machine: RoundRecommendResponse | null,
  opts?: { iterations?: number; seed?: number },
): DrawMachineResult | null {
  if (!composite) return null;
  const iterations = opts?.iterations ?? 6000;
  // 시드 기반 PRNG(mulberry32) — 재현 가능. 버튼으로 seed 바꿔 다른 표본 추첨.
  let a = (opts?.seed ?? 1) >>> 0;
  const rand = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // 1호기 학습 추첨기 공 무게 — 세 축을 강수>기대 로 반영. 용지 1:1 최우선.
  const hot = new Set((machine?.stats?.hot_top5 ?? []).map((h) => h.number));
  const weight: number[] = new Array(46).fill(1);
  for (let n = 1; n <= 45; n += 1) {
    const item = composite.perNumber[n];
    const has = (id: string) => item.sources.includes(id);
    let wv = 1;
    if (has('photo-1to1')) wv += 3.5; // 용지 1:1 전수비교 (핵심)
    if (has('parallel-strong')) wv += 2.5;
    if (has('parallel-expected')) wv += 1.2;
    if (has('missing-strong')) wv += 2.0;
    if (has('missing-expected')) wv += 1.0;
    if (hot.has(n)) wv += 1.0; // 1호기 자체 고빈도(엔진 성향)
    if (item.excluded) wv = 0.2; // 용지 배제 — 거의 안 뽑힘
    weight[n] = wv;
  }
  const count = new Array(46).fill(0);
  const samples: number[][] = [];
  for (let it = 0; it < iterations; it += 1) {
    const drawn = weightedDrawWithoutReplacement(weight, 6, rand);
    for (const n of drawn) count[n] += 1;
    if (samples.length < 5 && passesBasicDraw(drawn)) samples.push([...drawn].sort((x, y) => x - y));
  }
  const baseline = (iterations * 6) / 45;
  const ranked: DrawMachineNumber[] = [];
  for (let n = 1; n <= 45; n += 1) {
    ranked.push({
      number: n,
      count: count[n],
      pct: Math.round((count[n] / iterations) * 1000) / 10,
      lift: baseline > 0 ? Math.round((count[n] / baseline) * 100) / 100 : 0,
      grade: composite.perNumber[n].grade,
    });
  }
  ranked.sort((x, y) => y.count - x.count || x.number - y.number);
  // 대표 조합 — 상위 빈도에서 구간(10단위) 최대 2개 균형으로 6개, 기본 필터 통과 우선.
  const rep: number[] = [];
  const dec: Record<number, number> = {};
  for (const r of ranked) {
    if (rep.length >= 6) break;
    const d = Math.min(4, Math.floor((r.number - 1) / 10));
    if ((dec[d] ?? 0) >= 2) continue;
    rep.push(r.number);
    dec[d] = (dec[d] ?? 0) + 1;
  }
  for (const r of ranked) {
    if (rep.length >= 6) break;
    if (!rep.includes(r.number)) rep.push(r.number);
  }
  rep.sort((x, y) => x - y);
  return {
    drawDate: machine?.next_draw_date ?? null,
    machineId: machine?.machine_id ?? null,
    machineSource: machine?.machine_source ?? null,
    nextRound: machine?.next_round ?? null,
    iterations,
    ranked,
    representative: rep,
    samples,
  };
}

export const SOURCE_LABELS: Record<string, string> = {
  [SOURCE_IDS.oneToOne]: '용지 1:1 전수비교',
  [SOURCE_IDS.parallelStrong]: '평행 강수',
  [SOURCE_IDS.parallelExpected]: '평행 기대',
  [SOURCE_IDS.missingStrong]: '미출 강수',
  [SOURCE_IDS.missingExpected]: '미출 기대',
  [SOURCE_IDS.photoExcluded]: '용지 배제',
};
