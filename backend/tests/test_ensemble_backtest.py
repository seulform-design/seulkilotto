"""앙상블 커버리지 천장 백테스트 회귀 테스트.

전 신호를 등가중(Borda)으로 합친 앙상블이 무작위를 이기는지 정직하게 검정하는지,
소표본에선 lift 가 커도 significant 를 억제하는지, 무작위·최고단일과 비교 필드가 나오는지.
⚠️ 로또 i.i.d. — 확률·부분일치 기대값 불변. 앙상블은 천장을 투명하게 보일 뿐.
"""
from app.video_analysis.ensemble_backtest import build_ensemble_backtest, _ensemble_order
from app.video_analysis.feature_learning_engine import RoundSample, build_number_features
from app.video_analysis.review_verification import _signals


def _mk(rnd, auto, semi, win):
    return RoundSample(
        round_no=rnd, auto_lines=auto, semi_lines=semi, winning=win,
        features=build_number_features(auto, semi),
    )


def _samples():
    return [
        _mk(1, [[1, 2, 3, 4, 5, 6]] * 12, [[1, 2, 3, 4, 5, 7]] * 12, [1, 2, 3, 4, 5, 6]),
        _mk(2, [[10, 11, 12, 13, 14, 15]] * 12, [[10, 11, 12, 13, 14, 16]] * 12, [10, 11, 12, 13, 14, 15]),
        _mk(3, [[20, 21, 22, 23, 24, 25]] * 12, [[20, 21, 22, 23, 24, 26]] * 12, [20, 21, 22, 23, 24, 25]),
    ]


def test_ensemble_order_is_permutation_of_45():
    s = _samples()[0]
    sigs = _signals(s.auto_lines, s.semi_lines)
    from app.video_analysis.review_verification import _SIGNAL_LABELS
    order = _ensemble_order(sigs, list(_SIGNAL_LABELS.keys()))
    assert sorted(order) == list(range(1, 46))


def test_ensemble_backtest_small_sample_conservative():
    r = build_ensemble_backtest(_samples())
    assert r["ok"] is True
    assert r["small_sample"] is True
    # 합성 강신호라 lift 는 커도 소표본이라 유의로 단정하지 않는다.
    assert r["ensemble_significance"]["18"]["significant"] is False
    assert r["beats_random"] is False
    assert "best_single_signal" in r
    assert r["random_baseline"]["top18"] == round(18 * 6 / 45, 3)


def test_ensemble_backtest_too_few_rounds():
    r = build_ensemble_backtest(_samples()[:1])
    assert r["ok"] is False
    assert r["rounds"] == 1
