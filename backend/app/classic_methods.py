"""윌슨·가우스·호이겐스·페르마 패턴 분석 및 추천 (Pandas).

각 '법'은 역사적 수학 개념을 로또 통계 휴리스틱에 매핑한 것입니다.
(당첨 확률 자체를 높이지는 않으며, 과거 데이터 기반 조합 생성 규칙입니다.)

- 윌슨법   : Wilson score 하한 — 출현 비율의 보수적 신뢰 순위
- 가우스법 : 총합·홀짝의 정규분포(μ, σ) — 평균 근처 조합
- 호이겐스법: 기대 미출현 간격 대비 실제 gap — '나올 때 된' 번호 가중
- 페르마법  : 2개 번호 동시출현(조합론) — 궁합 쌍 기반 조립
"""
from __future__ import annotations

import math
import random
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from .database import NUMBER_COLUMNS

ALL_NUMBERS = list(range(1, 46))
SUM_MIN, SUM_MAX = 100, 175
VALID_ODD = {2, 3, 4}
Z_WILSON = 1.96  # 95% 신뢰구간
PRIMES = {2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43}
MAX_ATTEMPTS = 3000

METHOD_IDS = ("wilson", "gauss", "huygens", "fermat", "blend")


def _flat_counts(df: pd.DataFrame) -> Dict[int, int]:
    flat = df[NUMBER_COLUMNS].to_numpy().ravel()
    vc = pd.Series(flat).value_counts()
    return {n: int(vc.get(n, 0)) for n in ALL_NUMBERS}


def _gap_map(df: pd.DataFrame) -> Dict[int, int]:
    """각 번호의 현재 미출현 회차 수. gap_utils 단일 소스로 통일."""
    from .gap_utils import last_seen_gaps

    return last_seen_gaps(df)


def wilson_lower_bound(successes: int, trials: int, z: float = Z_WILSON) -> float:
    """이항 비율의 Wilson score 신뢰구간 하한."""
    if trials <= 0:
        return 0.0
    p = successes / trials
    z2 = z * z
    denom = 1.0 + z2 / trials
    centre = p + z2 / (2 * trials)
    margin = z * math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)
    return max(0.0, (centre - margin) / denom)


def analyze_wilson(df: pd.DataFrame, recent_n: Optional[int] = None) -> Dict:
    """윌슨법: 회차당 1회 출현 시행에서 Wilson 하한이 높은 번호 = 안정적 출현."""
    target = df.sort_values("round", ascending=False).head(recent_n) if recent_n else df
    trials = len(target)
    counts = _flat_counts(target)
    scored = [
        {
            "number": n,
            "count": counts[n],
            "wilson_lower": round(wilson_lower_bound(counts[n], trials), 4),
        }
        for n in ALL_NUMBERS
    ]
    scored.sort(key=lambda x: (-x["wilson_lower"], -x["count"], x["number"]))
    weight_map = {s["number"]: s["wilson_lower"] + 1e-6 for s in scored}
    return {
        "method": "wilson",
        "label": "윌슨법",
        "description": "출현 비율 Wilson 하한(95%) — 보수적 고신뢰 번호",
        "trials": trials,
        "top10": scored[:10],
        "_weights": np.array([weight_map[n] for n in ALL_NUMBERS], dtype=float),
    }


