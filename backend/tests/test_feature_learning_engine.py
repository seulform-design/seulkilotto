"""feature_learning_engine smoke tests (no store required)."""
from __future__ import annotations

import sys
from pathlib import Path

# backend/ as import root
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.video_analysis.feature_learning_engine import (  # noqa: E402
    FEATURE_LABELS,
    RoundSample,
    build_number_features,
    recommend_with_contributions,
    validate_features,
)


def test_build_and_validate():
    auto = [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12], [1, 7, 13, 19, 25, 31]]
    semi = [[1, 2, 3, 14, 15, 16], [7, 8, 20, 21, 22, 23]]
    f1 = build_number_features(auto, semi)
    f2 = build_number_features(auto, semi)
    assert len(f1) == 45
    assert "support" in f1[1]
    samples = [
        RoundSample(1, auto, semi, [1, 2, 7, 8, 9, 10], f1),
        RoundSample(2, auto, semi, [3, 4, 5, 6, 11, 12], f2),
    ]
    reports = validate_features(samples, seed=1)
    assert len(reports) == len(FEATURE_LABELS)
    assert all("adopted" in r and "exclude_reason" in r for r in reports)
    rec = recommend_with_contributions(auto, semi, reports)
    # With tiny synthetic data, likely no adopted features — still a valid response.
    assert "ok" in rec
    assert "numbers" in rec


if __name__ == "__main__":
    test_build_and_validate()
    print("ok")
