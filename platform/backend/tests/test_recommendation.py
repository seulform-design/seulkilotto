"""추천 엔진 — 근거 필드 포함."""
import pandas as pd

from app.engines.recommendation_engine import generate_recommendations


def test_recommend_has_reasons():
    rows = []
    for i in range(80):
        nums = sorted([(i + k) % 45 + 1 for k in range(6)])
        rows.append(
            {
                "round_no": i + 1,
                **{f"num{j+1}": nums[j] for j in range(6)},
                "machine_no": 1,
            }
        )
    df = pd.DataFrame(rows)
    out = generate_recommendations(df, n_sets=3, seed=1)
    assert len(out["combinations"]) >= 1
    assert out["disclaimer"]
    c0 = out["combinations"][0]
    assert "reasons" in c0
    assert len(c0["numbers"]) == 6
