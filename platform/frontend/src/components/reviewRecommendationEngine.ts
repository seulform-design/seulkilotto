import type { ComboDuplicatePatterns } from '../api/v1Api';
import { acValue, maxConsecutiveRun, oddCount, sumTotal } from '../utils/comboMetrics';

/**
 * 통계적으로 1등 조합에서 거의 나오지 않는 패턴을 배제한다.
 * 수학적 확률을 바꾸지는 않지만, 합 극단·전부 홀(짝)·4연속·등차수열류 등
 * 역대 1등에 사실상 없는 조합을 추천에서 제외해 품질을 높인다.
 */
function passesBasicFilters(combo: number[]): boolean {
  if (combo.length !== 6) return false;
  const sum = sumTotal(combo);
  if (sum < 90 || sum > 195) return false; // p5~p95 보수 구간
  const oc = oddCount(combo);
  if (oc === 0 || oc === 6) return false; // 0:6 / 6:0 차단
  if (maxConsecutiveRun(combo) >= 4) return false; // 4연속 차단
  if (acValue(combo) < 5) return false; // 등차수열류 차단
  return true;
}

export interface IntersectionGroupInput {
  numbers: number[];
  size: number;
  ticketCount: number;
}

export interface LineMatchGroupInput {
  matchCount: number;
  matchedNumbers: number[];
  cardWeight: number;
}

export interface SeedTicketInput {
  ticket: number[];
  weight: number;
  label: string;
}

export interface UnifiedSignalInput {
  number: number;
  grade: 'S' | 'A' | 'B' | 'C' | 'X';
  score: number;
  sources: string[];
}

export interface RecommendationContext {
  sheetIntent: 'review' | 'current_round';
  strongCandidates: number[];
  excludedCandidates: number[];
  winningNumbers: number[];
  comboPatterns: ComboDuplicatePatterns | null;
  semiFreq: Record<number, number>;
  autoFreq: Record<number, number>;
  intersection: {
    two: IntersectionGroupInput[];
    three: IntersectionGroupInput[];
    fourPlus: IntersectionGroupInput[];
  };
  lineMatchGroups: LineMatchGroupInput[];
  seedTickets: SeedTicketInput[];
  /** 서버 통합 예측 신호 (/api/v1/prediction/signals) */
  unifiedSignals?: UnifiedSignalInput[];
  /** 평행회차 강수 (상위, 순위순) — /api/v1/analysis/parallel-round */
  parallelStrong?: number[];
  /** 평행회차 기대수 (상위, 순위순) */
  parallelExpected?: number[];
  /** 호기(추첨기) 상위 신호 번호 (순위순) — /api/v1/recommend/round */
  machineStrong?: number[];
  /** [추천 생성] 클릭마다 증가 — 같은 데이터에서도 매번 다른 5세트를 낸다. */
  regenNonce?: number;
}

export interface ScoredRecommendation {
  combo: number[];
  totalScore: number;
  winMatch: number;
  strongMatch: number;
  comboScore: number;
  signals: string[];
}

function bump(scores: Record<number, number>, n: number, w: number) {
  if (Number.isInteger(n) && n >= 1 && n <= 45) {
    scores[n] = (scores[n] ?? 0) + w;
  }
}

function comboKey(nums: number[]): string {
  return [...nums].sort((a, b) => a - b).join('-');
}

