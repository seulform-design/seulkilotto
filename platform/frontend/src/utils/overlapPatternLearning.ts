/**
 * 줄겹침(cross-line overlap) 패턴 역산 학습.
 *
 * 복기(review)에서 '다른 줄에도 겹침 2·3·4번호' 조합 중 **실제 당첨번호와 일치한**
 * 조합들이 어떤 구조(겹친 줄 수·lift·z·크기)를 가졌는지 역산해 프로파일을 만들고,
 * 그 프로파일로 이번회차 겹침 조합을 채점해 후보를 정렬한다.
 *
 * ⚠️ 정직성: 로또는 i.i.d. 균등난수 → 어떤 패턴도 당첨 확률(1/8,145,060)을 못 바꾼다.
 * 이 학습은 '내 용지의 겹침 구조 중 무엇이 지난 당첨과 겹쳤나'를 서술·정렬할 뿐이며,
 * 표본(복기 회차·당첨 일치 조합)이 적으면 통계적 의미가 약하다(confidence 로 표기).
 */

export interface ComboLike {
  numbers?: number[];
  size?: number;
  line_count?: number;
  repeat_count?: number;
  lift?: number;
  z?: number;
}

export interface ComboPatternsLike {
  pair_duplicates?: ComboLike[];
  triple_duplicates?: ComboLike[];
  quad_duplicates?: ComboLike[];
}

interface NormCombo {
  numbers: number[];
  size: number;
  lineCount: number;
  lift: number;
  z: number;
  winOverlap: number; // 조합 번호 중 당첨번호 개수(복기)
  fullyWinning: boolean; // 조합 번호 전부가 당첨번호
  /** 절반 이상 당첨 겹침 — 완전일치가 드물 때 프로파일 보조 표본 */
  partialHit: boolean;
}

interface FeatureAvg {
  lineCount: number;
  lift: number;
  z: number;
  size: number;
}

export interface Discriminator {
  key: 'lineCount' | 'lift' | 'z' | 'size';
  label: string;
  win: number;
  rest: number;
  dir: 'higher' | 'lower' | 'flat';
}

export type LearnConfidence = 'none' | 'low' | 'medium';

export interface LearnedOverlapProfile {
  totalCombos: number;
  winningCombos: number; // 전부 당첨(fullyWinning)
  partialCombos: number; // 절반 이상 겹침
  /** 프로파일에 실제 사용된 양성 표본(완전 + 부분 가중) */
  positiveCombos: number;
  win: FeatureAvg | null;
  rest: FeatureAvg | null;
  discriminators: Discriminator[];
  confidence: LearnConfidence;
  note: string;
  /** 완전일치 부족으로 부분일치 표본을 썼는지 */
  usedPartialFallback: boolean;
}

export interface RankedCandidate {
  number: number;
  score: number;
  support: number; // 이 번호를 포함한 이번회차 겹침 조합 수
}

const FEATURE_LABELS: Record<Discriminator['key'], string> = {
  lineCount: '겹친 줄 수',
  lift: 'lift(우연 대비)',
  z: 'z(유의도)',
  size: '조합 크기',
};

function normalize(patterns: ComboPatternsLike | null | undefined, winningSet: Set<number> | null): NormCombo[] {
  if (!patterns) return [];
  const buckets = [patterns.pair_duplicates, patterns.triple_duplicates, patterns.quad_duplicates];
  const out: NormCombo[] = [];
  for (const bucket of buckets) {
    for (const c of bucket ?? []) {
      const numbers = (c.numbers ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= 45);
      if (numbers.length < 2) continue;
      const winOverlap = winningSet ? numbers.filter((n) => winningSet.has(n)).length : 0;
      const fullyWinning = winningSet != null && numbers.length > 0 && winOverlap === numbers.length;
      // 2번호: 1개+, 3·4번호: 절반 이상
      const partialHit =
        !fullyWinning &&
        winningSet != null &&
        (numbers.length <= 2 ? winOverlap >= 1 : winOverlap * 2 >= numbers.length);
      out.push({
        numbers,
        size: c.size ?? numbers.length,
        lineCount: c.line_count ?? c.repeat_count ?? 0,
        lift: c.lift ?? 0,
        z: c.z ?? 0,
        winOverlap,
        fullyWinning,
        partialHit,
      });
    }
  }
  return out;
}

