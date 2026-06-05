"""Triple 패턴 시각화 — 앵커 번호 기준 45×45 + TOP 목록."""
from __future__ import annotations

from itertools import combinations
from typing import Dict, List, Optional

import numpy as np

from app.engines.common import ALL_NUMBERS, triple_key
from app.engines.pattern_index import PatternIndex


def build_triple_top_list(index: PatternIndex, limit: int = 50) -> Dict:
    """상위 Triple 동시출현 (막대 차트용)."""
    top = index.triple_occurrence.most_common(limit)
    items = []
    for tk, cnt in top:
        nums = list(map(int, tk.split("-")))
        next_c = index.triple_next.get(tk, {})
        top_next = next_c.most_common(3) if next_c else []
        items.append(
            {
                "triple": tk,
                "numbers": nums,
                "occurrence_count": cnt,
                "support": round(cnt / max(index.total_draws, 1), 6),
                "top_next": [
                    {"number": n, "count": c, "probability": round(c / max(sum(next_c.values()), 1), 4)}
                    for n, c in top_next
                ],
            }
        )
    return {
        "mode": "top",
        "limit": limit,
        "items": items,
        "total_triples_observed": len(index.triple_occurrence),
        "evidence": f"상위 {limit}개 triple 동시출현 (전체 {len(index.triple_occurrence)}종)",
    }


def build_triple_anchor_heatmap(
    index: PatternIndex,
    anchor: int,
    metric: str = "cooccurrence",
) -> Dict:
    """앵커 번호 포함 Triple — 나머지 2번호 45×45 히트맵 (i<j, anchor 포함)."""
    if anchor not in ALL_NUMBERS:
        raise ValueError("anchor must be 1~45")

    n = len(ALL_NUMBERS)
    labels = [str(x) for x in ALL_NUMBERS]
    mat = np.zeros((n, n), dtype=float)
    total = max(index.total_draws, 1)

    for i, a in enumerate(ALL_NUMBERS):
        for j, b in enumerate(ALL_NUMBERS):
            if i >= j or a == b:
                continue
            if a == anchor or b == anchor:
                continue
            tk = triple_key(anchor, a, b)
            occ = index.triple_occurrence.get(tk, 0)
            if metric == "cooccurrence":
                mat[i, j] = mat[j, i] = occ
            elif metric == "conditional":
                next_c = index.triple_next.get(tk, {})
                trials = sum(next_c.values()) or 1
                top_p = max((c / trials for c in next_c.values()), default=0)
                mat[i, j] = mat[j, i] = top_p
            else:
                support = occ / total
                mat[i, j] = mat[j, i] = support

    data: List[List] = []
    for i in range(n):
        for j in range(n):
            if i != j and mat[i, j] > 0:
                data.append([j, i, round(float(mat[i, j]), 4)])

    return {
        "mode": "anchor_heatmap",
        "anchor": anchor,
        "metric": metric,
        "size": n,
        "labels": labels,
        "data": data,
        "max": round(float(mat.max()), 4) if mat.max() else 0,
        "evidence": f"Triple({anchor}, x, y) co-occurrence matrix",
    }


def build_triple_matrix(
    index: PatternIndex,
    mode: str = "top",
    anchor: Optional[int] = None,
    metric: str = "cooccurrence",
    limit: int = 50,
) -> Dict:
    if mode == "anchor" and anchor is not None:
        return build_triple_anchor_heatmap(index, anchor, metric)
    return build_triple_top_list(index, limit)
