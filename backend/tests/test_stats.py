"""공용 통계 유의성 헬퍼(stats.py) 회귀 테스트.

이항 정규근사 유의성이 방향·소표본 억제·다중검정 맥락을 올바르게 산출하는지 검증.
로또는 i.i.d. — 확률을 올리는 게 아니라 '관측이 무작위 기준선을 우연 이상으로 초과하는지'만.
"""
import math

from app.video_analysis.stats import (
    binomial_significance,
    expected_false_positives,
    normal_sf,
)


def test_normal_sf_known_values():
    assert abs(normal_sf(0.0) - 0.5) < 1e-9
    assert abs(normal_sf(1.645) - 0.05) < 1e-3


def test_binomial_detects_excess_when_enough_trials():
    # 200 시행, 기대 26.7(6/45), 관측 60 — 실제 초과 탐지.
    r = binomial_significance(60, 200, 6 / 45)
    assert r["small_sample"] is False
    assert r["significant"] is True
    assert r["lift"] > 1.0
    assert r["ci95"][0] <= r["rate"] <= r["ci95"][1]


def test_binomial_null_not_flagged():
    # 관측 ≈ 기대(200*6/45≈26.7) — 유의하지 않음.
    r = binomial_significance(27, 200, 6 / 45)
    assert r["significant"] is False
    assert r["p_value"] > 0.05


def test_binomial_small_trials_flagged():
    # trials < 5 → 소표본, lift 커도 significant 억제.
    r = binomial_significance(3, 4, 6 / 45)
    assert r["small_sample"] is True
    assert r["significant"] is False


def test_binomial_degenerate_inputs():
    r = binomial_significance(0, 0, 6 / 45)
    assert r["small_sample"] is True and r["significant"] is False
    r2 = binomial_significance(5, 10, 0.0)  # invalid p0
    assert r2["significant"] is False


def test_multiple_testing_context():
    mt = expected_false_positives(80, 0.12)
    assert mt["n_tested"] == 80
    assert abs(mt["expected_false_positives"] - 9.6) < 1e-6
    assert mt["bonferroni_alpha"] == round(0.12 / 80, 5)
    # 0개 검정 → 나눗셈 방어
    mt0 = expected_false_positives(0, 0.05)
    assert mt0["expected_false_positives"] == 0.0
