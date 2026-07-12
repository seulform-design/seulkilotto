/**
 * 잭팟 분산(공동당첨 회피) 점수 — 기대값(EV) 최적화용.
 *
 * ⚠️ 정직성: 이 점수는 **당첨 확률을 바꾸지 않는다**. 로또는 i.i.d. 균등난수이고
 * 어떤 6-튜플이든 당첨 확률은 1/8,145,060 로 동일하다. 이 점수가 개선하는 것은
 * 오직 **'당첨했을 때의 기대 수령액'**이다 — 동행복권 1등은 공동당첨자끼리 분배되므로,
 * 남들이 잘 안 고르는 조합일수록 당첨 시 분배 인원이 적어 실수령액이 커진다.
 *
 * 근거(실제 플레이어 선호 편향):
 *  - 생일/날짜 편향: 다수가 1~31(특히 1~12 월)만 사용 → 저번호 편중 조합은 공동당첨↑.
 *  - 연속열(1-2-3-4-5-6 류)·등차수열·5의 배수열: 용지에서 시각적으로 끌려 과다 선택.
 *  - 전부 홀/전부 짝, 전부 고번호(32~45): 거의 안 골라 분배 인원↓(EV↑).
 *
 * 반환 risk 는 '상대적 인기(=공동당첨 위험)'의 휴리스틱 추정이며 공동당첨자 수를
 * 정확히 예측하지 않는다. 낮을수록 남들과 겹칠 확률이 낮다(EV 유리).
 */

export interface SharingFactor {
  key: string;
  label: string;
  /** risk 에 더해진 값(양수=인기↑/EV↓, 음수=희소↑/EV↑). */
  delta: number;
  note: string;
}

export type SharingGrade = 'excellent' | 'good' | 'fair' | 'poor';

export interface SharingAssessment {
  /** 0~100, 높을수록 남들과 겹칠 가능성↑(공동당첨 위험↑, EV↓). */
  risk: number;
  /** 100 - risk, 높을수록 분산 유리(당첨 시 실수령 기대↑). */
  evScore: number;
  grade: SharingGrade;
  factors: SharingFactor[];
  summary: string;
}

const GRADE_LABEL: Record<SharingGrade, string> = {
  excellent: '매우 희소',
  good: '희소',
  fair: '보통',
  poor: '인기 편중',
};

function longestConsecutiveRun(sorted: number[]): number {
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1] + 1) {
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 1;
    }
  }
  return sorted.length ? best : 0;
}

/** 6개 번호가 (근사) 등차수열인지 — 인접 차이의 최빈값이 5개 중 4개 이상 동일. */
function isArithmeticish(sorted: number[]): boolean {
  if (sorted.length < 6) return false;
  const diffs: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) diffs.push(sorted[i] - sorted[i - 1]);
  const counts = new Map<number, number>();
  for (const d of diffs) counts.set(d, (counts.get(d) ?? 0) + 1);
  let maxCount = 0;
  for (const c of counts.values()) maxCount = Math.max(maxCount, c);
  return maxCount >= 4; // 5개 차이 중 4개 이상이 같은 간격
}

/**
 * 6-번호 조합의 공동당첨 위험(=상대적 인기) 점수.
 * @param numbers 정확히 6개(1~45)일 때 유효. 그 외엔 중립(risk 50) 반환.
 */
