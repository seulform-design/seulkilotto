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
  win: FeatureAvg | null;
  rest: FeatureAvg | null;
  discriminators: Discriminator[];
  confidence: LearnConfidence;
  note: string;
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
      out.push({
        numbers,
        size: c.size ?? numbers.length,
        lineCount: c.line_count ?? c.repeat_count ?? 0,
        lift: c.lift ?? 0,
        z: c.z ?? 0,
        winOverlap,
        fullyWinning: winningSet != null && numbers.length > 0 && winOverlap === numbers.length,
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
 * @param reviewPatterns 복기 accumulated_combo_patterns
 * @param winningNumbers 복기 회차 실제 당첨번호(6개)
 */
export function learnOverlapProfile(
  reviewPatterns: ComboPatternsLike | null | undefined,
  winningNumbers: number[] | null | undefined
): LearnedOverlapProfile {
  const winningSet =
    winningNumbers && winningNumbers.length ? new Set(winningNumbers.filter((n) => n >= 1 && n <= 45)) : null;
  const combos = normalize(reviewPatterns, winningSet);
  const winning = combos.filter((c) => c.fullyWinning);
  const partial = combos.filter((c) => !c.fullyWinning && c.winOverlap * 2 >= c.size);
  const rest = combos.filter((c) => !c.fullyWinning);

  const winAvg = avg(winning);
  const restAvg = avg(rest);

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
  const confidence: LearnConfidence =
    winningCount >= 6 ? 'medium' : winningCount >= 3 ? 'low' : 'none';

  const note =
    confidence === 'none'
      ? '당첨과 완전히 겹친 조합이 3건 미만이라 학습 신뢰도가 매우 낮습니다(서술 참고용). 복기 회차가 쌓일수록 정확해집니다.'
      : confidence === 'low'
        ? '표본이 적어(당첨 일치 조합 3~5건) 경향 참고용입니다. 복기 회차 누적을 권장합니다.'
        : '복기 겹침 조합의 당첨 일치 경향을 반영했습니다(그래도 확률은 불변).';

  return {
    totalCombos: combos.length,
    winningCombos: winningCount,
    partialCombos: partial.length,
    win: winAvg,
    rest: restAvg,
    discriminators,
    confidence,
    note,
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
  const scoreByNumber = new Map<number, number>();
  const supportByNumber = new Map<number, number>();

  for (const c of combos) {
    // 각 판별 특성에서 win 방향에 얼마나 부합하는지 0~1 로 환산해 평균.
    let match = 0;
    let used = 0;
    for (const d of active) {
      const val = d.key === 'lineCount' ? c.lineCount : d.key === 'lift' ? c.lift : d.key === 'z' ? c.z : c.size;
      const target = d.win;
      const ref = profile.rest ? profile.rest[d.key] : 0;
      const span = Math.abs(target - ref) || 1;
      // win 방향으로 target 이상이면 1, ref 이하면 0, 사이는 선형.
      let m: number;
      if (d.dir === 'higher') m = clamp01((val - ref) / span);
      else m = clamp01((ref - val) / span);
      match += m;
      used += 1;
    }
    const comboScore = used ? match / used : 0;
    // 크기 가중(3·4번호 겹침이 2번호보다 신호가 강함) + lift 살짝 반영.
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
