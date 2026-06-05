"""Feature Store — 회차별 DrawFeature 생성."""
from __future__ import annotations

from typing import Dict, List, Optional

import numpy as np

from app.engines.common import (
    LOW_MAX,
    NUM_COLS,
    calc_ac,
    calc_entropy,
    cluster_distribution,
    end_digit_pattern,
)
from app.engines.draw_frame import row_numbers
from app.models.features import DrawFeature


def _repeat_count(curr: set[int], prev: Optional[set[int]]) -> int:
    if not prev:
        return 0
    return len(curr & prev)


def _neighbor_count(curr: set[int], prev: Optional[set[int]]) -> int:
    if not prev:
        return 0
    n = 0
    for x in curr:
        if (x - 1) in prev or (x + 1) in prev:
            n += 1
    return n


def _consecutive_count(nums: List[int]) -> int:
    c = 0
    for i in range(len(nums) - 1):
        if nums[i + 1] - nums[i] == 1:
            c += 1
    return c


def build_features_for_draws(df) -> List[DrawFeature]:
    """DataFrame(round_no, num1..6, machine_no) → DrawFeature 리스트."""
    features: List[DrawFeature] = []
    prev_set: Optional[set[int]] = None
    for _, row in df.sort_values("round_no").iterrows():
        nums = row_numbers(row)
        s = set(nums)
        odd = sum(1 for n in nums if n % 2 == 1)
        low = sum(1 for n in nums if n <= LOW_MAX)
        arr = np.array(nums, dtype=float)
        feat = DrawFeature(
            round_no=int(row["round_no"]),
            sum_total=int(sum(nums)),
            average=float(arr.mean()),
            std=float(arr.std()),
            odd_even_ratio=round(odd / 6, 4),
            high_low_ratio=round((6 - low) / 6, 4),
            ac_value=round(calc_ac(nums), 4),
            repeat_count=_repeat_count(s, prev_set),
            neighbor_count=_neighbor_count(s, prev_set),
            consecutive_count=_consecutive_count(nums),
            end_digit_pattern=end_digit_pattern(nums),
            cluster_distribution=cluster_distribution(nums),
            entropy_score=calc_entropy(nums),
            machine_no=int(row.get("machine_no", 1)),
        )
        features.append(feat)
        prev_set = s
    return features