function buildNumberScores(ctx: RecommendationContext): Record<number, number> {
  const scores: Record<number, number> = {};

  // 종합 추천은 '강한 후보(unifiedSignals)' 를 점수 축으로 쓰지 않는다(사용자 요청).
  // 대신 아래 세 축 — 자동↔반자동 1:1 전수비교(lineMatchGroups) · 평행회차
  // (parallelStrong/Expected) · 호기(추첨기, machineStrong) — 으로만 산출한다.
  // strongCandidates/unifiedSignals 는 scoreCombo 표시·필터에도 반영하지 않는다.

  // ① 자동↔반자동 1:1 전수비교 — 공통 번호가 많고 겹친 카드가 많을수록 가중.
  for (const g of ctx.lineMatchGroups) {
    const w = g.matchCount ** 2 * Math.log2(g.cardWeight + 1) * 2.2;
    for (const n of g.matchedNumbers) bump(scores, n, w);
  }
  // ② 평행회차 — 강수(상위 가중) + 기대수(보조).
  ctx.parallelStrong?.forEach((n, idx) => bump(scores, n, 26 - idx * 1.0));
  ctx.parallelExpected?.forEach((n, idx) => bump(scores, n, 12 - idx * 0.4));
  // ③ 호기(추첨기) 상위.
  ctx.machineStrong?.forEach((n, idx) => bump(scores, n, 26 - idx * 1.2));

  // 강한후보·빈도·교집합·콤보패턴은 종합 추천 점수에 반영하지 않는다(3축 전용).
  // 복기 모드라도 실제 당첨번호(winningNumbers)는 점수에 주입하지 않는다.
  // (사후 편향 제거 — 그러면 추천이 곧 당첨번호가 되어 예측 정합성 평가가
  //  무의미해진다.) 당첨 일치 개수는 scoreCombo 의 winMatch 로 '표시'만 한다.
  return scores;
}

function scoreCombo(
  combo: number[],
  ctx: RecommendationContext,
  numberScores: Record<number, number>
): ScoredRecommendation {
  const excludedSet = new Set(ctx.excludedCandidates);
  const strongSet = new Set(ctx.strongCandidates);
  const winSet = new Set(ctx.winningNumbers);
  const comboSet = new Set(combo);

  const excludedHit = combo.filter((n) => excludedSet.has(n)).length;
  const strongMatch = combo.filter((n) => strongSet.has(n)).length;
  const winMatch = combo.filter((n) => winSet.has(n)).length;

  let total = combo.reduce((s, n) => s + (numberScores[n] ?? 0), 0);
  const signals: string[] = [];

  if (excludedHit >= 2) total -= 80;
  if (excludedHit >= 1) signals.push(`배제${excludedHit}`);
  // 강한 후보 일치는 점수·신호에 반영하지 않는다(사용자 요청 — 3축 기준).
  // strongMatch 는 반환 타입 호환을 위해 계산만 유지하고 표시하지 않는다.

  // 콤보(페어/트리플)·교집합은 점수·신호에 반영하지 않는다(3축 전용).
  // comboScore 는 반환 타입 호환을 위해 0 으로 고정한다.
  const comboScore = 0;

  // 자동↔반자동 1:1 매칭 정합 — 3개 이상 공통 줄겹침이 조합에 들어가면 가산.
  let bestLineMatch = 0;
  for (const g of ctx.lineMatchGroups) {
    if (g.matchCount >= 3 && g.matchedNumbers.every((n) => comboSet.has(n))) {
      total += g.matchCount * Math.log2(g.cardWeight + 2) * 2.2;
      bestLineMatch = Math.max(bestLineMatch, g.matchCount);
    }
  }
  if (bestLineMatch > 0) signals.push(`자동∩반자동${bestLineMatch}`);

  // 평행회차·호기(추첨기) 정합 — 조합에 2개 이상 포함되면 가산·표시.
  const parallelSet = new Set(ctx.parallelStrong ?? []);
  const parHit = combo.filter((n) => parallelSet.has(n)).length;
  if (parHit >= 2) {
    total += parHit * 2;
    signals.push(`평행${parHit}`);
  }
  const machineSet = new Set(ctx.machineStrong ?? []);
  const machHit = combo.filter((n) => machineSet.has(n)).length;
  if (machHit >= 2) {
    total += machHit * 2;
    signals.push(`추첨기${machHit}`);
  }

  // 복기 당첨 일치는 점수에 더하지 않는다(사후 편향 방지). winMatch 는 결과
  // 카드에 '당첨 N개 일치'로 표시만 되어 예측 정합성을 정직하게 보여준다.
  if (ctx.sheetIntent === 'review' && winMatch >= 3) {
    signals.push(`당첨${winMatch}`);
  }

  return {
    combo: [...combo].sort((a, b) => a - b),
    totalScore: total,
    winMatch,
    strongMatch,
    comboScore,
    signals: Array.from(new Set(signals)),
  };
}

