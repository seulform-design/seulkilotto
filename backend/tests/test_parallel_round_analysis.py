"""평행회차 분석 테스트."""
import pandas as pd

from app.parallel_round_analysis import (
    analyze_parallel_rounds,
    find_parallel_rounds,
    parallel_suffix,
)


def _sample_df() -> pd.DataFrame:
    rows = []
    for rnd in [29, 129, 229, 329, 429]:
        base = (rnd % 10) + 1
        rows.append(
            {
                "round": rnd,
                "draw_date": "2020-01-01",
                "num1": base,
                "num2": base + 5,
                "num3": base + 10,
                "num4": base + 15,
                "num5": base + 20,
                "num6": base + 25,
                "bonus": base + 3,
            }
        )
    rows.append(
        {
            "round": 100,
            "draw_date": "2020-02-01",
            "num1": 1,
            "num2": 2,
            "num3": 3,
            "num4": 4,
            "num5": 5,
            "num6": 6,
            "bonus": 7,
        }
    )
    return pd.DataFrame(rows)


def test_parallel_suffix_and_rounds():
    assert parallel_suffix(1229) == 29
    assert parallel_suffix(39) == 39
    df = _sample_df()
    parallel = find_parallel_rounds(df, 1229)
    assert parallel == [29, 129, 229, 329, 429]


def test_analyze_parallel_rounds_structure():
    out = analyze_parallel_rounds(_sample_df(), target_round=529)
    assert out["suffix"] == 29
    assert out["parallel_count"] == 5
    assert "단번대" in out["by_decade"]
    assert out["by_decade"]["단번대"]["strong"]
    assert out["semi_auto_fixed_hint"]
    assert out["draw_table"][0]["numbers"]
