"""Walk-Forward 백테스트 엔진."""
from __future__ import annotations

from typing import Dict, List

import numpy as np

from app.config import settings
from app.engines.draw_frame import row_numbers
from app.engines.pattern_index import PatternIndex


def walk_forward_backtest(df, train_min: int | None = None, step: int = 1) -> Dict:
    train_min = train_min or settings.BACKTEST_TRAIN_MIN
    ordered = df.sort_values("round_no")
    rounds = [(int(r["round_no"]), row_numbers(r)) for _, r in ordered.iterrows()]
    if len(rounds) < train_min + 5:
        return {"error": "데이터 부족", "min_required": train_min + 5}

    hits_top6 = []
    hits_top12 = []
    precisions = []

    for test_idx in range(train_min, len(rounds) - 1, step):
        train_df = ordered.iloc[:test_idx]
        idx = PatternIndex().build(train_df)
        _, actual = rounds[test_idx + 1]
        # 점수: pair_next 빈도 합산
        scores = np.zeros(46)
        for pk, cnt in idx.pair_next.items():
            for num, c in cnt.items():
                scores[num] += c
        ranked = np.argsort(scores[1:])[::-1] + 1
        pred6 = set(ranked[:6].tolist())
        pred12 = set(ranked[:12].tolist())
        actual_set = set(actual)
        h6 = len(pred6 & actual_set)
        h12 = len(pred12 & actual_set)
        hits_top6.append(h6 / 6)
        hits_top12.append(h12 / 6)
        precisions.append(h6 / 6)

    return {
        "method": "walk_forward_pair_conditional",
        "train_min": train_min,
        "validation_rounds": len(hits_top6),
        "hit_rate_top6": round(float(np.mean(hits_top6)), 4),
        "hit_rate_top12": round(float(np.mean(hits_top12)), 4),
        "precision_avg": round(float(np.mean(precisions)), 4),
        "f1": round(float(np.mean(precisions)), 4),
        "disclaimer": "백테스트는 과거 적합도이며 미래 성능을 보장하지 않습니다.",
        "evidence": "Train on 1..t, predict t+1 top numbers from pair→next frequencies",
    }
