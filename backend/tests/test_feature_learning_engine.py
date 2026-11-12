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


def _mk(n, rng, signal=False):
    out = []
    for r in range(n):
        auto = [sorted(rng.sample(range(1, 46), 6)) for _ in range(12)]
        semi = [sorted(rng.sample(range(1, 46), 6)) for _ in range(6)]
        f = build_number_features(auto, semi)
        if signal:
            top = sorted(range(1, 46), key=lambda k: (-f[k].get("support", 0), k))[:10]
            win = sorted(rng.sample(top, 5) + rng.sample([k for k in range(1, 46) if k not in top], 1))
        else:
            win = sorted(rng.sample(range(1, 46), 6))
        out.append(RoundSample(r + 1, auto, semi, win, f))
    return out


def test_gate_rarely_adopts_under_null_with_multiple_testing():
    """무작위 당첨(귀무)에서 29개 Feature 중 거짓 채택이 거의 없어야 한다(구 게이트: 50~90% 실행에서 채택)."""
    import random

    rng = random.Random(3)
    runs_any = sum(1 for i in range(12) if any(r["adopted"] for r in validate_features(_mk(5, rng), seed=i)))
    assert runs_any <= 2
    rep = validate_features(_mk(5, rng), seed=99)
    assert all(r["multiple_testing"]["method"] == "BH-FDR" for r in rep)


def test_gate_still_detects_real_signal():
    import random

    rep = validate_features(_mk(10, random.Random(7), signal=True), seed=1)
    assert any(r["adopted"] for r in rep)
