import pandas as pd

from app.engines.repeat_neighbor import analyze_neighbor, analyze_repeat


def test_repeat_neighbor():
    rows = []
    for i in range(30):
        nums = sorted([(i + k) % 45 + 1 for k in range(6)])
        rows.append({"round_no": i + 1, **{f"num{j+1}": nums[j] for j in range(6)}, "machine_no": 1})
    df = pd.DataFrame(rows)
    rep = analyze_repeat(df)
    nei = analyze_neighbor(df)
    assert "overall_rate" in rep
    assert "overall_rate" in nei
