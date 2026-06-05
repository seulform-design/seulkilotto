"""v1 핵심 분석 단위 테스트."""
import pandas as pd
import pytest

from app.analytics import (
    analyze_combination,
    build_weights,
    calc_frequency,
    find_unseen_numbers,
    generate_weighted_sets,
)
from app.database import NUMBER_COLUMNS


def _sample_df(n: int = 10) -> pd.DataFrame:
    rows = []
    for i in range(n):
        base = (i * 3) % 40 + 1
        nums = sorted({base, base + 1, base + 5, base + 10, base + 15, base + 20})
        while len(nums) < 6:
            nums.append((nums[-1] % 45) + 1)
        nums = sorted(set(nums))[:6]
        rows.append(
            {
                "round": 1000 + i,
                "draw_date": f"2024-01-{i + 1:02d}",
                **{NUMBER_COLUMNS[j]: nums[j] for j in range(6)},
                "bonus": 45 if 45 not in nums else 44,
            }
        )
    return pd.DataFrame(rows)


def test_analyze_combination_odd_even():
    out = analyze_combination([1, 3, 5, 7, 9, 11])
    assert out["odd_count"] == 6
    assert out["even_count"] == 0
    assert out["sum_band"] == "낮음"


def test_analyze_combination_consecutive():
    out = analyze_combination([10, 11, 20, 30, 40, 45])
    assert out["has_consecutive"] is True
    assert [10, 11] in out["consecutive_pairs"]


def test_calc_frequency_counts_all_numbers():
    df = _sample_df(5)
    out = calc_frequency(df)
    assert out["total_rounds"] == 5
    assert len(out["items"]) == 45


def test_find_unseen_numbers():
    df = _sample_df(3)
    unseen = find_unseen_numbers(df, lookback=2)
    assert all(1 <= n <= 45 for n in unseen)


def test_build_weights_sums_to_one():
    df = _sample_df(8)
    w = build_weights(df, lookback=3)
    assert abs(w.sum() - 1.0) < 1e-6


def test_generate_weighted_sets_count():
    df = _sample_df(12)
    out = generate_weighted_sets(df, n_sets=3, seed=42)
    assert len(out["combinations"]) == 3
    for c in out["combinations"]:
        assert len(c["numbers"]) == 6
        assert len(set(c["numbers"])) == 6


def test_generate_partial_warning():
    df = _sample_df(12)
    out = generate_weighted_sets(
        df, n_sets=10, exclude_consecutive=True, seed=1
    )
    if len(out["combinations"]) < 10:
        assert "warning" in out
