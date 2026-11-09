"""공동선택(공동당첨) 회피 점수 — 당첨 '확률'이 아니라 당첨 시 '기대수령액' 지표.

⚠️ 공정한 추첨에서 모든 6-조합의 1등 확률은 1/8,145,060 로 동일하다. 이 모듈은 그
확률을 바꾸지 않는다. 1등은 공동당첨자끼리 나누므로, 다른 구매자가 많이 고를 법한
조합을 피하면 '당첨됐을 때' 분배 인원의 기대값이 줄어 실수령 기대가 커진다.

⚠️ 실제 구매자 선택 데이터는 없다. 점수는 공개 연구·관행으로 알려진 선택 편향
(생일 1~31·월 1~12 편중, 연속열, 등차/규칙 수열, 5의 배수, 같은 끝자리)에 기반한
**휴리스틱 추정치**이며 공동당첨자 수를 예측하지 않는다(`estimate_basis` 로 명시).

프론트 `utils/jackpotSharing.ts` 와 동일한 규칙(가중치)을 사용한다.
"""
from __future__ import annotations

from itertools import combinations
from typing import Any, Dict, List, Sequence

ALGORITHM_VERSION = "coselection-1.0"
ESTIMATE_BASIS = (
    "추정치 — 실제 구매자 선택 데이터 없음. 알려진 선택 편향(생일·월 숫자, 연속열, 등차수열, "
    "5의 배수, 같은 끝자리)에 근거한 휴리스틱."
)


def _longest_run(s: Sequence[int]) -> int:
    best = run = 1
    for a, b in zip(s, s[1:]):
        run = run + 1 if b == a + 1 else 1
        best = max(best, run)
    return best if s else 0


def _arithmeticish(s: Sequence[int]) -> bool:
    diffs = [b - a for a, b in zip(s, s[1:])]
    return max((diffs.count(d) for d in set(diffs)), default=0) >= 4


def assess(numbers: Sequence[int]) -> Dict[str, Any]:
    """조합의 '인기도 위험'(0~100, 높을수록 남들과 겹칠 위험↑) + 회피 점수(=100-risk)."""
    valid = sorted({int(n) for n in numbers if 1 <= int(n) <= 45})
    if len(valid) != 6:
        return {"risk": 50, "avoidance_score": 50, "grade": "fair", "factors": [],
                "estimate_basis": ESTIMATE_BASIS}
    s = valid
    risk = 40.0
    factors: List[Dict[str, Any]] = []

    def add(key: str, label: str, delta: float) -> None:
        nonlocal risk
        if delta:
            risk += delta
            factors.append({"key": key, "label": label, "delta": delta})

    le31 = sum(1 for n in s if n <= 31)
    if le31 >= 5:
        add("low_bias", "저번호(1~31) 편중 — 생일 조합과 겹침", (le31 - 4) * 8 + (14 if le31 == 6 else 0))
    elif le31 <= 3:
        add("high_usage", "고번호(32~45) 활용", -(4 - le31) * 7)
    le12 = sum(1 for n in s if n <= 12)
    if le12 >= 4:
        add("month_bias", "초저번호(1~12) 편중", (le12 - 3) * 6)
    run = _longest_run(s)
    if run >= 3:
        add("consecutive", f"{run}연속 번호", (run - 2) * 7)
    if _arithmeticish(s):
        add("arithmetic", "등차/규칙 수열", 12)
    m5 = sum(1 for n in s if n % 5 == 0)
    if m5 >= 4:
        add("mult5", "5의 배수 편중", (m5 - 3) * 6)
    if len({n % 10 for n in s}) <= 2:
        add("same_last_digit", "끝자리 편중(대칭 패턴)", 8)
    odd = sum(1 for n in s if n % 2)
    if odd in (0, 6):
        add("parity_extreme", "전부 홀/짝 — 희소", -8)
    if le31 == 0:
        add("all_high", "전부 고번호 — 희소", -12)
    total = sum(s)
    if total < 90 or total > 185:
        add("sum_extreme", "합계 극단 — 희소", -6)

    r = int(max(0, min(100, round(risk))))
    grade = "excellent" if r < 30 else "good" if r < 45 else "fair" if r < 62 else "poor"
    return {"risk": r, "avoidance_score": 100 - r, "grade": grade, "factors": factors,
            "estimate_basis": ESTIMATE_BASIS}


def diversity(sets: Sequence[Sequence[int]]) -> Dict[str, Any]:
    """추천 세트 간 다양성 — 쌍별 평균 공유 번호 수(낮을수록 다양), 고유 번호 커버리지."""
    sets = [sorted(set(x)) for x in sets if x]
    if len(sets) < 2:
        return {"sets": len(sets), "mean_shared": 0.0, "max_shared": 0,
                "unique_numbers": len({n for x in sets for n in x}), "coverage_ratio": 0.0}
    shared = [len(set(a) & set(b)) for a, b in combinations(sets, 2)]
    uniq = {n for x in sets for n in x}
    return {
        "sets": len(sets),
        "mean_shared": round(sum(shared) / len(shared), 3),
        "max_shared": max(shared),
        # 서로 독립인 무작위 6-조합 두 개의 기대 공유 수 = 36/45 = 0.8
        "random_expected_shared": 0.8,
        "unique_numbers": len(uniq),
        "coverage_ratio": round(len(uniq) / 45, 3),
    }
