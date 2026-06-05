"""근거 포함 추천 조합 생성."""
from __future__ import annotations

import random
from typing import Dict, List

from app.config import settings
from app.engines.common import ALL_NUMBERS
from app.engines.pattern_index import PatternIndex
from app.engines.scoring_engine import score_numbers


def generate_recommendations(
    df,
    n_sets: int = 5,
    seed: int | None = None,
) -> Dict:
    seed = seed if seed is not None else settings.GLOBAL_SEED
    rng = random.Random(seed)
    idx = PatternIndex().build(df)
    ranked = score_numbers(df, idx)

    combos = []
    used = []
    pool = [r["number"] for r in ranked[:25]]

    for g in range(n_sets):
        for _ in range(200):
            pick = sorted(rng.sample(pool, 6))
            if pick in used:
                continue
            s = sum(pick)
            if 100 <= s <= 175:
                odd = sum(1 for n in pick if n % 2 == 1)
                if odd in (2, 3, 4):
                    reasons = []
                    for n in pick:
                        entry = next(x for x in ranked if x["number"] == n)
                        reasons.extend(entry["reasons"][:1])
                    combos.append(
                        {
                            "numbers": pick,
                            "sum_total": s,
                            "odd_count": odd,
                            "reasons": list(dict.fromkeys(reasons))[:5],
                        }
                    )
                    used.append(pick)
                    break

    return {
        "combinations": combos,
        "ranking_preview": ranked[:15],
        "disclaimer": "통계 기반 추천이며 당첨을 보장하지 않습니다.",
        "seed": seed,
    }
