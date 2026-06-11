"""후속출현 분석 엔진 테스트."""
import pandas as pd

from app.database import NUMBER_COLUMNS
from app.post_occurrence_engine import run_post_occurrence_analysis


def _synthetic_df(n: int = 150) -> pd.DataFrame:
    rows = []
    for i in range(n):
        base = (i * 7) % 25 + 1
        nums = sorted({base, base + 3, base + 7, base + 11, base + 15, base + 19})
        while len(nums) < 6:
            cand = (nums[-1] % 45) + 1
            if cand not in nums:
                nums.append(cand)
        nums = sorted(set(n for n in nums if 1 <= n <= 45))[:6]
        rows.append(
            {
                "round": 1000 + i,
                "draw_date": f"2024-01-{(i % 28) + 1:02d}",
                **{NUMBER_COLUMNS[j]: nums[j] for j in range(6)},
                "bonus": 45 if 45 not in nums else 44,
            }
        )
    return pd.DataFrame(rows)


def test_post_occurrence_pipeline():
    df = _synthetic_df(150)
    trigger = df.iloc[-1]
    nums = [int(trigger[c]) for c in NUMBER_COLUMNS]
    out = run_post_occurrence_analysis(df, trigger_numbers=nums, trigger_bonus=int(trigger["bonus"]))
    assert "error" not in out
    assert out["step1_combinations"]["total_combo_count"] == 63
    assert len(out["final_ranking"]) == 45
    assert "S" in out["grades"]
    assert out["backtest"]["window_rounds"] >= 1


def test_single_combo_excluded_from_analysis():
    df = _synthetic_df(150)
    trigger = df.iloc[-1]
    nums = [int(trigger[c]) for c in NUMBER_COLUMNS]
    out = run_post_occurrence_analysis(df, trigger_numbers=nums)
    singles = [cr for cr in out.get("duplicate_pattern_analysis", []) if len(cr["combo"]) == 1]
    assert singles == []
    assert out["step2_discovery"]["min_combo_size"] == 2
    assert out["step2_discovery"]["excluded_single_combos"] == 6


def test_no_eligible_data_short_circuit():
    """발견 2회 미만이면 조기 반환."""
    rows = []
    for i in range(30):
        nums = [1, 2, 3, 4, 5, 6]
        rows.append(
            {
                "round": 1000 + i,
                "draw_date": f"2024-01-{(i % 28) + 1:02d}",
                **{NUMBER_COLUMNS[j]: nums[j] for j in range(6)},
                "bonus": 7,
            }
        )
    df = pd.DataFrame(rows)
    out = run_post_occurrence_analysis(
        df, trigger_numbers=[10, 11, 12, 13, 14, 15], trigger_bonus=20
    )
    assert out.get("analysis_status") == "no_eligible_data"
    assert out["final_ranking"] == []
    assert out["step3_next_draw_collection"]["next_events_collected"] == 0


def test_post_occurrence_no_random_combos():
    df = _synthetic_df(120)
    trigger = df.iloc[-1]
    nums = [int(trigger[c]) for c in NUMBER_COLUMNS]
    a = run_post_occurrence_analysis(df, trigger_numbers=nums)
    b = run_post_occurrence_analysis(df, trigger_numbers=nums)
    assert a["final_ranking"] == b["final_ranking"]
