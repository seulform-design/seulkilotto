"""표본 크기별 회차 기술 통계 + 균등성 검정.

윈도우: 전체 / 최근 100 / 50 / 30 / 10 회. 각 결과에 표본 크기(회차 수, 관측 번호 수)를
표기하고, 카이제곱 근사가 부정확한 소표본(기대도수<5)에서는 유의성을 주장하지 않는다.
윈도우×검정이 여러 개이므로 Bonferroni/BH 보정 결과를 함께 낸다.

통계 정의(재현 가능)
-------------------
- 빈도: 본번호만(보너스는 `bonus_frequency` 로 분리).
- 미출현 기간(gap): 윈도우 마지막 회차 기준, 그 번호가 마지막으로 나온 뒤 지난 회차 수.
  윈도우 안에서 한 번도 안 나왔으면 `None`(관측 불가 — 윈도우 길이 이상).
- 구간: 1-10, 11-20, 21-30, 31-40, 41-45.
- 저/고: 1-22 저, 23-45 고.
- 연속번호: 정렬 후 인접 차 1 인 쌍 수.

각 분포는 i.i.d. 균등 추첨 하의 이론 분포(초기하)와 비교한다 — '패턴'이 우연 이상인지 본다.
"""
from __future__ import annotations

from collections import Counter
from itertools import combinations
from math import comb
from typing import Any, Dict, List, Optional

from . import ENGINE_VERSION
from .cache import cached
from .draws import Draw, data_signature, load_draws
from .significance import benjamini_hochberg, chi_square_gof, expected_false_positives

ALGORITHM_VERSION = "window-stats-1.0"
DEFAULT_WINDOWS: List[Optional[int]] = [None, 100, 50, 30, 10]
DECADES = [(1, 10), (11, 20), (21, 30), (31, 40), (41, 45)]
TOTAL_COMBOS = comb(45, 6)


def _hyper_pmf(k: int, good: int, draws: int = 6, total: int = 45) -> float:
    """6개 추첨에서 'good' 개 집합 중 정확히 k 개가 나올 확률."""
    if k < 0 or k > draws or k > good or draws - k > total - good:
        return 0.0
    return comb(good, k) * comb(total - good, draws - k) / comb(total, draws)


def _consecutive_pmf(n: int = 45, k: int = 6) -> List[float]:
    """k개 무작위 추출 시 '인접 차 1 인 쌍 수 = j' 의 정확 확률.

    j 쌍이면 k-j 개의 연속 덩어리 → 덩어리 길이 구성 C(k-1, j) × 배치 C(n-k+1, k-j).
    (Vandermonde 로 Σ_j = C(n,k) — 테스트에서 검증)
    """
    total = comb(n, k)
    return [comb(k - 1, j) * comb(n - k + 1, k - j) / total for j in range(k)]


def _dist_test(observed_counts: List[int], pmf: List[float], n: int, label: str) -> Dict[str, Any]:
    """관측 분포 vs 이론 pmf — 기대도수<5 인 꼬리 칸은 합쳐서 근사 정확도를 지킨다."""
    obs = list(observed_counts)
    exp = [p * n for p in pmf]
    # 꼬리 병합(양끝에서 기대 5 미만 칸을 이웃에 합침).
    # ⚠️ `exp[-2] += exp.pop()` 처럼 쓰면 pop 이 인덱스를 밀어 엉뚱한 칸에 더해진다 —
    # 먼저 pop 한 값을 변수로 받은 뒤 더한다.
    while len(exp) > 2 and exp[-1] < 5:
        e, o = exp.pop(), obs.pop()
        exp[-1] += e
        obs[-1] += o
    while len(exp) > 2 and exp[0] < 5:
        e, o = exp.pop(0), obs.pop(0)
        exp[0] += e
        obs[0] += o
    test = chi_square_gof(obs, exp)
    return {
        "label": label,
        "observed": observed_counts,
        "expected": [round(p * n, 2) for p in pmf],
        "test": test,
    }


