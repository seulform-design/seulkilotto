"""로또 6/45 수학적 확률 — 시스템의 기준값(ground truth).

이 모듈의 수치는 '계산된 확률'이다. 과거 적중률·백테스트·통계 추정치·공동선택 회피
점수·기대수령액 추정과 절대 섞지 않는다(응답에서 `kind="mathematical"` 로 구분).

- 전체 조합 수 C(45,6) = 8,145,060
- 단일 조합 1등 확률 = 1/8,145,060
- 서로 다른 조합 n장 = n/8,145,060 (같은 회차에서 1등 사건은 서로 배타적이므로 정확히 합)
  → 중복 조합은 1장으로 센다(같은 번호를 두 장 사도 1등 확률은 늘지 않는다).
- 등수별 확률(본번호 k개 일치, 2등은 5개+보너스) — 초기하 분포.
"""
from __future__ import annotations

from fractions import Fraction
from math import comb
from typing import Any, Dict, Iterable, List, Sequence, Tuple

N_BALLS = 45
N_PICK = 6
TOTAL_COMBINATIONS = comb(N_BALLS, N_PICK)  # 8,145,060
assert TOTAL_COMBINATIONS == 8_145_060

KIND = "mathematical"


def validate_ticket(numbers: Sequence[int]) -> Tuple[int, ...]:
    """유효한 6/45 조합이면 정렬 튜플, 아니면 ValueError (6개·1~45·중복 없음)."""
    try:
        nums = [int(n) for n in numbers]
    except (TypeError, ValueError) as exc:
        raise ValueError(f"정수가 아닌 번호: {numbers!r}") from exc
    if len(nums) != N_PICK:
        raise ValueError(f"번호는 정확히 6개여야 합니다(받은 개수 {len(nums)}).")
    if not all(1 <= n <= N_BALLS for n in nums):
        raise ValueError(f"번호는 1~45 범위여야 합니다: {nums}")
    if len(set(nums)) != N_PICK:
        raise ValueError(f"번호가 중복됐습니다: {nums}")
    return tuple(sorted(nums))


def match_count(ticket: Iterable[int], winning: Iterable[int]) -> int:
    """본번호 일치 개수(보너스 제외)."""
    return len(set(int(x) for x in ticket) & set(int(x) for x in winning))


def prize_rank(ticket: Sequence[int], winning: Sequence[int], bonus: int) -> int | None:
    """동행복권 등수: 1등 6개 / 2등 5개+보너스 / 3등 5개 / 4등 4개 / 5등 3개 / 그 외 None.

    보너스는 '5개 일치'일 때 2·3등을 가르는 데에만 쓰인다(본번호 일치 수에 더하지 않는다)."""
    m = match_count(ticket, winning)
    if m == 6:
        return 1
    if m == 5:
        return 2 if int(bonus) in set(int(x) for x in ticket) else 3
    if m == 4:
        return 4
    if m == 3:
        return 5
    return None


def match_pmf() -> List[Fraction]:
    """단일 조합의 본번호 일치 개수 k=0..6 의 정확 확률(초기하)."""
    return [Fraction(comb(6, k) * comb(39, 6 - k), TOTAL_COMBINATIONS) for k in range(7)]


def prize_probabilities() -> Dict[str, Fraction]:
    """등수별 정확 확률 (단일 조합)."""
    return {
        "1": Fraction(1, TOTAL_COMBINATIONS),
        "2": Fraction(comb(6, 5) * 1, TOTAL_COMBINATIONS),          # 5개 + 보너스
        "3": Fraction(comb(6, 5) * (39 - 1), TOTAL_COMBINATIONS),   # 5개, 보너스 불일치
        "4": Fraction(comb(6, 4) * comb(39, 2), TOTAL_COMBINATIONS),
        "5": Fraction(comb(6, 3) * comb(39, 3), TOTAL_COMBINATIONS),
    }


def jackpot_probability(n_distinct: int) -> Fraction:
    """서로 다른 조합 n장의 1등 확률 = n / 8,145,060 (0 ≤ n ≤ 8,145,060)."""
    n = int(n_distinct)
    if n < 0 or n > TOTAL_COMBINATIONS:
        raise ValueError(f"n 은 0~{TOTAL_COMBINATIONS} 이어야 합니다(받은 값 {n}).")
    return Fraction(n, TOTAL_COMBINATIONS)


def tickets_probability(tickets: Sequence[Sequence[int]]) -> Dict[str, Any]:
    """여러 장 구매 시 1등 확률 — 중복 조합 제거 후 n_distinct/8,145,060."""
    valid: List[Tuple[int, ...]] = []
    invalid: List[Dict[str, Any]] = []
    for i, t in enumerate(tickets):
        try:
            valid.append(validate_ticket(t))
        except ValueError as exc:
            invalid.append({"index": i, "numbers": list(t) if isinstance(t, (list, tuple)) else t,
                            "error": str(exc)})
    distinct = sorted(set(valid))
    p = jackpot_probability(len(distinct))
    return {
        "kind": KIND,
        "tickets_submitted": len(tickets),
        "valid_tickets": len(valid),
        "invalid_tickets": invalid,
        "duplicate_tickets_removed": len(valid) - len(distinct),
        "distinct_tickets": len(distinct),
        "jackpot_probability": fmt_fraction(p),
        "jackpot_probability_float": float(p),
        "one_in": (round(TOTAL_COMBINATIONS / len(distinct), 2) if distinct else None),
        "note": "같은 조합을 여러 장 사도 1등 확률은 1장과 같습니다 — 중복은 1장으로 셉니다.",
    }


def fmt_fraction(p: Fraction) -> str:
    """확률 표기 — 항상 'n/8,145,060' (n 장 = n/8,145,060 이 바로 보이도록 약분하지 않음)."""
    if p == 0:
        return "0"
    scaled = p * TOTAL_COMBINATIONS
    if scaled.denominator == 1:
        return f"{scaled.numerator:,}/{TOTAL_COMBINATIONS:,}"
    return f"{p.numerator:,}/{p.denominator:,}"


def summary(n: int = 1) -> Dict[str, Any]:
    pmf = match_pmf()
    prizes = prize_probabilities()
    return {
        "kind": KIND,
        "total_combinations": TOTAL_COMBINATIONS,
        "formula": "C(45,6) = 45!/(6!·39!)",
        "single_ticket_jackpot": fmt_fraction(Fraction(1, TOTAL_COMBINATIONS)),
        "n_distinct_tickets": n,
        "n_tickets_jackpot": fmt_fraction(jackpot_probability(n)),
        "n_tickets_jackpot_float": float(jackpot_probability(n)),
        "match_distribution": [
            {"matches": k, "probability": float(pmf[k]),
             "exact": f"{pmf[k].numerator * (TOTAL_COMBINATIONS // pmf[k].denominator):,}/{TOTAL_COMBINATIONS:,}"}
            for k in range(7)
        ],
        "expected_matches_per_ticket": float(sum(k * pmf[k] for k in range(7))),  # 0.8
        "prize_probabilities": {
            r: {"probability": float(v), "one_in": round(1 / float(v), 2),
                "exact": f"{v.numerator * (TOTAL_COMBINATIONS // v.denominator):,}/{TOTAL_COMBINATIONS:,}"}
            for r, v in prizes.items()
        },
        "separation": (
            "이 값은 수학적으로 계산된 확률입니다. 과거 적중률·백테스트·통계 추정치·공동선택 "
            "회피 점수·기대수령액 추정과 다른 종류의 수치이며 어떤 분석으로도 바뀌지 않습니다."
        ),
    }
