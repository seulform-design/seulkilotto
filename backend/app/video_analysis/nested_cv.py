"""Nested walk-forward CV — outer hit 집계 (점수 미연결).

artifacts/09_validation/nested_cv.md
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Sequence

from .feature_learning_engine import (
    BASELINE_TOP6_HITS,
    RoundSample,
    recommend_with_contributions,
    validate_features,
)


NESTED_VERSION = "0.2.0"
HONESTY = (
    "Nested CV는 선택 편향 완화용 리포트다. "
    "scoring_allowed=false (Gate·사람 승인 전 추천 미연결). 당첨 확률 불변."
)


def _outer_top6_hits(test: RoundSample, adopted_reports: list[dict[str, Any]]) -> tuple[int, list[int]]:
    """train에서 채택된 Feature 로 test 용지 top6 적중 수."""
    if not adopted_reports:
        return 0, []
    rec = recommend_with_contributions(test.auto_lines, test.semi_lines, adopted_reports, top_k=6)
    top6 = [int(n) for n in (rec.get("top6") or [])]
    hits = len(set(top6) & set(test.winning))
    return hits, top6


_NCV_CACHE: dict[tuple[Any, ...], tuple[float, dict[str, Any]]] = {}
_NCV_CACHE_MAX = 8
_NCV_CACHE_TTL_SEC = 900  # 15분


def run_nested_feature_cv(
    samples: Sequence[RoundSample],
    *,
    seed: int = 42,
    min_outer: int = 3,
    inner_hold: int = 1,
) -> dict[str, Any]:
    import time
    from .store import store_signature
    from ..database import load_history

    df = load_history()
    latest_round = int(df["round"].max()) if (df is not None and not df.empty) else 0

    cache_key = (seed, min_outer, inner_hold, latest_round, store_signature())
    now = time.monotonic()
    cached = _NCV_CACHE.get(cache_key)
    if cached is not None and now - cached[0] < _NCV_CACHE_TTL_SEC:
        return cached[1]

    res = _run_nested_feature_cv_impl(samples, seed=seed, min_outer=min_outer, inner_hold=inner_hold)
    _NCV_CACHE[cache_key] = (now, res)
    if len(_NCV_CACHE) > _NCV_CACHE_MAX:
        oldest = min(_NCV_CACHE, key=lambda k: _NCV_CACHE[k][0])
        _NCV_CACHE.pop(oldest, None)
    return res


def _run_nested_feature_cv_impl(
    samples: Sequence[RoundSample],
    *,
    seed: int = 42,
    min_outer: int = 3,
    inner_hold: int = 1,
) -> dict[str, Any]:
    n = len(samples)
    if n < min_outer + inner_hold + 1:
        return {
            "version": NESTED_VERSION,
            "ok": False,
            "experimental": False,
            "outer_folds": 0,
            "inner_folds": 0,
            "mean_top6": None,
            "baseline_top6": BASELINE_TOP6_HITS,
            "lift_vs_uniform": None,
            "small_sample": True,
            "picked_models": [],
            "scoring_allowed": False,
            "reason": f"표본 부족({n} < {min_outer + inner_hold + 1})",
            "run_at": datetime.now(timezone.utc).isoformat(),
            "honesty": HONESTY,
        }

    outer_notes: list[dict[str, Any]] = []
    lifts: list[float] = []
    hit_list: list[float] = []

    for outer_i in range(min_outer, n):
        train = list(samples[:outer_i])
        test = samples[outer_i]
        if len(train) <= inner_hold:
            continue
        reports = validate_features(train, seed=seed + outer_i)
        adopted = [r for r in reports if r.get("adopted")]
        mean_lift = (
            float(sum(float(r.get("lift_vs_uniform") or 0.0) for r in adopted) / len(adopted))
            if adopted
            else 0.0
        )
        hits, top6 = _outer_top6_hits(test, adopted)
        lifts.append(mean_lift)
        hit_list.append(float(hits))
        outer_notes.append(
            {
                "outer_test_index": outer_i,
                "outer_round_no": int(test.round_no),
                "train_rounds": len(train),
                "adopted_count": len(adopted),
                "mean_lift_vs_uniform": round(mean_lift, 3),
                "picked": [r["key"] for r in adopted[:5]],
                "top6": top6,
                "top6_hits": hits,
                "winning": list(test.winning),
            }
        )

    mean_lift = float(sum(lifts) / len(lifts)) if lifts else None
    mean_top6 = float(sum(hit_list) / len(hit_list)) if hit_list else None
    lift_hits = (
        (mean_top6 / BASELINE_TOP6_HITS) if (mean_top6 is not None and BASELINE_TOP6_HITS) else None
    )

    return {
        "version": NESTED_VERSION,
        "ok": True,
        "experimental": False,
        "outer_folds": len(outer_notes),
        "inner_folds": inner_hold,
        "mean_top6": round(mean_top6, 4) if mean_top6 is not None else None,
        "baseline_top6": BASELINE_TOP6_HITS,
        "lift_vs_uniform": round(mean_lift, 3) if mean_lift is not None else None,
        "lift_vs_baseline_hits": round(lift_hits, 3) if lift_hits is not None else None,
        "small_sample": len(outer_notes) < 5,
        "picked_models": outer_notes,
        "scoring_allowed": False,
        "run_at": datetime.now(timezone.utc).isoformat(),
        "honesty": HONESTY,
        "note": "outer top6 hits 집계됨 — Gate·사람 승인 전 scoring 금지",
    }
