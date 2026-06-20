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
  ClassicRecommendResponse,
  PhotoAnalysisAccumulated,
  PostOccurrenceResponse,
  RoundRecommendResponse,
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
  machine: boolean;
  post: boolean;
  classic: boolean;
  photo: boolean;
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
  machineHot: 'machine-hot',
  postS: 'post-S',
  postTop10: 'post-top10',
  classicWilson: 'classic-wilson',
  classicBlend: 'classic-blend',
  photoStrong: 'photo-strong',
  photoExcluded: 'photo-excluded',
} as const;

const MACHINE_TOP_COUNT = 5;
const POST_TOP_COUNT = 10;
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

function addSignal(item: ConsensusNumber, sourceId: string): void {
  if (!item.sources.includes(sourceId)) {
    item.sources.push(sourceId);
    item.score += 1;
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
  post: PostOccurrenceResponse | null | undefined,
  photo: PhotoAnalysisAccumulated | null | undefined,
  classic?: ClassicRecommendResponse | null,
  photoIntent: 'review' | 'current_round' = 'current_round'
): CompositeAnalysisResult {
  const perNumber = emptyConsensus();

  const sourcesAvailable: SourceAvailability = {
    machine: !!machine,
    post: !!post,
    classic: !!classic,
    photo: !!photo,
  };
  const sourceCount = (Object.values(sourcesAvailable) as boolean[]).filter(Boolean).length;

  // ── 1) 추첨기 hot_top5 → favor ────────────────────────────────
  if (machine?.stats?.hot_top5?.length) {
    machine.stats.hot_top5.slice(0, MACHINE_TOP_COUNT).forEach(({ number }) => {
      const item = perNumber[number];
      if (item) addSignal(item, SOURCE_IDS.machineHot);
    });
  }

  // ── 2) 후속 출현 grades.S 우선, 없으면 top20_numbers top 10 ──
  if (post?.grades?.S?.length) {
    post.grades.S.forEach((number) => {
      const item = perNumber[number];
      if (item) addSignal(item, SOURCE_IDS.postS);
    });
  } else if (post?.top20_numbers?.length) {
    post.top20_numbers.slice(0, POST_TOP_COUNT).forEach(({ number }) => {
      const item = perNumber[number];
      if (item) addSignal(item, SOURCE_IDS.postTop10);
    });
  }

  // ── 3) 클래식 wilson top + blend 조합 번호 ──
  const wilsonTop = (classic?.pattern_analysis?.wilson as { top10?: { number: number }[] } | undefined)
    ?.top10;
  if (wilsonTop?.length) {
    wilsonTop.slice(0, 8).forEach(({ number }) => {
      const item = perNumber[number];
      if (item) addSignal(item, SOURCE_IDS.classicWilson);
    });
  }
  if (classic?.combinations?.length) {
    const freq: Record<number, number> = {};
    classic.combinations.forEach((c) => {
      c.numbers.forEach((n) => {
        freq[n] = (freq[n] ?? 0) + 1;
      });
    });
    Object.entries(freq)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .forEach(([n]) => {
        const item = perNumber[Number(n)];
        if (item) addSignal(item, SOURCE_IDS.classicBlend);
      });
  }

  // ── 4) 용지 분석 — intent 슬라이스 우선 (데이터 격리) ──
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
    photoStrong.slice(0, PHOTO_TOP_COUNT).forEach((number) => {
      const item = perNumber[number];
      if (item) addSignal(item, SOURCE_IDS.photoStrong);
    });
  }

  if (photoExcluded.length) {
    photoExcluded.forEach((number) => {
      const item = perNumber[number];
      if (item) markExcluded(item, SOURCE_IDS.photoExcluded);
    });
  }

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
  S: 'S · 3개 신호 합의',
  A: 'A · 2개 신호 합의',
  B: 'B · 1개 신호',
  C: 'C · 신호 없음',
  X: 'X · 배제 (용지)',
};

export const SOURCE_LABELS: Record<string, string> = {
  [SOURCE_IDS.machineHot]: '추첨기 hot',
  [SOURCE_IDS.postS]: '후속출현 grade-S',
  [SOURCE_IDS.postTop10]: '후속출현 top10',
  [SOURCE_IDS.classicWilson]: '클래식 윌슨',
  [SOURCE_IDS.classicBlend]: '클래식 blend',
  [SOURCE_IDS.photoStrong]: '용지 strong',
  [SOURCE_IDS.photoExcluded]: '용지 excluded',
};
