import pandas as pd

from app.engines.pair_matrix import build_pair_matrix
from app.engines.pattern_index import PatternIndex


def test_pair_matrix_shape():
    rows = [
        {"round_no": i, "num1": 1, "num2": 2, "num3": 3, "num4": 4, "num5": 5, "num6": 6, "machine_no": 1}
        for i in range(1, 51)
    ]
    df = pd.DataFrame(rows)
    idx = PatternIndex().build(df)
    out = build_pair_matrix(idx, "cooccurrence")
    assert out["size"] == 45
    assert len(out["data"]) == 45 * 44
