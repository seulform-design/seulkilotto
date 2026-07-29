"""StatisticsSnapshot serializer · Validation gate · ExplainPayload 단위 테스트."""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.epo.historical_stats import _FALLBACK, compute_profile  # noqa: E402
from app.epo.statistics_snapshot import (  # noqa: E402
    SNAPSHOT_VERSION,
    build_snapshot_from_history,
    profile_to_snapshot,
)
from app.video_analysis.explain import build_explain_payload  # noqa: E402
from app.video_analysis.validation_gate import (  # noqa: E402
    evaluate_gate,
    evaluate_gate_from_feature_report,
    summarize_gates,
)


def _mini_history() -> pd.DataFrame:
    rows = []
    for i, nums in enumerate(
        [
            [1, 2, 3, 4, 5, 6],
            [7, 8, 9, 10, 11, 12],
            [13, 14, 15, 16, 17, 18],
            [1, 8, 15, 22, 29, 36],
            [3, 10, 17, 24, 31, 38],
        ],
        start=100,
    ):
        rows.append(
            {
                "round": i,
                "num1": nums[0],
                "num2": nums[1],
                "num3": nums[2],
                "num4": nums[3],
                "num5": nums[4],
                "num6": nums[5],
                "bonus": 45,
            }
        )
    return pd.DataFrame(rows)


def test_profile_to_snapshot_schema_keys():
    snap = profile_to_snapshot(_FALLBACK, created_at="2026-07-30T00:00:00+00:00")
    assert snap["version"] == SNAPSHOT_VERSION
    assert snap["artifact_id"] == "05_statistics"
    assert "empirical" in snap and "sum" in snap["empirical"]
    assert snap["baselines"]["jackpot_odds"] == "1/8145060"
    assert "review" in snap["source"]["exclude_intents"]
    assert "carry" not in snap  # 기본 제외


def test_build_snapshot_from_history_and_fallback():
    empty = build_snapshot_from_history(None)
    assert empty["source"]["rounds"]["count"] == 0
    assert empty["empirical"]["sum"]["p50"] == _FALLBACK.sum_p50

    df = _mini_history()
    snap = build_snapshot_from_history(df)
    assert snap["source"]["rounds"]["count"] == 5
    assert snap["source"]["rounds"]["from"] == 100
    assert snap["frequency"]["number_counts"]
    assert len(snap["decade_bands"]["labels"]) == 5

    recent = build_snapshot_from_history(df, recent_n=2)
    assert recent["frequency"]["window"] == "last_N"
    assert recent["frequency"]["window_n"] == 2
    assert recent["source"]["rounds"]["count"] == 2


def test_compute_profile_roundtrip():
    df = _mini_history()
    profile = compute_profile(df)
    snap = profile_to_snapshot(profile, include_carry=True, round_from=100, round_to=104)
    assert snap["carry"]["last_round_no"] == 104
    assert len(snap["carry"]["last_round_combo"]) == 6


def test_explain_payload_shape():
    p = build_explain_payload(
        subject_type="signal",
        subject_value="feature_learning",
        decision="neutral",
        honesty="test honesty",
        rounds=[1, 2],
    )
    assert p["version"] == "0.1.0"
    assert p["honesty"] == "test honesty"
    assert set(p["confidence"].keys()) == {
        "overall",
        "statistics",
        "pattern",
        "model",
        "simulation",
        "backtest",
    }


def test_gate_demo_blocks_scoring():
    report = {
        "key": "support",
        "adopted": True,
        "lift_vs_uniform": 1.5,
        "walk_forward_mean_hits": 1.2,
        "uniform_baseline": 0.8,
        "permutation_p": 0.01,
        "time_split": {"early_mean": 1.0, "late_mean": 1.1},
        "exclude_reason": [],
    }
    ok = evaluate_gate_from_feature_report(report, demo_source=False)
    assert ok["scoring_allowed"] is True
    assert ok["status"] == "passed"

    blocked = evaluate_gate_from_feature_report(report, demo_source=True)
    assert blocked["scoring_allowed"] is False
    assert any(c["id"] == "G5" and not c["ok"] for c in blocked["checks"])

    exp = evaluate_gate(
        "exp:x",
        adopted=True,
        checks=[{"id": "G1", "ok": True, "detail": ""}],
        experimental=True,
    )
    assert exp["status"] == "experimental_only"
    assert exp["scoring_allowed"] is False

    summary = summarize_gates([ok, blocked], demo_blocked=True)
    assert summary["demo_blocked"] is True
    assert "feature:support" in summary["passed"] or "feature:support" in summary["scoring_allowed_ids"]