function fillFromPool(base: number[], pool: number[], need: number): number[] | null {
  const out = [...new Set(base)];
  for (const n of pool) {
    if (out.length >= 6) break;
    if (!out.includes(n)) out.push(n);
  }
  if (out.length < need) return null;
  return out.slice(0, need).sort((a, b) => a - b);
}

function generateCandidates(ctx: RecommendationContext, numberScores: Record<number, number>): number[][] {
  const excludedSet = new Set(ctx.excludedCandidates);
  const ranked = Object.entries(numberScores)
    .filter(([n]) => !excludedSet.has(Number(n)))
    .sort(([, a], [, b]) => b - a || Number(a) - Number(b))
    .map(([n]) => Number(n));

  const pool = ranked.length >= 6 ? ranked : ranked.concat(
    Array.from({ length: 45 }, (_, i) => i + 1).filter((n) => !ranked.includes(n) && !excludedSet.has(n))
  );

  const candidates: number[][] = [];
  const seen = new Set<string>();

  const push = (combo: number[] | null) => {
    if (!combo || combo.length !== 6) return;
    const key = comboKey(combo);
    if (seen.has(key)) return;
    if (combo.filter((n) => excludedSet.has(n)).length >= 2) return;
    if (!passesBasicFilters(combo)) return; // 통계적으로 1등에 거의 없는 조합 배제
    seen.add(key);
    candidates.push(combo);
  };

  // ── 합의(consensus) 풀 — 종합 추천의 세 축 ─────────────────────────
  // ① 자동↔반자동 1:1 매칭 ② 평행회차 강수 ③ 호기(추첨기) 상위 번호를
  // 신뢰도순으로 모아 추천 6번호의 코어를 채운다(교집합·빈도·콤보 미사용).
  const consensusScore: Record<number, number> = {};
  const addCon = (nums: number[], w: number) => {
    for (const n of nums) {
      if (!excludedSet.has(n)) consensusScore[n] = (consensusScore[n] ?? 0) + w;
    }
  };
  for (const g of ctx.lineMatchGroups) addCon(g.matchedNumbers, g.matchCount * g.matchCount * Math.log2(g.cardWeight + 2));
  (ctx.parallelStrong ?? []).forEach((n, idx) => addCon([n], Math.max(4, 16 - idx)));
  (ctx.machineStrong ?? []).forEach((n, idx) => addCon([n], Math.max(4, 16 - idx)));
  const consensusPool = Object.entries(consensusScore)
    .sort(([, a], [, b]) => b - a)
    .map(([n]) => Number(n));

  // 코어(교집합/매칭 번호) → 합의풀 → 일반풀 순서로 6번호 채우기
  const fillConsensus = (base: number[]): number[] | null => {
    const out = [...new Set(base.filter((n) => !excludedSet.has(n) && n >= 1 && n <= 45))];
    for (const src of [consensusPool, pool]) {
      for (const n of src) {
        if (out.length >= 6) break;
        if (!out.includes(n)) out.push(n);
      }
    }
    return out.length >= 6 ? out.slice(0, 6).sort((a, b) => a - b) : null;
  };

  // C1) 합의 상위 6 — 가장 많은 자동·반자동이 동의한 번호 묶음
  if (consensusPool.length >= 6) push(fillConsensus(consensusPool.slice(0, 6)));

  // C2) 1:1 매칭(2개 이상 공통) + 평행회차 강수·호기 상위를 코어로 한 조합
  const cores: number[][] = [
    ...ctx.lineMatchGroups.filter((g) => g.matchCount >= 2).map((g) => g.matchedNumbers),
    ...((ctx.parallelStrong ?? []).length >= 3 ? [(ctx.parallelStrong ?? []).slice(0, 4)] : []),
    ...((ctx.machineStrong ?? []).length >= 3 ? [(ctx.machineStrong ?? []).slice(0, 4)] : []),
  ];
  for (const core of cores) push(fillConsensus(core));

  // C3) 코어끼리 결합 (작은 코어 2개 → 더 강한 합의 조합)
  const bigCores = cores.filter((c) => c.length >= 2).slice(0, 12);
  for (let i = 0; i < bigCores.length; i += 1) {
    for (let j = i + 1; j < bigCores.length; j += 1) {
      push(fillConsensus([...bigCores[i], ...bigCores[j]]));
    }
  }

  // 1) 상위 점수(3축) 번호 그리디 슬라이딩 윈도우 (합의가 부족할 때 보충)
  for (let start = 0; start <= Math.min(8, pool.length - 6); start += 1) {
    push(pool.slice(start, start + 6));
  }

  // (시드 티켓·콤보 패턴 기반 후보는 3축 전용화로 제거 — pool 자체가 3축 점수라
  //  아래 가중 무작위 탐색이 세 축 번호 위주로 조합을 만든다.)

  // 6) 가중 무작위 탐색
  const weights = pool.map((n) => Math.max(0.1, numberScores[n] ?? 0.1));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const pickWeighted = (): number[] => {
    const chosen: number[] = [];
    const localPool = [...pool];
    const localWeights = [...weights];
    while (chosen.length < 6 && localPool.length > 0) {
      let r = Math.random() * localWeights.reduce((a, b) => a + b, 0);
      let idx = 0;
      for (let i = 0; i < localWeights.length; i += 1) {
        r -= localWeights[i];
        if (r <= 0) {
          idx = i;
          break;
        }
      }
      chosen.push(localPool[idx]);
      localPool.splice(idx, 1);
      localWeights.splice(idx, 1);
    }
    return chosen.sort((a, b) => a - b);
  };

  for (let i = 0; i < 160; i += 1) {
    push(pickWeighted());
  }

  // 폴백 — 기본 필터로 모두 걸러져 후보가 없으면, 필터를 무시하고서라도
  // 점수 상위/무작위 조합을 채워 항상 최소 1세트는 생성한다(생성 실패 방지).
  if (candidates.length === 0) {
    const forcePush = (combo: number[]) => {
      const key = comboKey(combo);
      if (combo.length === 6 && !seen.has(key)) {
        seen.add(key);
        candidates.push(combo);
      }
    };
    if (pool.length >= 6) forcePush(pool.slice(0, 6));
    for (let i = 0; i < 40 && candidates.length < 5; i += 1) forcePush(pickWeighted());
  }
  void weightSum;

  return candidates;
}