def analyze_gauss(df: pd.DataFrame, recent_n: Optional[int] = None) -> Dict:
    """가우스법: 당첨 6개 번호 총합·홀수 개수의 μ, σ — 정규분포 밴드."""
    target = df.sort_values("round", ascending=False).head(recent_n) if recent_n else df
    sums: List[int] = []
    odds: List[int] = []
    for _, row in target.iterrows():
        nums = [int(row[c]) for c in NUMBER_COLUMNS]
        sums.append(sum(nums))
        odds.append(sum(1 for n in nums if n % 2 == 1))
    mu_s = float(np.mean(sums))
    sigma_s = float(np.std(sums)) or 15.0
    mu_o = float(np.mean(odds))
    sigma_o = float(np.std(odds)) or 1.0
    return {
        "method": "gauss",
        "label": "가우스법",
        "description": "총합·홀짝 정규분포 — 역사 평균(μ)±σ 밴드 조합",
        "sum_mean": round(mu_s, 1),
        "sum_std": round(sigma_s, 1),
        "sum_band": [max(SUM_MIN, int(mu_s - sigma_s)), min(SUM_MAX, int(mu_s + sigma_s))],
        "odd_mean": round(mu_o, 2),
        "odd_std": round(sigma_o, 2),
        "_mu_s": mu_s,
        "_sigma_s": sigma_s,
        "_mu_o": mu_o,
        "_sigma_o": sigma_o,
        "_freq": _flat_counts(target),
    }


def analyze_huygens(df: pd.DataFrame) -> Dict:
    """호이겐스법: 기대 gap ≈ (45/6)-1 회차, 실제 gap이 기대 이상이면 가중."""
    gaps = _gap_map(df)
    # 한 회차에 6/45 확률로 등장 → 기대 간격 약 7.5회 (단순 모델)
    expected_gap = 45.0 / 6.0
    scored = []
    for n in ALL_NUMBERS:
        g = gaps[n]
        ratio = g / expected_gap if expected_gap else 1.0
        scored.append(
            {
                "number": n,
                "gap_rounds": g,
                "expected_gap": round(expected_gap, 2),
                "overdue_ratio": round(ratio, 2),
            }
        )
    scored.sort(key=lambda x: (-x["overdue_ratio"], -x["gap_rounds"], x["number"]))
    weight_map = {s["number"]: max(0.1, s["overdue_ratio"]) for s in scored}
    return {
        "method": "huygens",
        "label": "호이겐스법",
        "description": "기대 미출현 간격 대비 실제 gap — 기대값 회귀 가중",
        "expected_gap": round(expected_gap, 2),
        "top10": scored[:10],
        "_weights": np.array([weight_map[n] for n in ALL_NUMBERS], dtype=float),
        "_gaps": gaps,
    }


def analyze_fermat(df: pd.DataFrame, recent_n: Optional[int] = None) -> Dict:
    """페르마법: 2번호 동시출현(조합) 빈도 + 소수(페르마 수론 연계) 보조."""
    from itertools import combinations

    target = df.sort_values("round", ascending=False).head(recent_n) if recent_n else df
    pair_count: Dict[Tuple[int, int], int] = {}
    prime_hits = 0
    for _, row in target.iterrows():
        nums = sorted(int(row[c]) for c in NUMBER_COLUMNS)
        prime_hits += sum(1 for n in nums if n in PRIMES)
        for pair in combinations(nums, 2):
            pair_count[pair] = pair_count.get(pair, 0) + 1
    top_pairs = sorted(pair_count.items(), key=lambda x: (-x[1], x[0]))[:10]
    return {
        "method": "fermat",
        "label": "페르마법",
        "description": "2번호 동시출현(조합론) + 소수 편향 보조",
        "top_pairs": [{"pair": [a, b], "count": c} for (a, b), c in top_pairs[:5]],
        "avg_primes_per_draw": round(prime_hits / max(len(target), 1), 2),
        "_pairs": [p for p, _ in top_pairs[:15]],
        "_pair_scores": pair_count,
    }


def _public_analysis(analysis: Dict) -> Dict:
    """API 응답용 — 내부 numpy 배열(_weights 등) 제거."""
    return {k: v for k, v in analysis.items() if not k.startswith("_")}


def analyze_all_classic(df: pd.DataFrame, recent_n: Optional[int] = None) -> Dict[str, Dict]:
    """네 가지 패턴 분석 요약."""
    return {
        "wilson": analyze_wilson(df, recent_n),
        "gauss": analyze_gauss(df, recent_n),
        "huygens": analyze_huygens(df),
        "fermat": analyze_fermat(df, recent_n),
    }


