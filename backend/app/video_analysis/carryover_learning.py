"""복기 이월(carryover) 역산 — '한 회차에 강수(1:1 반복도 상위)였지만 그 회차엔
못 나온 번호가 다음 회차에 나오는가' 를 정직하게 검증한다.

사용자 관찰: 1232 강수 중 미당첨이던 번호가 1233 에서 나오는 것처럼 보인다.
→ 이월 가설을 정량화해 무작위 대비 재현되는지 본다.

절대 규칙:
  - 미래(당첨) 정보를 후보 '정의'에 넣지 않는다(라벨·검증에만 사용).
  - 무작위 기준선(lift≈1) 대비 재현되는 초과가 없으면 신호로 쓰지 않는다.
  - 로또는 독립시행이라 이월은 대개 무작위와 구분되지 않는다. 확률 향상은 단정하지 않는다.
"""
from __future__ import annotations

from typing import Any, Dict, List

BASELINE_HIT = 6.0 / 45.0  # 임의 번호가 다음 회차 당첨 6개에 속할 확률
CARRYOVER_KS = [6, 12, 18]
LIFT_SIGNAL = 1.15  # 이월을 '신호'로 인정하는 하한(이 미만이면 평탄=미주입)


def _support_ranked(sample: Any) -> List[int]:
    """번호를 양쪽지지(support) 강한 순으로 정렬 — feature 의 support_rank 재사용
    (낮을수록 강함). 당첨 미사용."""
    return sorted(range(1, 46), key=lambda n: sample.features[n]["support_rank"])


def build_carryover_learning(seed: int = 42) -> Dict[str, Any]:
    from .feature_learning_engine import collect_round_samples

    samples = collect_round_samples()
    if len(samples) < 2:
        return {
            "ok": False,
            "reason": "이월 역산은 최소 2개 보관 회차가 필요합니다(추첨 전 등록 용지 기준).",
            "round_count": len(samples),
            "backtest": {"pairs": 0, "by_k": {}, "per_pair": []},
            "calibration_flat": True,
            "current_candidates": [],
        }

    # 인접 회차쌍마다: N 의 '강수였지만 N 에 미당첨' 상위 K → N+1 당첨 여부.
    per_pair: List[Dict[str, Any]] = []
    agg: Dict[int, Dict[str, float]] = {k: {"hit": 0.0, "exp": 0.0, "cnt": 0} for k in CARRYOVER_KS}
    for i in range(len(samples) - 1):
        cur, nxt = samples[i], samples[i + 1]
        ranked = _support_ranked(cur)
        cur_win = set(cur.winning)
        nxt_win = set(nxt.winning)
        row: Dict[str, Any] = {"from_round": cur.round_no, "to_round": nxt.round_no, "by_k": {}}
        for k in CARRYOVER_KS:
            missed = [n for n in ranked if n not in cur_win][:k]  # 강수 미당첨 = 이월 후보
            hit = sum(1 for n in missed if n in nxt_win)
            exp = len(missed) * BASELINE_HIT
            row["by_k"][str(k)] = {
                "pool": len(missed),
                "hit": hit,
                "exp": round(exp, 3),
                "lift": round(hit / exp, 3) if exp > 0 else 0.0,
                "carried": sorted(n for n in missed if n in nxt_win),
            }
            agg[k]["hit"] += hit
            agg[k]["exp"] += exp
            agg[k]["cnt"] += 1
        per_pair.append(row)

    backtest_by_k: Dict[str, Any] = {}
    flat = True
    for k in CARRYOVER_KS:
        hit, exp = agg[k]["hit"], agg[k]["exp"]
        lift = round(hit / exp, 3) if exp > 0 else 0.0
        backtest_by_k[str(k)] = {"hit": hit, "exp": round(exp, 3), "lift": lift, "pairs": int(agg[k]["cnt"])}
        if lift >= LIFT_SIGNAL:
            flat = False  # 어떤 K 에서든 뚜렷한 초과가 재현되면 '평탄 아님'

    # 이번회차 이월 후보 = 최신 보관(추첨완료) 회차의 '강수였지만 미당첨' 상위 18.
    # 아직 안 나온 강수라 다음(=이번) 회차로 '이월'된다는 가설의 후보. 이번회차는
    # 미추첨이라 누수 없음(과거 회차만으로 도출).
    latest = samples[-1]
    ranked = _support_ranked(latest)
    latest_win = set(latest.winning)
    rank_of = {n: idx for idx, n in enumerate(ranked)}
    cand_nums = [n for n in ranked if n not in latest_win][:18]
    denom = max(1, len(cand_nums) - 1)
    current_candidates = [
        {
            "number": n,
            "prev_support_rank": rank_of[n] + 1,
            "score": round(1.0 - (i / denom), 3),
        }
        for i, n in enumerate(cand_nums)
    ]

    return {
        "ok": True,
        "round_count": len(samples),
        "from_round": latest.round_no,
        "backtest": {"pairs": len(per_pair), "by_k": backtest_by_k, "per_pair": per_pair},
        "calibration_flat": flat,
        "current_candidates": current_candidates,
        "baselines": {"uniform_hit_rate": round(BASELINE_HIT, 4)},
        "honesty": (
            f"보관 {len(samples)}개 회차({len(per_pair)}개 전이)로 '강수 미당첨 → 다음 회차 당첨' 이월을 "
            "검증했습니다. 로또는 독립시행이라 이월은 대개 무작위와 구분되지 않습니다(lift≈1). "
            "재현되는 초과(lift≥1.15)가 없으면 순위 가산에 넣지 않고 '참고'로만 표시하며, "
            "1등 확률(1/8,145,060)은 어떤 이월로도 변하지 않습니다."
        ),
    }
