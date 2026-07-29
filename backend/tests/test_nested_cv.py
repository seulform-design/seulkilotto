"""nested_cv outer hits + shap stub — scoring always blocked."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.video_analysis.feature_learning_engine import RoundSample, build_number_features  # noqa: E402
from app.video_analysis.nested_cv import run_nested_feature_cv  # noqa: E402
from app.video_analysis.shap_drift_stub import build_shap_drift_report  # noqa: E402


def _sample(r: int, winning=None) -> RoundSample:
    auto = [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12], [1, 7, 13, 19, 25, 31]]
    semi = [[1, 2, 3, 14, 15, 16], [7, 8, 20, 21, 22, 23]]
    feats = build_number_features(auto, semi)
    win = winning or [1, 2, 7, 8, 9, 10]
    return RoundSample(r, auto, semi, list(win), feats)


def test_nested_cv_small_sample_no_scoring():
    out = run_nested_feature_cv([_sample(1), _sample(2)], seed=1)
    assert out["scoring_allowed"] is False
    assert out["ok"] is False
    assert out["small_sample"] is True


def test_nested_cv_outer_hits_still_no_scoring():
    samples = [_sample(i) for i in range(1, 8)]
    out = run_nested_feature_cv(samples, seed=2, min_outer=3)
    assert out["scoring_allowed"] is False
    assert out["ok"] is True
    assert out["mean_top6"] is not None
    assert out["outer_folds"] >= 1
    assert all("top6_hits" in row for row in out["picked_models"])
    assert out["version"].startswith("0.2")


def test_shap_drift_stub_experimental():
    empty = build_shap_drift_report([], seed=1)
    assert empty["scoring_allowed"] is False and empty["experimental"] is True
    assert empty["explain"]["experimental"] is True

    samples = [_sample(i) for i in range(1, 4)]
    out = build_shap_drift_report(samples, seed=3)
    assert out["ok"] is True
    assert out["scoring_allowed"] is False
    assert out["experimental"] is True
    assert out["shap"]["method"] == "permutation_proxy"
    assert out["explain"]["experimental"] is True
    assert "100_experimental" in str(out["explain"]["used_data"]["artifact_versions"])
