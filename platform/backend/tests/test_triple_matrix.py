import pandas as pd

from app.engines.pattern_index import PatternIndex
from app.engines.triple_matrix import build_triple_matrix


def _df(n=60):
    rows = []
    for i in range(n):
        nums = sorted([(i + k) % 45 + 1 for k in range(6)])
        rows.append({"round_no": i + 1, **{f"num{j+1}": nums[j] for j in range(6)}, "machine_no": 1})
    return pd.DataFrame(rows)


def test_triple_top():
    idx = PatternIndex().build(_df())
    out = build_triple_matrix(idx, mode="top", limit=20)
    assert out["mode"] == "top"
    assert len(out["items"]) <= 20


def test_triple_anchor():
    idx = PatternIndex().build(_df())
    out = build_triple_matrix(idx, mode="anchor", anchor=7)
    assert out["anchor"] == 7
    assert out["size"] == 45