export function assessJackpotSharing(numbers: number[]): SharingAssessment {
  const valid = Array.from(new Set(numbers.filter((n) => Number.isInteger(n) && n >= 1 && n <= 45)));
  if (valid.length !== 6) {
    return {
      risk: 50,
      evScore: 50,
      grade: 'fair',
      factors: [],
      summary: '6개(1~45) 조합이어야 분산 점수를 계산할 수 있습니다.',
    };
  }
  const sorted = [...valid].sort((a, b) => a - b);
  const factors: SharingFactor[] = [];
  // 중립 기준 40 에서 편향 요인을 가감(무작위 조합의 기대 위험 ≈ 중하).
  let risk = 40;

  const add = (key: string, label: string, delta: number, note: string) => {
    if (delta === 0) return;
    risk += delta;
    factors.push({ key, label, delta, note });
  };

  // 1) 생일/날짜 편향 — 1~31 편중. 무작위 기대 ≈ 4.13개. 초과분에 가중.
  const le31 = sorted.filter((n) => n <= 31).length;
  if (le31 >= 5) {
    const d = (le31 - 4) * 8 + (le31 === 6 ? 14 : 0);
    add('low_bias', '저번호(1~31) 편중', d, `${le31}개가 1~31 — 생일 조합과 겹치기 쉬움`);
  } else if (le31 <= 3) {
    add('high_usage', '고번호(32~45) 활용', -(4 - le31) * 7, `1~31 은 ${le31}개뿐 — 남들이 덜 쓰는 고번호 포함`);
  }

  // 2) 월(1~12) 초저번호 편중 — 생일 '월' 편향 추가 신호.
  const le12 = sorted.filter((n) => n <= 12).length;
  if (le12 >= 4) add('month_bias', '초저번호(1~12) 편중', (le12 - 3) * 6, `${le12}개가 1~12 — 월/일 편향과 강하게 겹침`);

  // 3) 연속열 — 긴 연속(1-2-3-4…)은 과다 선택.
  const run = longestConsecutiveRun(sorted);
  if (run >= 3) add('consecutive', '연속열', (run - 2) * 7, `최장 ${run}연속 — 시각적 인기 패턴`);

  // 4) 등차/규칙 수열 — 5의 배수열·일정 간격 등.
  if (isArithmeticish(sorted)) add('arithmetic', '규칙 수열', 12, '일정 간격 배열 — 용지에서 과다 선택되는 패턴');

  // 5) 5의 배수 편중.
  const mult5 = sorted.filter((n) => n % 5 === 0).length;
  if (mult5 >= 4) add('mult5', '5의 배수 편중', (mult5 - 3) * 6, `${mult5}개가 5의 배수 — 정렬된 조합 선호`);

  // 6) 전부 홀 / 전부 짝 — 오히려 희소(대부분 균형을 고름) → EV 유리.
  const odd = sorted.filter((n) => n % 2 === 1).length;
  if (odd === 6 || odd === 0) add('parity_extreme', odd === 6 ? '전부 홀수' : '전부 짝수', -8, '균형 조합을 피한 희소 패턴');

  // 7) 전부 고번호(32~45) — 매우 희소.
  if (le31 === 0) add('all_high', '전부 고번호', -12, '32~45 만 — 거의 선택되지 않는 희소 영역');

  // 8) 합계 극단 — 인기대(≈100~170) 밖은 상대적으로 희소.
  const sum = sorted.reduce((a, b) => a + b, 0);
  if (sum < 90 || sum > 185) add('sum_extreme', '합계 극단', -6, `합 ${sum} — 인기 합계대(약 100~170) 밖`);

  risk = Math.max(0, Math.min(100, Math.round(risk)));
  const evScore = 100 - risk;
  const grade: SharingGrade =
    risk < 30 ? 'excellent' : risk < 45 ? 'good' : risk < 62 ? 'fair' : 'poor';

  const summary =
    grade === 'poor'
      ? '남들과 겹칠 위험이 큽니다 — 당첨해도 공동분배로 실수령이 줄 수 있습니다.'
      : grade === 'fair'
        ? '평범한 분산 — 특별히 인기도, 희소하지도 않습니다.'
        : '희소한 조합 — 당첨 시 공동당첨자가 적어 실수령 기대가 큽니다.';

  return { risk, evScore, grade, factors, summary };
}

export function sharingGradeLabel(grade: SharingGrade): string {
  return GRADE_LABEL[grade];
}

/**
 * 후보 풀에서 '상위 순위 유지 + 분산 최적'을 함께 만족하는 6개를 고른다.
 * 확률은 불변 — 순위(예측 근거)를 지키면서 공동당첨 위험만 낮추는 보정.
 *
 * @param rankedPool 예측 순위대로 정렬된 번호(상위가 앞). 최소 6개.
 * @param topWindow 상위 몇 개까지를 후보로 볼지(기본 12). 이 안에서 조합 탐색.
 * @returns 선택된 6개(정렬) + 분산 평가. 풀이 6 미만이면 null.
 */
export function optimizeForSharing(
  rankedPool: number[],
  topWindow = 12
): { numbers: number[]; assessment: SharingAssessment } | null {
  const pool = Array.from(new Set(rankedPool.filter((n) => n >= 1 && n <= 45)));
  if (pool.length < 6) return null;
  const window = pool.slice(0, Math.max(6, Math.min(topWindow, pool.length)));

  // 상위 window 안의 모든 6-조합을 평가해, (분산 위험↓, 그다음 순위합↓) 순으로 최적 선택.
  const rankIndex = new Map<number, number>();
  window.forEach((n, i) => rankIndex.set(n, i));
  let best: { numbers: number[]; assessment: SharingAssessment; rankSum: number } | null = null;

  const combo: number[] = [];
  const choose = (start: number) => {
    if (combo.length === 6) {
      const assessment = assessJackpotSharing(combo);
      const rankSum = combo.reduce((s, n) => s + (rankIndex.get(n) ?? 99), 0);
      if (
        best === null ||
        assessment.risk < best.assessment.risk ||
        (assessment.risk === best.assessment.risk && rankSum < best.rankSum)
      ) {
        best = { numbers: [...combo].sort((a, b) => a - b), assessment, rankSum };
      }
      return;
    }
    for (let i = start; i < window.length; i += 1) {
      combo.push(window[i]);
      choose(i + 1);
      combo.pop();
    }
  };
  choose(0);

  if (!best) return null;
  const chosen = best as { numbers: number[]; assessment: SharingAssessment; rankSum: number };
  return { numbers: chosen.numbers, assessment: chosen.assessment };
}
