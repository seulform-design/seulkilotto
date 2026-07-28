"""백테스트 통계 유의성 + LOO 교차검증 회귀 테스트.

소표본(4회차)에선 lift 가 커도 significant 를 억제(우연 가능)하고, 표본이 커지면 실제
효과를 탐지하는지, leaderboard 의 신호별 유의성과 Leave-One-Out 교차검증 필드가 나오는지
검증한다. 로또는 i.i.d. — 확률을 올리는 게 아니라 '커버리지가 우연 이상인지'만 정직 검정.
"""
from app.video_analysis.feature_learning_engine import RoundSample, build_number_features
from app.video_analysis.review_verification import (
    _coverage_significance,
    _multi_round_backtest,
    _signal_leaderboard,
)


def _make_sample(rnd, auto, semi, winning):
    return RoundSample(
        round_no=rnd,
        auto_lines=auto,
        semi_lines=semi,
        winning=winning,
        features=build_number_features(auto, semi),
    )


def test_significance_small_sample_is_conservative():
    # 4회차, 상위18에 총 20적중(기대 9.6) — z 크지만 소표본이라 significant 억제.
    r = _coverage_significance(20, 4, 18)
    assert r["small_sample"] is True
    assert r["p_value"] < 0.05          # p값 자체는 계산됨
    assert r["significant"] is False    # 소표본이면 유의로 단정하지 않음(정직)
    assert r["lift"] > 1.0
    assert r["ci95"][0] <= r["mean_hit"] <= r["ci95"][1]


def test_significance_detects_real_effect_when_sample_large():
    # 100회차, 상위18 총 300적중(기대 240, 3.0/회차 vs 2.4) — 실제 초과를 탐지.
    r = _coverage_significance(300, 100, 18)
    assert r["small_sample"] is False
    assert r["significant"] is True
    assert r["lift"] > 1.0


def test_significance_null_not_flagged():
    # 기대치 근처(10 ≈ 9.6) — 유의하지 않음.
    r = _coverage_significance(10, 4, 18)
    assert r["significant"] is False
    assert r["p_value"] > 0.05


def test_leaderboard_has_significance_and_loo():
    samples = [
        _make_sample(1, [[1, 2, 3, 4, 5, 6]] * 12, [[1, 2, 3, 4, 5, 7]] * 12, [1, 2, 3, 4, 5, 6]),
        _make_sample(2, [[10, 11, 12, 13, 14, 15]] * 12, [[10, 11, 12, 13, 14, 16]] * 12, [10, 11, 12, 13, 14, 15]),
        _make_sample(3, [[20, 21, 22, 23, 24, 25]] * 12, [[20, 21, 22, 23, 24, 26]] * 12, [20, 21, 22, 23, 24, 25]),
    ]
    lb = _signal_leaderboard(samples)
    assert lb["rounds"] == 3
    assert lb["small_sample"] is True
    assert all("significance" in e for e in lb["leaderboard"])
    assert "loo" in lb
    assert len(lb["loo"]["folds"]) == 3
    for f in lb["loo"]["folds"]:
        assert "chosen_signal" in f and "top18_hit" in f
    assert lb["loo"]["random_baseline"] == round(18 * 6 / 45, 3)


def test_multi_round_backtest_aggregate_has_significance():
    samples = [
        _make_sample(1, [[1, 2, 3, 4, 5, 6]] * 12, [[1, 2, 3, 4, 5, 7]] * 12, [1, 2, 3, 4, 5, 6]),
        _make_sample(2, [[10, 11, 12, 13, 14, 15]] * 12, [[10, 11, 12, 13, 14, 16]] * 12, [10, 11, 12, 13, 14, 15]),
    ]
    mrb = _multi_round_backtest(samples)
    assert mrb["small_sample"] is True
    for k in ("6", "12", "18"):
        assert "significance" in mrb["aggregate"][k]
        assert "p_value" in mrb["aggregate"][k]["significance"]