def _is_valid(nums: Sequence[int], strict_sum: bool = True) -> bool:
    if len(nums) != 6 or len(set(nums)) != 6:
        return False
    if not all(1 <= n <= 45 for n in nums):
        return False
    s = sum(nums)
    if strict_sum and (s < SUM_MIN or s > SUM_MAX):
        return False
    odd = sum(1 for n in nums if n % 2 == 1)
    return odd in VALID_ODD


def _combo_dict(nums: List[int]) -> Dict:
    return {
        "numbers": nums,
        "sum_total": sum(nums),
        "odd_count": sum(1 for n in nums if n % 2 == 1),
        "even_count": sum(1 for n in nums if n % 2 == 0),
    }


def _weighted_sample_six(weights: np.ndarray, rng: random.Random) -> List[int]:
    """비복원 가중 추출 6개."""
    pool = ALL_NUMBERS.copy()
    chosen: List[int] = []
    w = weights.astype(float).copy()
    for _ in range(6):
        sub = np.array([w[n - 1] for n in pool], dtype=float)
        sub = sub / sub.sum()
        pick = rng.choices(pool, weights=sub.tolist(), k=1)[0]
        chosen.append(pick)
        pool.remove(pick)
    return sorted(chosen)


def generate_wilson_combo(analysis: Dict, rng: random.Random) -> Optional[List[int]]:
    p = analysis["_weights"] / analysis["_weights"].sum()
    for _ in range(300):
        nums = _weighted_sample_six(p, rng)
        if _is_valid(nums):
            return nums
        if _is_valid(nums, strict_sum=False):
            return nums
    return None


def generate_gauss_combo(analysis: Dict, rng: random.Random) -> Optional[List[int]]:
    mu_s, sigma_s = analysis["_mu_s"], analysis["_sigma_s"]
    mu_o = analysis["_mu_o"]
    freq = analysis["_freq"]
    weights = np.array([freq.get(n, 0) + 1.0 for n in ALL_NUMBERS], dtype=float)
    weights = weights / weights.sum()
    for _ in range(MAX_ATTEMPTS):
        target_sum = int(round(rng.gauss(mu_s, sigma_s * 0.45)))
        target_sum = max(SUM_MIN, min(SUM_MAX, target_sum))
        target_odd = max(2, min(4, int(round(rng.gauss(mu_o, 0.8)))))
        nums = _weighted_sample_six(weights, rng)
        if abs(sum(nums) - target_sum) <= 20 and sum(1 for n in nums if n % 2 == 1) == target_odd:
            if _is_valid(nums):
                return nums
        if _is_valid(nums, strict_sum=False):
            return nums
    return None


def generate_huygens_combo(analysis: Dict, rng: random.Random) -> Optional[List[int]]:
    w = analysis["_weights"] / analysis["_weights"].sum()
    for _ in range(300):
        nums = _weighted_sample_six(w, rng)
        if _is_valid(nums):
            return nums
        if _is_valid(nums, strict_sum=False):
            return nums
    return None


def generate_fermat_combo(analysis: Dict, rng: random.Random) -> Optional[List[int]]:
    pairs = analysis.get("_pairs") or []
    if not pairs:
        return None
    for _ in range(300):
        a, b = rng.choice(pairs)
        chosen = {a, b}
        # 소수 1~2개 보조
        prime_pool = [p for p in PRIMES if p not in chosen]
        if prime_pool and rng.random() < 0.6:
            chosen.add(rng.choice(prime_pool))
        pool = [n for n in ALL_NUMBERS if n not in chosen]
        rng.shuffle(pool)
        for n in pool:
            if len(chosen) >= 6:
                break
            chosen.add(n)
        if len(chosen) != 6:
            continue
        nums = sorted(chosen)
        if _is_valid(nums):
            return nums
    return None


