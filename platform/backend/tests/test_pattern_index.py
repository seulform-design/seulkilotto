"""PatternIndex · 조건부 확률 엔진 단위 테스트."""
import pandas as pd

from app.engines.pattern_index import PatternIndex


def _mini_df():
    rows = [
        {"round_no": 1, "num1": 7, "num2": 11, "num3": 12, "num4": 20, "num5": 30, "num6": 40, "machine_no": 1},
        {"round_no": 2, "num1": 23, "num2": 34, "num3": 41, "num4": 1, "num5": 2, "num6": 3, "machine_no": 1},
        {"round_no": 3, "num1": 7, "num2": 11, "num3": 15, "num4": 16, "num5": 17, "num6": 18, "machine_no": 1},
        {"round_no": 4, "num1": 5, "num2": 6, "num3": 7, "num4": 8, "num5": 9, "num6": 10, "machine_no": 1},
    ]
    return pd.DataFrame(rows)


def test_pair_conditional_has_evidence():
    idx = PatternIndex().build(_mini_df())
    res = idx.conditional_pair(7, 11)
    assert res["pair"] == "7-11"
    assert res["occurrence_count"] >= 1
    assert "top_next_numbers" in res
    assert res["disclaimer"]


def test_triple_conditional():
    idx = PatternIndex().build(_mini_df())
    res = idx.conditional_triple(7, 11, 12)
    assert "triple" in res


def test_survival_pair():
    idx = PatternIndex().build(_mini_df())
    res = idx.pair_survival_stats(7, 11)
    assert "survival_rate" in res
