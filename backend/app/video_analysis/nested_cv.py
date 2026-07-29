"""Nested walk-forward CV — 설계 스텁 (점수 미연결).

artifacts/09_validation/nested_cv.md
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Sequence

from .feature_learning_engine import BASELINE_TOP6_HITS, RoundSample, validate_features


NESTED_VERSION = "0.1.0"
HONESTY = "Nested CV는 선택 편향 완화용 리포트다. scoring_allowed=false. 당첨 확률 불변."


def run_nested_feature_cv(
    samples: Sequence[RoundSample],
    *,
    seed: int = 42,
    min_outer: int = 3,
    inner_hold: int = 1,
) -> dict[str, Any]:
    """바깥 홀드아웃마다 안쪽 train으로만 Feature 채택 후 바깥 1회 평가.

    현재는 스텁: 폴드가 부족하면 small_sample 리포트만 반환.
    채택 결과를 추천 점수에 넣지 않는다.
    """
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

    # 스텁 평가: 각 outer에서 train 구간 validate_features 의 adopted 수·평균 lift만 기록
    # (실제 outer hit 계산은 후속 — 점수 경로 연결 금지)
    outer_notes: list[dict[str, Any]] = []
    lifts: list[float] = []
    for outer_i in range(min_outer, n):
        train = list(samples[:outer_i])
        if len(train) <= inner_hold:
            continue
        reports = validate_features(train, seed=seed + outer_i)
        adopted = [r for r in reports if r.get("adopted")]
        mean_lift = (
            float(sum(float(r.get("lift_vs_uniform") or 0.0) for r in adopted) / len(adopted))
            if adopted
            else 0.0
        )
        lifts.append(mean_lift)
        outer_notes.append(
            {
                "outer_test_index": outer_i,
                "train_rounds": len(train),
                "adopted_count": len(adopted),
                "mean_lift_vs_uniform": round(mean_lift, 3),
                "picked": [r["key"] for r in adopted[:5]],
            }
        )

    mean_lift = float(sum(lifts) / len(lifts)) if lifts else None
    return {
        "version": NESTED_VERSION,
        "ok": True,
        "experimental": False,
        "outer_folds": len(outer_notes),
        "inner_folds": inner_hold,
        "mean_top6": None,  # hit 기반 평가는 후속
        "baseline_top6": BASELINE_TOP6_HITS,
        "lift_vs_uniform": round(mean_lift, 3) if mean_lift is not None else None,
        "small_sample": len(outer_notes) < 5,
        "picked_models": outer_notes,
        "scoring_allowed": False,
        "run_at": datetime.now(timezone.utc).isoformat(),
        "honesty": HONESTY,
        "note": "스텁 — outer hit 집계·Gate 승격 전 scoring 금지",
    }
