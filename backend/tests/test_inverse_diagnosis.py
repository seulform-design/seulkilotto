"""역산 진단 — 낮은 top-6 당첨률 → expand18_first 정책·저성과 신호 배제."""
from app.video_analysis.feature_learning_engine import RoundSample, build_number_features
from app.video_analysis.review_verification import (
    _inverse_diagnosis,
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


def test_leaderboard_marks_underperforming_and_skips_auto_freq_when_possible():
    # 당첨이 양쪽 지지에만 잘 잡히도록: 자동·반자동에 당첨이 함께 등장.
    samples = [
        _make_sample(1, [[1, 2, 3, 4, 5, 6]] * 12, [[1, 2, 3, 4, 5, 7]] * 12, [1, 2, 3, 4, 5, 6]),
        _make_sample(2, [[10, 11, 12, 13, 14, 15]] * 12, [[10, 11, 12, 13, 14, 16]] * 12, [10, 11, 12, 13, 14, 15]),
        _make_sample(3, [[20, 21, 22, 23, 24, 25]] * 12, [[20, 21, 22, 23, 24, 26]] * 12, [20, 21, 22, 23, 24, 25]),
    ]
    lb = _signal_leaderboard(samples)
    assert "underperforming_keys" in lb
    assert "random_baseline" in lb
    assert all("underperforming" in e for e in lb["leaderboard"])
    # 지지가 잡히면 best 는 auto_freq 가 아니어야 함(후순위).
    assert lb["best_signal_multi"] != "auto_freq"


def test_inverse_diagnosis_expand18_first_when_top6_fails():
    leaderboard = {
        "rounds": 4,
        "small_sample": True,
        "best_signal_multi": "support",
        "underperforming_keys": ["auto_freq"],
        "leaderboard": [
            {
                "key": "support",
                "label": "양쪽 지지",
                "mean_top6": 0.5,
                "mean_top18": 3.2,
                "beats_random18": True,
                "underperforming": False,
            },
            {
                "key": "auto_freq",
                "label": "자동 빈도",
                "mean_top6": 0.3,
                "mean_top18": 1.8,
                "beats_random18": False,
                "underperforming": True,
            },
        ],
        "loo": {"mean_top18_hit": 2.5, "random_baseline": 2.4, "generalizes": True},
    }
    multi = {
        "small_sample": True,
        "aggregate": {
            "6": {"mean_hit": 0.5},
            "18": {"mean_hit": 3.0},
        },
    }
    missed = {
        "aggregate": {
            "total": 24,
            "top6_any": 4,
            "top18_any": 16,
            "missing_ticket": 4,
            "uncatchable": 2,
            "top30_any": 18,
        }
    }
    diag = _inverse_diagnosis(
        leaderboard=leaderboard,
        multi_round=multi,
        missed=missed,
        summary={"best_top6": 1, "best_top18": 4, "best_label": "양쪽 지지"},
    )
    assert diag["policy"]["coverage_mode"] == "expand18_first"
    assert diag["policy"]["expand18_weight_scale"] > diag["policy"]["core6_weight_scale"]
    assert "auto_freq" in diag["policy"]["banned_signals"]
    assert diag["policy"]["prefer_consensus"] is False
    assert diag["policy"]["core6_mode"] == "best_single"
    # WF 기본/폴백이 single_raw 이면 best_single (구버전은 잘못 best_of_engines 로 표기)
    assert diag["policy"]["expand18_mode"] in ("best_single", "best_of_engines", "merge_recall")
    assert any(p["id"] == "top6_concentration_fail" for p in diag["problems"])
    assert any(p["id"] == "coverage_gap" for p in diag["problems"])
    assert diag["policy"]["multi_round_confidence"] > 0


def test_best_of_engines_excludes_banned_auto_freq():
    """banned(auto_freq) 는 min-rank 에 참여하지 않아야 한다."""
    from app.video_analysis.review_verification import _best_of_engines_order, _signals

    auto = [[1, 2, 3, 4, 5, 6]] * 12
    # 반자동에는 당첨 지지 약하고, 자동에만 많이 산 번호(40)가 있음
    semi = [[10, 11, 12, 13, 14, 15]] * 12
    auto_heavy = [[40, 41, 42, 43, 44, 45]] * 20 + auto
    sigs = _signals(auto_heavy, semi)
    with_ban = _best_of_engines_order(sigs, exclude_keys=["auto_freq"])
    without = _best_of_engines_order(sigs, exclude_keys=None)
    assert len(with_ban) == 45 and len(without) == 45
    # 배제 키가 동작하면 호출이 성공하고 순서가 정의된다(동형 폴백 허용).
    assert set(with_ban) == set(range(1, 46))