function diversityOk(a: number[], b: number[]): boolean {
  const setA = new Set(a);
  const overlap = b.filter((n) => setA.has(n)).length;
  return overlap <= 4;
}

export function generateScoredRecommendations(
  ctx: RecommendationContext,
  count = 5
): ScoredRecommendation[] {
  const numberScores = buildNumberScores(ctx);
  const raw = generateCandidates(ctx, numberScores)
    .map((combo) => scoreCombo(combo, ctx, numberScores))
    .filter((s) => s.totalScore > -50)
    .sort((a, b) => b.totalScore - a.totalScore);
  if (raw.length === 0) return [];

  // 매 클릭 다른 5세트 — 상위는 결정적 고득점 후보라 그대로 top-N 을 뽑으면
  // 항상 같은 5세트가 나온다. 상위 '품질 풀'(top ~24) 안에서 nonce 기준으로
  // 시작점을 회전시켜, 품질은 유지하되 클릭마다 다른 조합을 보여준다.
  // (nonce 0 = 최상위 5세트, 이후 클릭마다 대안 탐색)
  const nonce = ctx.regenNonce ?? 0;
  const poolSize = Math.min(raw.length, Math.max(count * 5, 24));
  const qualityPool = raw.slice(0, poolSize);
  const startBase = poolSize > count ? ((nonce % poolSize) * count) % poolSize : 0;
  const rotated = [...qualityPool.slice(startBase), ...qualityPool.slice(0, startBase)];

  const picked: ScoredRecommendation[] = [];
  for (const item of rotated) {
    if (picked.every((p) => diversityOk(p.combo, item.combo))) {
      picked.push(item);
    }
    if (picked.length >= count) break;
  }

  // diversity 로 부족하면 회전 순서대로 채우고, 그래도 모자라면 raw 전체에서 채움.
  if (picked.length < count) {
    for (const item of [...rotated, ...raw]) {
      if (!picked.some((p) => comboKey(p.combo) === comboKey(item.combo))) {
        picked.push(item);
      }
      if (picked.length >= count) break;
    }
  }

  return picked.slice(0, count);
}
