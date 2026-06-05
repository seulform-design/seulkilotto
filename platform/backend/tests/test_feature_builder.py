import pandas as pd

from app.engines.feature_builder import build_features_for_draws


def test_features_count():
    rows = [
        {"round_no": 1, "num1": 1, "num2": 2, "num3": 3, "num4": 4, "num5": 5, "num6": 6, "machine_no": 1},
        {"round_no": 2, "num1": 2, "num2": 3, "num3": 4, "num4": 5, "num5": 6, "num6": 7, "machine_no": 1},
    ]
    df = pd.DataFrame(rows)
    feats = build_features_for_draws(df)
    assert len(feats) == 2
    assert feats[1].repeat_count >= 0
    assert feats[1].ac_value > 0
