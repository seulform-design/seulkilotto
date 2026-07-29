"""strategy_orchestrator — propose only, never auto-mutate scoring."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.video_analysis.strategy_orchestrator import propose_retirements  # noqa: E402


def test_propose_never_auto_applies():
    out = propose_retirements(
        gate_summary={
            "scoring_allowed_ids": ["feature:support"],
            "rejected": ["feature:weak", "feature:support"],
            "passed": ["feature:support"],
            "demo_blocked": False,
            "count": 2,
        },
        ensemble_models=[
            {"name": "rf", "stable": False, "lift_vs_uniform": 0.9, "walk_forward_mean_hits": 0.5},
            {"name": "ok", "stable": True, "lift_vs_uniform": 1.2, "walk_forward_mean_hits": 1.0},
        ],
        leaderboard=[{"key": "support", "mean_top6": 0.2, "rounds": 5}],
    )
    assert out["auto_mutate_scoring"] is False
    assert out["honesty"]
    assert all(c["auto_applied"] is False and c["requires_human"] is True for c in out["candidates"])
    ids = {c["model_id"] for c in out["candidates"]}
    assert "feature:weak" in ids
    assert "ensemble:rf" in ids
    assert "feature:support" in out["unchanged"]
    assert "ensemble:ok" in out["unchanged"]
    assert "feature:support" not in ids
    assert any(c["model_id"] == "signal:support" for c in out["candidates"])
