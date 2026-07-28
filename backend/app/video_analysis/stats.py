"""공용 통계 유의성 헬퍼 — 학습·백테스트 엔진이 lift 를 과신하지 않도록 p값·신뢰구간·
소표본 플래그를 일관되게 붙인다.

⚠️ 로또는 i.i.d. — 이 헬퍼는 확률을 올리지 않는다. '관측이 무작위 기준선을 우연 이상으로
초과하는지'만 정직하게 검정하고, 표본이 작으면(소표본) 유의해 보여도 우연일 수 있음을 명시
(significant 를 보수적으로 억제)한다. scipy 없이 정규근사(math.erfc)로 계산한다.
"""
from __future__ import annotations

import math
from typing import Any, Dict

SMALL_SAMPLE_N = 5  # 독립 시행(회차·전이)이 이 미만이면 소표본 경고


def normal_sf(z: float) -> float:
    """표준정규 상측 꼬리 P(Z >= z)."""
    return 0.5 * math.erfc(z / math.sqrt(2.0))


def binomial_significance(
    hits: float, trials: int, p0: float, *, small_n: int = SMALL_SAMPLE_N
) -> Dict[str, Any]:
    """관측 hits/trials 가 무작위 기준확률 p0 를 유의하게 초과하나 — 이항 정규근사.

    trials = 독립 시도 수(예: 이월 후보 개수 합, 회차 수 등), p0 = 그 시도가 '적중'일
    무작위 기준확률(예: 번호가 다음 당첨 6개에 속할 확률 6/45). 소표본(trials<small_n)이면
    유의(p<0.05)여도 significant 를 False 로 억제한다(우연 가능 — 정직).
    """
    if trials <= 0 or not (0.0 < p0 < 1.0):
        return {
            "hits": int(max(0, round(hits))), "trials": int(max(0, trials)), "expected": 0.0,
            "rate": 0.0, "ci95": [0.0, 0.0], "z": 0.0, "p_value": 1.0, "lift": 0.0,
            "significant": False, "small_sample": True,
        }
    expected = trials * p0
    var = trials * p0 * (1.0 - p0)
    sd = math.sqrt(var) if var > 0 else 0.0
    z = (hits - expected) / sd if sd > 0 else 0.0
    p_value = normal_sf(z)
    rate = hits / trials
    ci_half = 1.96 * math.sqrt(max(0.0, rate * (1.0 - rate) / trials))
    small = trials < small_n
    return {
        "hits": int(round(hits)),
        "trials": int(trials),
        "expected": round(expected, 3),
        "rate": round(rate, 4),
        "ci95": [round(max(0.0, rate - ci_half), 4), round(min(1.0, rate + ci_half), 4)],
        "z": round(z, 3),
        "p_value": round(p_value, 4),
        "lift": round(hits / expected, 3) if expected > 0 else 0.0,
        "significant": bool(p_value < 0.05 and hits > expected and not small),
        "small_sample": small,
    }


def expected_false_positives(n_tested: int, alpha: float = 0.05) -> Dict[str, Any]:
    """다중검정 맥락 — N 개 패턴을 α 로 검정하면 순수 우연으로도 평균 N×α 개가 '유의'해 보인다.

    관측된 유의 패턴 수가 이 기대 오탐을 넘지 못하면 신호로 보기 어렵다(Bonferroni/FDR 감각).
    """
    n = max(0, int(n_tested))
    exp_fp = round(n * alpha, 2)
    # Bonferroni 보정 임계 — 개별 패턴을 이 값 이하 p 로 요구하면 family-wise 오탐 α 이하.
    bonferroni_alpha = round(alpha / n, 5) if n > 0 else alpha
    return {
        "n_tested": n,
        "alpha": alpha,
        "expected_false_positives": exp_fp,
        "bonferroni_alpha": bonferroni_alpha,
    }
