"""45×45 Pair 히트맵 행렬 (동시출현 / Lift / PMI)."""
from __future__ import annotations

from typing import Dict, List

import numpy as np

from app.engines.common import ALL_NUMBERS, pair_key, pmi
from app.engines.pattern_index import PatternIndex


def build_pair_matrix(index: PatternIndex, metric: str = "cooccurrence") -> Dict:
    """ECharts heatmap 용 [x_labels, y_labels, data[[i,j,value]]]."""
    n = len(ALL_NUMBERS)
    labels = [str(x) for x in ALL_NUMBERS]
    total = max(index.total_draws, 1)
    mat = np.zeros((n, n), dtype=float)

    single_p = {num: index.number_freq.get(num, 0) / (total * 6) for num in ALL_NUMBERS}

    for i, a in enumerate(ALL_NUMBERS):
        for j, b in enumerate(ALL_NUMBERS):
            if i == j:
                continue
            pk = pair_key(a, b)
            occ = index.pair_occurrence.get(pk, 0)
            support_ab = occ / total
            if metric == "cooccurrence":
                mat[i, j] = occ
            elif metric == "lift":
                pa, pb = single_p[a], single_p[b]
                conf = support_ab / pa if pa else 0
                mat[i, j] = conf / pb if pb else 0
            elif metric == "pmi":
                mat[i, j] = pmi(support_ab, single_p[a], single_p[b])
            elif metric == "conditional":
                next_c = index.pair_next.get(pk, {})
                trials = sum(next_c.values()) or 1
                mat[i, j] = next_c.get(b, 0) / trials if a != b else 0
            else:
                mat[i, j] = occ

    # ECharts format: [x, y, value] x=col j, y=row i
    data: List[List] = []
    for i in range(n):
        for j in range(n):
            if i != j:
                data.append([j, i, round(float(mat[i, j]), 4)])

    top_pairs = [
        {"pair": pk, "count": c}
        for pk, c in index.pair_occurrence.most_common(10)
    ]

    return {
        "metric": metric,
        "size": n,
        "labels": labels,
        "data": data,
        "max": round(float(mat.max()), 4),
        "top_pairs": top_pairs,
        "evidence": f"45×45 {metric} matrix from {total} draws",
        "disclaimer": "과거 동시출현·조건부 빈도이며 예측이 아닙니다.",
    }
