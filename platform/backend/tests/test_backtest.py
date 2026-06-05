"""백테스트 엔진 테스트."""
import pandas as pd

from app.engines.backtest_engine import walk_forward_backtest


def test_walk_forward_runs():
    rows = []
    for i in range(120):
        base = (i % 45) + 1
        nums = sorted([(base + k - 1) % 45 + 1 for k in range(6)])
        rows.append(
            {
                "round_no": i + 1,
                "num1": nums[0],
                "num2": nums[1],
                "num3": nums[2],
                "num4": nums[3],
                "num5": nums[4],
                "num6": nums[5],
                "machine_no": 1,
            }
        )
    df = pd.DataFrame(rows)
    out = walk_forward_backtest(df, train_min=50, step=5)
    assert "hit_rate_top6" in out
    assert out["validation_rounds"] > 0