function avg(combos: NormCombo[]): FeatureAvg | null {
  if (!combos.length) return null;
  const s = combos.reduce(
    (a, c) => ({
      lineCount: a.lineCount + c.lineCount,
      lift: a.lift + c.lift,
      z: a.z + c.z,
      size: a.size + c.size,
    }),
    { lineCount: 0, lift: 0, z: 0, size: 0 }
  );
  const n = combos.length;
  return {
    lineCount: round2(s.lineCount / n),
    lift: round2(s.lift / n),
    z: round2(s.z / n),
    size: round2(s.size / n),
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * 복기 겹침 조합 + 당첨번호 → 학습 프로파일.
 * 완전일치가 드물면(로또 정상) 부분일치 표본으로 프로파일을 보강한다.
 */
export function learnOverlapProfile(
  reviewPatterns: ComboPatternsLike | null | undefined,
  winningNumbers: number[] | null | undefined
): LearnedOverlapProfile {
  const winningSet =
    winningNumbers && winningNumbers.length ? new Set(winningNumbers.filter((n) => n >= 1 && n <= 45)) : null;
  const combos = normalize(reviewPatterns, winningSet);
  const winning = combos.filter((c) => c.fullyWinning);
  const partial = combos.filter((c) => c.partialHit);
  const rest = combos.filter((c) => !c.fullyWinning && !c.partialHit);

  // 완전일치 3건 미만이면 부분일치를 양성 표본에 합침(가중은 완전 > 부분).
  const usedPartialFallback = winning.length < 3 && partial.length > 0;
  const positive = usedPartialFallback ? [...winning, ...partial] : winning;

  const winAvg = avg(positive);
  const restAvg = avg(rest.length ? rest : combos.filter((c) => !c.fullyWinning));

  const discriminators: Discriminator[] = [];
  if (winAvg && restAvg) {
    (['lineCount', 'lift', 'z', 'size'] as const).forEach((key) => {
      const w = winAvg[key];
      const r = restAvg[key];
      const denom = Math.abs(r) > 1e-6 ? Math.abs(r) : 1;
      const relDelta = (w - r) / denom;
      const dir: Discriminator['dir'] =
        relDelta > 0.15 ? 'higher' : relDelta < -0.15 ? 'lower' : 'flat';
      discriminators.push({ key, label: FEATURE_LABELS[key], win: w, rest: r, dir });
    });
  }

  const winningCount = winning.length;
  const positiveCount = positive.length;
  // 완전일치 위주면 medium, 부분 보조면 상한을 low.
  let confidence: LearnConfidence = 'none';
  if (winningCount >= 6) confidence = 'medium';
  else if (winningCount >= 3) confidence = 'low';
  else if (positiveCount >= 6 && usedPartialFallback) confidence = 'low';
  else if (positiveCount >= 3 && usedPartialFallback) confidence = 'low';

  const note =
    confidence === 'none'
      ? '당첨과 겹친 조합(완전·부분)이 3건 미만이라 학습 신뢰도가 매우 낮습니다. 복기 회차·줄이 쌓일수록 채워집니다.'
      : usedPartialFallback
        ? '완전일치 표본이 적어 부분일치(절반+)로 프로파일을 보강했습니다. 경향 참고용이며 확률은 불변입니다.'
        : confidence === 'low'
          ? '표본이 적어(당첨 일치 조합 3~5건) 경향 참고용입니다. 복기 회차 누적을 권장합니다.'
          : '복기 겹침 조합의 당첨 일치 경향을 반영했습니다(그래도 확률은 불변).';

  return {
    totalCombos: combos.length,
    winningCombos: winningCount,
    partialCombos: partial.length,
    positiveCombos: positiveCount,
    win: winAvg,
    rest: restAvg,
    discriminators,
    confidence,
    note,
    usedPartialFallback,
  };
}

/**
 * 이번회차 겹침 조합을 학습 프로파일로 채점 → 번호별 후보 랭킹.
 * 프로파일의 판별 특성(win > rest)에 부합하는 조합일수록 높은 점수를 주고,
 * 조합 점수를 그 조합에 든 번호에 배분해 합산한다.
 */
export function rankCurrentByProfile(
  currentPatterns: ComboPatternsLike | null | undefined,
  profile: LearnedOverlapProfile
): RankedCandidate[] {
  const combos = normalize(currentPatterns, null);
  if (!combos.length || !profile.win) return [];

  const active = profile.discriminators.filter((d) => d.dir !== 'flat');
  // 판별 특성이 전부 flat이면 점수 분산이 없어 후보가 비게 됨 → lift·줄수 약한 프록시.
  const scoreByNumber = new Map<number, number>();
  const supportByNumber = new Map<number, number>();

  for (const c of combos) {
    let comboScore = 0;
    if (active.length) {
      let match = 0;
      for (const d of active) {
        const val = d.key === 'lineCount' ? c.lineCount : d.key === 'lift' ? c.lift : d.key === 'z' ? c.z : c.size;
        const target = d.win;
        const ref = profile.rest ? profile.rest[d.key] : 0;
        const span = Math.abs(target - ref) || 1;
        let m: number;
        if (d.dir === 'higher') m = clamp01((val - ref) / span);
        else m = clamp01((ref - val) / span);
        match += m;
      }
      comboScore = match / active.length;
    } else {
      // 폴백: 강한 겹침(줄 수·lift) 우선 — 프로파일이 평탄할 때도 후보가 보이게
      comboScore = clamp01((c.lineCount - 1) / 3) * 0.6 + clamp01((c.lift - 1) / 2) * 0.4;
    }
    const weight = comboScore * (1 + 0.3 * (c.size - 2)) * (1 + 0.1 * Math.max(0, c.lift - 1));
    if (weight <= 0) continue;
    for (const n of c.numbers) {
      scoreByNumber.set(n, (scoreByNumber.get(n) ?? 0) + weight);
      supportByNumber.set(n, (supportByNumber.get(n) ?? 0) + 1);
    }
  }

  return [...scoreByNumber.entries()]
    .map(([number, score]) => ({ number, score: round2(score), support: supportByNumber.get(number) ?? 0 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.support - a.support || a.number - b.number)
    .slice(0, 12);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
