"""최종 번호 스코어링 엔진 (0~100, 근거 포함)."""
from __future__ import annotations

from typing import Dict, List

import numpy as np

from app.engines.common import ALL_NUMBERS
from app.engines.pattern_index import PatternIndex


WEIGHTS = {
    "frequency": 0.12,
    "conditional": 0.22,
    "pair": 0.15,
    "survival": 0.12,
    "repeat": 0.08,
    "neighbor": 0.08,
    "ac_fit": 0.08,
    "reliability": 0.15,
}


def score_numbers(df, index: PatternIndex | None = None) -> List[Dict]:
    idx = index or PatternIndex().build(df)
    freq = np.array([idx.number_freq.get(n, 0) for n in ALL_NUMBERS], dtype=float)
    cond = np.zeros(45)
    for pk, cnt in idx.pair_next.items():
        for n, c in cnt.items():
            if 1 <= n <= 45:
                cond[n - 1] += c
    surv = np.zeros(45)
    for n in ALL_NUMBERS:
        lag1 = idx.number_survival[n].get(1, {})
        total = lag1.get(1, 0) + lag1.get(0, 0)
        surv[n - 1] = lag1.get(1, 0) / total if total else 0

    def norm(v):
        m, s = v.max(), v.std()
        if s < 1e-9:
            return np.zeros_like(v)
        return (v - v.mean()) / s

    f_n = norm(freq)
    c_n = norm(cond)
    s_n = norm(surv)
    composite = WEIGHTS["frequency"] * f_n + WEIGHTS["conditional"] * c_n + WEIGHTS["survival"] * s_n
    composite = (composite - composite.min()) / (composite.max() - composite.min() + 1e-9) * 100

    results = []
    for i, n in enumerate(ALL_NUMBERS):
        reasons = []
        if freq[n - 1] >= np.percentile(freq, 75):
            reasons.append("출현 빈도 상위")
        if cond[n - 1] >= np.percentile(cond, 75):
            reasons.append("조건부(pair→next) 상위")
        if surv[n - 1] >= 0.15:
            reasons.append("1회차 후 재등장률 양호")
        results.append(
            {
                "number": n,
                "score": round(float(composite[i]), 1),
                "reasons": reasons or ["복합 점수 중위권"],
            }
        )
    results.sort(key=lambda x: -x["score"])
    return results
