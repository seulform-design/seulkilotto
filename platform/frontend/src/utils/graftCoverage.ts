/** 강수·기대 접목 — 구간 커버 핵심/확장 (확률 불변, recall 폭 보정). */

export type GraftMeta = {
  auto: number;
  semi: number;
  maxMatch: number;
  score: number;
};

export function decadeOf(n: number): number {
  return Math.min(4, Math.floor((n - 1) / 10));
}

/** 양쪽 지지·매치 보너스를 반영한 핵심 선발 키(당첨 미사용). */
export function supportPickKey(n: number, meta: Map<number, GraftMeta>): number {
  const m = meta.get(n);
  if (!m) return -1;
  const both = m.auto > 0 && m.semi > 0 ? 1 : 0;
  return both * 1000 + Math.min(m.auto, m.semi) * 50 + m.score + m.maxMatch * 3;
}

/**
 * 확장망에서 구간 커버 핵심 6.
 * 미커버 구간 가산 + 구간당 최대 2 · 양쪽 지지 우선(지지키).
 * top-6 한 구간 쏠림으로 확장에 담긴 30·40번대 등을 놓치던 회귀 보정.
 */
export function pickCoverageCore6(
  expandRanked: number[],
  meta: Map<number, GraftMeta>,
): number[] {
  const present = new Set(
    expandRanked.filter((n) => {
      const m = meta.get(n);
      return Boolean(m && (m.auto > 0 || m.semi > 0));
    }),
  );
  const order = [...expandRanked].sort(
    (a, b) => supportPickKey(b, meta) - supportPickKey(a, meta) || a - b,
  );
  const result: number[] = [];
  const decadeCount: Record<number, number> = {};
  const covered = new Set<number>();

  const effective = (n: number): number => {
    if (!present.has(n)) return -1;
    const d = decadeOf(n);
    if ((decadeCount[d] ?? 0) >= 2) return -1;
    const uncoverBonus = covered.has(d) ? 0 : 500;
    return supportPickKey(n, meta) + uncoverBonus;
  };

  while (result.length < 6) {
    let best: number | null = null;
    let bestScore = -1;
    for (const n of order) {
      if (result.includes(n)) continue;
      const s = effective(n);
      if (s > bestScore) {
        bestScore = s;
        best = n;
      }
    }
    if (best == null || bestScore < 0) break;
    result.push(best);
    const d = decadeOf(best);
    decadeCount[d] = (decadeCount[d] ?? 0) + 1;
    covered.add(d);
  }
  for (const n of order) {
    if (result.length >= 6) break;
    if (!result.includes(n)) result.push(n);
  }
  return result.slice(0, 6).sort((a, b) => a - b);
}

/**
 * 확장 24 구간 균형 — 후보 있는 빈 구간을 랭킹 상위로 1개씩 승격 후 순위순 보충.
 * backend `_balance_expand` 와 동일 취지(core ⊂ expand 유지).
 */
export function balanceExpandNet(
  order: number[],
  core: number[],
  size = 24,
): number[] {
  const present = new Set(order);
  const result: number[] = [];
  const seen = new Set<number>();
  for (const n of order) {
    if (core.includes(n) && !seen.has(n)) {
      result.push(n);
      seen.add(n);
    }
  }
  const covered = new Set(result.map(decadeOf));
  for (let d = 0; d < 5; d += 1) {
    if (covered.has(d)) continue;
    for (const n of order) {
      if (seen.has(n) || !present.has(n) || decadeOf(n) !== d) continue;
      result.push(n);
      seen.add(n);
      covered.add(d);
      break;
    }
  }
  for (const n of order) {
    if (result.length >= size) break;
    if (!seen.has(n)) {
      result.push(n);
      seen.add(n);
    }
  }
  return result.slice(0, size);
}
