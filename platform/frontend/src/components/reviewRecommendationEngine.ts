import type { ComboDuplicatePatterns } from '../api/v1Api';

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

  ctx.strongCandidates.forEach((n, idx) => {
    bump(scores, n, 18 - idx * 0.6);
  });

  for (const [n, count] of Object.entries(ctx.semiFreq)) {
    bump(scores, Number(n), count * 2.5);
  }
  for (const [n, count] of Object.entries(ctx.autoFreq)) {
    bump(scores, Number(n), count * 1.8);
  }

  const addIntersection = (groups: IntersectionGroupInput[], sizeWeight: number) => {
    for (const g of groups) {
      const w = sizeWeight * Math.log2(g.ticketCount + 1) * g.size;
      for (const n of g.numbers) bump(scores, n, w);
    }
  };
  addIntersection(ctx.intersection.two, 4);
  addIntersection(ctx.intersection.three, 7);
  addIntersection(ctx.intersection.fourPlus, 12);

  for (const g of ctx.lineMatchGroups) {
    const w = g.matchCount ** 2 * Math.log2(g.cardWeight + 1) * 1.5;
    for (const n of g.matchedNumbers) bump(scores, n, w);
  }

  const combos = ctx.comboPatterns;
  if (combos) {
    for (const p of combos.pair_duplicates ?? []) {
      const w = (p.repeat_count ?? p.line_count ?? 1) * 2.5;
      for (const n of p.numbers) bump(scores, n, w);
    }
    for (const t of combos.triple_duplicates ?? []) {
      const w = (t.repeat_count ?? t.line_count ?? 1) * 4;
      for (const n of t.numbers) bump(scores, n, w);
    }
    for (const q of combos.quad_duplicates ?? []) {
      const w = (q.repeat_count ?? q.line_count ?? 1) * 6;
      for (const n of q.numbers) bump(scores, n, w);
    }
    for (const n of combos.strong_candidates ?? []) {
      bump(scores, n, 6);
    }
  }

  if (ctx.sheetIntent === 'review' && ctx.winningNumbers.length > 0) {
    const winSet = new Set(ctx.winningNumbers);
    const strongSet = new Set(ctx.strongCandidates);
    for (const n of ctx.winningNumbers) {
      if (strongSet.has(n) || (scores[n] ?? 0) > 4) {
        bump(scores, n, 8);
      } else {
        bump(scores, n, 2);
      }
    }
    for (const seed of ctx.seedTickets) {
      const winOverlap = seed.ticket.filter((n) => winSet.has(n)).length;
      if (winOverlap >= 3) {
        for (const n of seed.ticket) {
          if (winSet.has(n)) bump(scores, n, seed.weight * 0.4);
        }
      }
    }
  }

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
  if (strongMatch >= 3) {
    total += strongMatch * 6;
    signals.push(`강한후보${strongMatch}`);
  } else if (strongMatch >= 2) {
    total += strongMatch * 3;
    signals.push(`강한후보${strongMatch}`);
  }

  const combos = ctx.comboPatterns;
  let comboScore = 0;
  if (combos) {
    for (const p of combos.pair_duplicates ?? []) {
      if (p.numbers.every((n) => comboSet.has(n))) {
        comboScore += (p.repeat_count ?? 1) * 2;
        signals.push('페어');
      }
    }
    for (const t of combos.triple_duplicates ?? []) {
      if (t.numbers.every((n) => comboSet.has(n))) {
        comboScore += (t.repeat_count ?? 1) * 5;
        signals.push('트리플');
      }
    }
  }
  total += comboScore;

  for (const g of ctx.intersection.three) {
    if (g.numbers.every((n) => comboSet.has(n))) {
      total += Math.log2(g.ticketCount + 1) * 10;
      signals.push('교집합3');
      break;
    }
  }
  for (const g of ctx.intersection.two) {
    if (g.numbers.every((n) => comboSet.has(n))) {
      total += Math.log2(g.ticketCount + 1) * 4;
    }
  }

  for (const g of ctx.lineMatchGroups) {
    if (g.matchCount >= 4 && g.matchedNumbers.every((n) => comboSet.has(n))) {
      total += g.matchCount * g.cardWeight * 0.8;
      signals.push(`자동∩반자동${g.matchCount}`);
      break;
    }
  }

  if (ctx.sheetIntent === 'review' && winMatch >= 3) {
    total += winMatch * 5;
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
    seen.add(key);
    candidates.push(combo);
  };

  // 1) 상위 점수 번호 그리디 슬라이딩 윈도우
  for (let start = 0; start <= Math.min(8, pool.length - 6); start += 1) {
    push(pool.slice(start, start + 6));
  }

  // 2) 교집합 세트 + 풀 보충
  for (const g of [...ctx.intersection.fourPlus, ...ctx.intersection.three, ...ctx.intersection.two]) {
    push(fillFromPool(g.numbers, pool, 6));
  }

  // 3) 자동∩반자동 고일치 매치 번호 + 보충
  for (const g of ctx.lineMatchGroups) {
    if (g.matchCount >= 3) {
      push(fillFromPool(g.matchedNumbers, pool, 6));
    }
  }

  // 4) 분석 상위 시드 티켓 및 변형
  for (const seed of ctx.seedTickets.slice(0, 12)) {
    push([...seed.ticket]);
    for (let drop = 0; drop < 2; drop += 1) {
      const trimmed = seed.ticket.filter((_, i) => i !== drop);
      push(fillFromPool(trimmed, pool, 6));
    }
    for (const swapN of pool.slice(0, 10)) {
      if (!seed.ticket.includes(swapN)) {
        push(fillFromPool([...seed.ticket.slice(0, 5), swapN], pool, 6));
      }
    }
  }

  // 5) 콤보 패턴 트리플/페어 기반
  if (ctx.comboPatterns) {
    for (const t of (ctx.comboPatterns.triple_duplicates ?? []).slice(0, 8)) {
      push(fillFromPool(t.numbers, pool, 6));
    }
    for (const p of (ctx.comboPatterns.pair_duplicates ?? []).slice(0, 10)) {
      push(fillFromPool(p.numbers, pool, 6));
    }
  }

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

  for (let i = 0; i < 120; i += 1) {
    push(pickWeighted());
  }

  // weightSum referenced to avoid lint unused in some builds
  if (weightSum <= 0) push(pool.slice(0, 6));

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

  const picked: ScoredRecommendation[] = [];
  for (const item of raw) {
    if (picked.every((p) => diversityOk(p.combo, item.combo))) {
      picked.push(item);
    }
    if (picked.length >= count) break;
  }

  if (picked.length < count) {
    for (const item of raw) {
      if (!picked.some((p) => comboKey(p.combo) === comboKey(item.combo))) {
        picked.push(item);
      }
      if (picked.length >= count) break;
    }
  }

  return picked.slice(0, count);
}
