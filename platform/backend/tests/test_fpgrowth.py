import pandas as pd

from app.engines.fpgrowth_engine import _fallback_rules, mine_fpgrowth_rules


def _df(n=60):
    rows = []
    for i in range(n):
        nums = sorted([(i * 3 + k) % 45 + 1 for k in range(6)])
        rows.append({"round_no": i + 1, **{f"num{j+1}": nums[j] for j in range(6)}, "machine_no": 1})
    return pd.DataFrame(rows)


def test_fallback_rules():
    out = _fallback_rules(_df(80), 0.01, 20)
    assert out["method"] == "fallback_pair"
    assert "rules" in out


def test_fpgrowth_smoke():
    out = mine_fpgrowth_rules(_df(40), min_support=0.08, min_confidence=0.25, max_rules=20)
    assert "rules" in out
    assert out["method"] in ("fpgrowth", "fallback_pair")