def generate_by_method(
    df: pd.DataFrame,
    method: str,
    seed: Optional[int] = None,
) -> Tuple[Optional[List[int]], Dict]:
    """단일 방법으로 1조합 생성 + 분석 메타."""
    rng = random.Random(seed)
    analyses = analyze_all_classic(df)
    m = method.lower()
    if m not in analyses:
        m = "wilson"
    meta = {k: v for k, v in analyses[m].items() if not k.startswith("_")}

    generators = {
        "wilson": generate_wilson_combo,
        "gauss": generate_gauss_combo,
        "huygens": generate_huygens_combo,
        "fermat": generate_fermat_combo,
    }
    combo = generators[m](analyses[m], rng)
    return combo, meta


def generate_blend_sets(
    df: pd.DataFrame,
    seed: Optional[int] = None,
    n_games: int = 5,
) -> Tuple[List[Dict], Dict[str, Dict]]:
    """윌슨·가우스·호이겐스·페르마 각 1게임 + (선택) 추가."""
    rng = random.Random(seed)
    analyses = analyze_all_classic(df)
    order = ["wilson", "gauss", "huygens", "fermat"]
    gens = {
        "wilson": generate_wilson_combo,
        "gauss": generate_gauss_combo,
        "huygens": generate_huygens_combo,
        "fermat": generate_fermat_combo,
    }
    games: List[Dict] = []
    used: List[List[int]] = []

    for method in order:
        combo = None
        for attempt in range(500):
            combo = gens[method](analyses[method], rng)
            if combo and combo not in used:
                break
        if combo:
            used.append(combo)
            games.append({**_combo_dict(combo), "pattern": method, "pattern_label": analyses[method]["label"]})

    # 5번째: blend 시 wilson 재시도 또는 첫 방법 변형
    while len(games) < n_games:
        combo = generate_wilson_combo(analyses["wilson"], rng)
        if combo and combo not in used and _is_valid(combo):
            used.append(combo)
            games.append({**_combo_dict(combo), "pattern": "wilson", "pattern_label": "윌슨법(추가)"})
        else:
            break

    public = {k: {kk: vv for kk, vv in v.items() if not kk.startswith("_")} for k, v in analyses.items()}
    return games, public


def build_classic_recommendation(
    df: pd.DataFrame,
    method: str = "blend",
    seed: Optional[int] = None,
    recent_n: Optional[int] = None,
) -> Dict:
    """패턴 분석법 기반 추천 페이로드."""
    from .machine_analytics import predict_next_round

    next_round, next_date, _ = predict_next_round(df)
    m = method.lower() if method else "blend"
    if m not in METHOD_IDS:
        m = "blend"

    if m == "blend":
        combos, patterns = generate_blend_sets(df, seed=seed, n_games=5)
        compose = "윌슨·가우스·호이겐스·페르마 각 1게임 + 보조"
    else:
        combos = []
        patterns = analyze_all_classic(df, recent_n)
        for i in range(5):
            combo, _ = generate_by_method(df, m, seed=(seed + i) if seed is not None else None)
            if combo and combo not in [c["numbers"] for c in combos]:
                combos.append({**_combo_dict(combo), "pattern": m, "pattern_label": patterns[m]["label"]})
        compose = f"{patterns[m]['label']} 단일 패턴 5게임"

    warning = None if combos else "패턴 조합 생성에 실패했습니다."

    return {
        "next_round": next_round,
        "next_draw_date": next_date,
        "method": m,
        "latest_round": int(df["round"].max()),
        "pattern_analysis": patterns if m == "blend" else {m: _public_analysis(patterns[m])},
        "combinations": combos,
        "warning": warning,
        "filter_rule": "총합 100~175, 홀짝 2:4|3:3|4:2",
        "compose_rule": compose,
    }
