"""엔진 공통 유틸 — 재현 가능한 계산."""
from __future__ import annotations

import json
import math
from collections import Counter
from itertools import combinations
from typing import Dict, Iterable, List, Sequence, Tuple

import numpy as np

ALL_NUMBERS = list(range(1, 46))
NUM_COLS = ("num1", "num2", "num3", "num4", "num5", "num6")
LOW_MAX = 22


def pair_key(a: int, b: int) -> str:
    x, y = sorted((a, b))
    return f"{x}-{y}"


def triple_key(a: int, b: int, c: int) -> str:
    x, y, z = sorted((a, b, c))
    return f"{x}-{y}-{z}"


def calc_ac(nums: Sequence[int]) -> float:
    """AC = unique_difference_count / (n-1)."""
    s = sorted(nums)
    diffs = {s[i + 1] - s[i] for i in range(len(s) - 1)}
    return len(diffs) / (len(s) - 1) if len(s) > 1 else 0.0


def calc_entropy(nums: Sequence[int]) -> float:
    """번호 구간(5구간) 분포 엔트로피."""
    bins = [0] * 5
    for n in nums:
        bins[min(4, (n - 1) // 9)] += 1
    total = sum(bins)
    ent = 0.0
    for c in bins:
        if c:
            p = c / total
            ent -= p * math.log2(p)
    return round(ent, 4)


def end_digit_pattern(nums: Sequence[int]) -> str:
    return ",".join(str(n % 10) for n in sorted(nums))


def cluster_distribution(nums: Sequence[int]) -> str:
    """1~9,10~18,... 구간별 개수."""
    counts = [0, 0, 0, 0, 0]
    for n in nums:
        counts[min(4, (n - 1) // 9)] += 1
    return json.dumps(counts)


def serialize_top(counter: Counter, limit: int = 10) -> str:
    items = counter.most_common(limit)
    return ",".join(f"{n}:{c}" for n, c in items)


def parse_top(s: str) -> List[Dict]:
    if not s:
        return []
    out = []
    for part in s.split(","):
        if ":" in part:
            n, c = part.split(":", 1)
            out.append({"number": int(n), "count": int(c)})
    return out


def pmi(support_ab: float, support_a: float, support_b: float) -> float:
    if support_ab <= 0 or support_a <= 0 or support_b <= 0:
        return 0.0
    return math.log2(support_ab / (support_a * support_b))


def wilson_ci(successes: int, trials: int, z: float = 1.96) -> Tuple[float, float]:
    if trials == 0:
        return 0.0, 0.0
    p = successes / trials
    z2 = z * z
    denom = 1 + z2 / trials
    centre = p + z2 / (2 * trials)
    margin = z * math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)
    return max(0, (centre - margin) / denom), min(1, (centre + margin) / denom)


def chi_square_pvalue(observed: np.ndarray, expected: np.ndarray) -> float:
    """간단 chi-square p-value (scipy 없을 때 fallback)."""
    from scipy import stats

    chi2, p, _, _ = stats.chi2_contingency(
        np.vstack([observed, expected]), correction=False
    )
    return float(p)