def window_stats(draws: List[Draw], window: Optional[int]) -> Dict[str, Any]:
    sub = draws if window is None else draws[-window:]
    n = len(sub)
    out: Dict[str, Any] = {
        "window": "all" if window is None else window,
        "sample_size": {"rounds": n, "main_numbers": 6 * n},
        "first_round": sub[0].round if sub else None,
        "last_round": sub[-1].round if sub else None,
    }
    if n == 0:
        out["ok"] = False
        out["reason"] = "회차 데이터가 없습니다."
        return out

    freq = [0] * 46
    bonus = [0] * 46
    last_idx = [None] * 46
    odd_dist = [0] * 7
    low_dist = [0] * 7
    decade_counts = [0] * 5
    consec_dist = [0] * 6
    sums: List[int] = []
    for i, d in enumerate(sub):
        for x in d.numbers:
            freq[x] += 1
            last_idx[x] = i
            decade_counts[min(4, (x - 1) // 10)] += 1
        bonus[d.bonus] += 1
        odd_dist[sum(1 for x in d.numbers if x % 2)] += 1
        low_dist[sum(1 for x in d.numbers if x <= 22)] += 1
        consec_dist[sum(1 for a, b in zip(d.numbers, d.numbers[1:]) if b - a == 1)] += 1
        sums.append(sum(d.numbers))

    expected_per_number = 6 * n / 45
    numbers = []
    for x in range(1, 46):
        gap = None if last_idx[x] is None else (n - 1 - last_idx[x])
        numbers.append({
            "number": x,
            "count": freq[x],
            "ratio": round(freq[x] / n, 4),
            "expected": round(expected_per_number, 3),
            "gap": gap,
            "bonus_count": bonus[x],
        })

    freq_test = chi_square_gof(freq[1:], [expected_per_number] * 45)
    decade_sizes = [b - a + 1 for a, b in DECADES]
    decade_test = chi_square_gof(decade_counts, [6 * n * s / 45 for s in decade_sizes])

    tests = {
        "number_uniformity": {"label": "번호별 빈도 균등성", "test": freq_test},
        "decade": {
            "label": "구간 분포",
            "observed": decade_counts,
            "expected": [round(6 * n * s / 45, 2) for s in decade_sizes],
            "test": decade_test,
        },
        "odd_even": _dist_test(odd_dist, [_hyper_pmf(k, 23) for k in range(7)], n, "홀수 개수 분포"),
        "low_high": _dist_test(low_dist, [_hyper_pmf(k, 22) for k in range(7)], n, "저번호(1-22) 개수 분포"),
        "consecutive": _dist_test(consec_dist, _consecutive_pmf(), n, "연속번호 쌍 수 분포"),
    }

    mean_sum = sum(sums) / n
    out.update({
        "ok": True,
        "numbers": numbers,
        "hot_top": sorted(range(1, 46), key=lambda x: (-freq[x], x))[:6],
        "cold_top": sorted(range(1, 46), key=lambda x: (freq[x], x))[:6],
        "sum": {"mean": round(mean_sum, 2), "theoretical_mean": 138.0,
                "min": min(sums), "max": max(sums)},
        "tests": tests,
        "bonus_total": sum(bonus),
    })
    return out


def _co_occurrence_test(draws: List[Draw]) -> Dict[str, Any]:
    """번호쌍 동시출현 — 각 쌍 기대 = n·C(43,4)/C(45,6). 최대 쌍이 다중비교 기준으로 이상한가."""
    from scipy.stats import binom

    n = len(draws)
    p_pair = comb(43, 4) / TOTAL_COMBOS  # = 6·5/(45·44)
    cnt = Counter()
    for d in draws:
        for a, b in combinations(d.numbers, 2):
            cnt[(a, b)] += 1
    n_pairs = comb(45, 2)
    top = sorted(cnt.items(), key=lambda kv: (-kv[1], kv[0]))[:10]
    mt = expected_false_positives(n_pairs, 0.05)
    items = []
    for (a, b), c in top:
        p = float(binom.sf(c - 1, n, p_pair))
        items.append({"pair": [a, b], "count": c, "expected": round(n * p_pair, 2),
                      "p_value": round(p, 6), "significant_bonferroni": p < mt["bonferroni_alpha"]})
    return {
        "sample_size": {"rounds": n, "pairs_tested": n_pairs},
        "expected_per_pair": round(n * p_pair, 3),
        "top_pairs": items,
        "multiple_testing": mt,
        "any_significant": any(i["significant_bonferroni"] for i in items),
        "note": "990개 쌍을 동시에 보면 가장 많이 나온 쌍은 우연으로도 기대보다 크다 — Bonferroni 기준으로만 판정.",
    }


def _compute(draws: List[Draw], windows: List[Optional[int]]) -> Dict[str, Any]:
    res = [window_stats(draws, w) for w in windows]
    # 전 윈도우 × 검정 다중비교 보정 (신뢰 가능한 검정만 집계)
    flat = []
    for r in res:
        for key, t in (r.get("tests") or {}).items():
            if t["test"]["reliable"]:
                flat.append((r["window"], key, t["test"]["p_value"]))
    mt = expected_false_positives(len(flat), 0.05)
    bh = benjamini_hochberg([p for _, _, p in flat], 0.05)
    corrected = [
        {"window": w, "test": k, "p_value": p,
         "bonferroni_significant": p < mt["bonferroni_alpha"], "bh_significant": rej}
        for (w, k, p), rej in zip(flat, bh)
    ]
    any_sig = any(c["bonferroni_significant"] or c["bh_significant"] for c in corrected)
    return {
        "ok": bool(draws),
        "latest_round": draws[-1].round if draws else None,
        "total_rounds": len(draws),
        "windows": res,
        "co_occurrence": _co_occurrence_test(draws) if draws else None,
        "multiple_testing": {**mt, "corrected": corrected, "any_significant": any_sig},
        "verdict": (
            "다중비교 보정 후 균등 추첨에서 벗어난 분포가 있습니다 — 데이터 오류 여부를 먼저 확인하세요."
            if any_sig else
            "모든 윈도우·분포 검정이 다중비교 보정 후 균등 무작위 추첨과 구분되지 않습니다. "
            "핫/콜드·미출·구간·홀짝 편차는 표본 변동(우연) 범위입니다."
        ),
        "small_sample_policy": "기대도수 5 미만인 검정(예: 최근 10회 번호 빈도)은 reliable=false 로 표시하고 유의성을 주장하지 않습니다.",
        "algorithm_version": ALGORITHM_VERSION,
        "engine_version": ENGINE_VERSION,
    }


def build_window_stats(windows: Optional[List[Optional[int]]] = None,
                       draws: Optional[List[Draw]] = None) -> Dict[str, Any]:
    windows = list(DEFAULT_WINDOWS if windows is None else windows)
    if draws is not None:
        return _compute(draws, windows)
    draws = load_draws()
    sig = data_signature(draws)
    out = dict(cached("window_stats", sig, tuple(windows), lambda: _compute(draws, windows)))
    out["data_signature"] = sig
    return out
