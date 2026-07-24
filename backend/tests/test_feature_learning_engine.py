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
    _detect_fixed_semi,
)


def test_fixed_semi_excluded_from_support():
    # 반자동 12줄, 고정수 7 이 100% 반복 + 자동fill. 자동엔 7 이 일부만.
    semi = [[7, i, i + 1, i + 2, i + 3, i + 4] for i in range(1, 13)]
    auto = [[7, 20, 21, 22, 23, 24]] * 6 + [[10, 11, 12, 13, 14, 15]] * 6
    fixed = _detect_fixed_semi(semi)
    assert 7 in fixed  # 100% 반복 → 고정수
    feats = build_number_features(auto, semi)
    # 고정수 7 은 지지(발견 신호)에서 제외 → support 0, 강한후보 아님
    assert feats[7]["support"] == 0.0
    assert feats[7]["strong_candidate"] == 0.0
    # 표시용 semi_count 는 유지(투명성)
    assert feats[7]["semi_count"] == 12.0
    # 자동fill 번호는 정상 지지
    assert feats[10]["support"] > 0.0
    # 표본 부족(<10줄)이면 감지 안 함(오탐 방지)
    assert _detect_fixed_semi(semi[:5]) == set()


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
