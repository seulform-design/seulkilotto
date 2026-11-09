"""공용 통계 유의성 헬퍼 — 회차 통계/백테스트/복기 엔진이 공유한다.

원래 `video_analysis.review_verification._coverage_significance` 와
`video_analysis.stats` 에 있던 구현을 용지 모듈과 분리해 이곳으로 옮겼다. 기존 모듈은
하위 호환을 위해 이 구현을 그대로 재노출한다(출력 스키마·수치 동일).

⚠️ 이 헬퍼는 확률을 올리지 않는다. '관측이 무작위 기준선을 우연 이상으로 초과하는지'만
검정하고, 소표본이면 유의해 보여도 significant 를 억제한다.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Sequence

SMALL_SAMPLE_ROUNDS = 5  # 독립 회차가 이 미만이면 소표본 경고
SMALL_SAMPLE_N = 5

N_BALLS = 45
N_DRAWN = 6
P_BALL = N_DRAWN / N_BALLS  # 한 번호가 한 회차 당첨 6개에 포함될 확률


def normal_sf(z: float) -> float:
    """표준정규 상측 꼬리 P(Z >= z)."""
    return 0.5 * math.erfc(z / math.sqrt(2.0))


def coverage_significance(total_hits: float, rounds: int, k: int) -> Dict[str, Any]:
    """상위 K 커버리지가 균등무작위를 유의하게 초과하나 — 회차별 초기하 합의 정규근사.

    H0: 상위 K 는 무작위 K-부분집합. 한 회차 적중수 ~ Hypergeometric(N=45, 당첨=6, 추출=K),
    평균 K·6/45, 분산 K·(6/45)(39/45)((45-K)/44). 회차 독립 합산 후 z, 상측 p값.
    """
    if rounds <= 0 or k <= 0 or k >= N_BALLS:
        return {"total_hits": int(total_hits), "expected": 0.0, "z": 0.0, "p_value": 1.0,
                "lift": 0.0, "significant": False, "small_sample": True}
    p = P_BALL
    exp_per = k * p
    var_per = k * p * (1.0 - p) * ((N_BALLS - k) / (N_BALLS - 1.0))
    expected = rounds * exp_per
    variance = rounds * var_per
    sd = math.sqrt(variance) if variance > 0 else 0.0
    z = (total_hits - expected) / sd if sd > 0 else 0.0
    p_value = normal_sf(z)
    mean_hit = total_hits / rounds
    ci_half = 1.96 * math.sqrt(var_per / rounds) if var_per > 0 else 0.0
    small = rounds < SMALL_SAMPLE_ROUNDS
    return {
        "total_hits": int(round(total_hits)),
        "expected": round(expected, 3),
        "mean_hit": round(mean_hit, 3),
        "ci95": [round(max(0.0, mean_hit - ci_half), 3), round(mean_hit + ci_half, 3)],
        "z": round(z, 3),
        "p_value": round(p_value, 4),
        "lift": round(total_hits / expected, 3) if expected > 0 else 0.0,
        "significant": bool(p_value < 0.05 and total_hits > expected and not small),
        "small_sample": small,
    }


def binomial_significance(
    hits: float, trials: int, p0: float, *, small_n: int = SMALL_SAMPLE_N
) -> Dict[str, Any]:
    """관측 hits/trials 가 기준확률 p0 를 유의하게 초과하나 — 이항 정규근사."""
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
    """N 개 검정을 α 로 하면 우연으로도 평균 N×α 개가 '유의' — Bonferroni 임계 포함."""
    n = max(0, int(n_tested))
    return {
        "n_tested": n,
        "alpha": alpha,
        "expected_false_positives": round(n * alpha, 2),
        "bonferroni_alpha": round(alpha / n, 5) if n > 0 else alpha,
    }


def benjamini_hochberg(p_values: Sequence[float], alpha: float = 0.05) -> List[bool]:
    """BH FDR 보정 — 각 검정의 기각 여부(입력 순서 유지)."""
    m = len(p_values)
    if m == 0:
        return []
    order = sorted(range(m), key=lambda i: p_values[i])
    max_rank = 0
    for rank, i in enumerate(order, start=1):
        if p_values[i] <= alpha * rank / m:
            max_rank = rank
    rejected = [False] * m
    for rank, i in enumerate(order, start=1):
        if rank <= max_rank:
            rejected[i] = True
    return rejected


def chi_square_gof(observed: Sequence[float], expected: Sequence[float]) -> Dict[str, Any]:
    """카이제곱 적합도 검정 + 효과크기(Cohen's w).

    기대도수 최솟값이 5 미만이면 근사가 부정확하므로 `reliable=False` 로 표시하고
    유의성을 주장하지 않는다(significant=False 강제).
    """
    from scipy.stats import chi2 as _chi2

    obs = [float(x) for x in observed]
    exp = [float(x) for x in expected]
    if len(obs) != len(exp) or len(obs) < 2:
        raise ValueError("observed/expected 길이 불일치")
    total = sum(obs)
    pairs = [(o, e) for o, e in zip(obs, exp) if e > 0]
    stat = sum((o - e) ** 2 / e for o, e in pairs)
    dof = len(pairs) - 1
    p_value = float(_chi2.sf(stat, dof)) if dof > 0 else 1.0
    min_expected = min(exp) if exp else 0.0
    reliable = min_expected >= 5.0
    effect_w = math.sqrt(stat / total) if total > 0 else 0.0
    return {
        "statistic": round(stat, 4),
        "dof": dof,
        "p_value": round(p_value, 6),
        "min_expected": round(min_expected, 3),
        "reliable": reliable,
        "effect_size_w": round(effect_w, 4),
        # Cohen 기준: w<0.1 무시 가능 / 0.1 소 / 0.3 중 / 0.5 대
        "effect_label": ("negligible" if effect_w < 0.1 else "small" if effect_w < 0.3
                         else "medium" if effect_w < 0.5 else "large"),
        "significant": bool(reliable and p_value < 0.05),
    }


def wilson_interval(successes: float, n: int, z: float = 1.96) -> List[float]:
    """이항 비율의 Wilson 95% 신뢰구간 — 소표본에서도 [0,1] 안에 머문다."""
    if n <= 0:
        return [0.0, 1.0]
    phat = successes / n
    denom = 1 + z * z / n
    centre = (phat + z * z / (2 * n)) / denom
    half = z * math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n)) / denom
    return [round(max(0.0, centre - half), 4), round(min(1.0, centre + half), 4)]
