"""expand walk-forward · 다중엔진 top24 방출(크기 고정)."""
from __future__ import annotations

from app.video_analysis.feature_learning_engine import RoundSample
from app.video_analysis.review_verification import (
    COVERAGE_BUILD_ID,
    DEFAULT_EXPAND_SIZE,
    _coverage_hit_audit,
    _coverage_set_from_signals,
    _decade_tier_sets,
    _multi_engine_order,
    _signals,
    _walkforward_expand_policy,
)


def _lines(*tickets: tuple[int, ...]) -> list[list[int]]:
    return [list(t) for t in tickets]


def _sample(round_no: int, winning: list[int], auto, semi) -> RoundSample:
    return RoundSample(
        round_no=round_no,
        auto_lines=auto,
        semi_lines=semi,
        winning=winning,
        features={n: {"support_rank": n} for n in range(1, 46)},
    )


def test_walkforward_picks_expand_mode_and_coverage_emits_24():
    s1 = _sample(
        1001,
        [1, 2, 3, 4, 5, 6],
        _lines((1, 2, 3, 7, 8, 9), (1, 2, 4, 10, 11, 12), (3, 5, 6, 13, 14, 15)),
        _lines((1, 2, 3, 16, 17, 18), (4, 5, 6, 19, 20, 21), (7, 8, 9, 22, 23, 24)),
    )
    s2 = _sample(
        1002,
        [7, 8, 9, 10, 11, 12],
        _lines((7, 8, 9, 1, 2, 3), (7, 10, 11, 4, 5, 6), (8, 9, 12, 13, 14, 15)),
        _lines((7, 8, 9, 16, 17, 18), (10, 11, 12, 19, 20, 21), (1, 2, 3, 22, 23, 24)),
    )
    s3 = _sample(
        1003,
        [13, 14, 15, 16, 17, 18],
        _lines((13, 14, 15, 1, 2, 3), (13, 16, 17, 4, 5, 6), (14, 15, 18, 7, 8, 9)),
        _lines((13, 14, 15, 19, 20, 21), (16, 17, 18, 22, 23, 24), (10, 11, 12, 25, 26, 27)),
    )
    samples = [s1, s2, s3]
    ban = ["auto_freq"]
    wf = _walkforward_expand_policy(samples, exclude_keys=ban)
    assert wf["ok"] is True
    assert wf["selected_size"] in (18, 24, 30)

    sigs = _signals(s1.auto_lines, s1.semi_lines)
    cov = _coverage_set_from_signals(
        sigs,
        signal_key="support",
        selected_by="multi_round",
        exclude_keys=ban,
        expand_mode=wf["selected_mode"],
        expand_size=30,  # WF가 30이어도 방출은 24
    )
    assert set(cov["core6"]).issubset(set(cov["expand18"]))
    assert len(cov["expand18"]) == DEFAULT_EXPAND_SIZE == 24
    assert cov["expand_size"] == 24
    assert cov["coverage_build"] == COVERAGE_BUILD_ID == "expand24-v6-multi"
    assert cov["expand18_mode"] == "multi_engine"
    assert "multi_engine" in cov

    audit = _coverage_hit_audit(sigs, cov, s1.winning, exclude_keys=ban)
    assert audit["catchable_count"] + len(audit["uncatchable"]) == 6


def test_walkforward_fallback_when_too_few_samples():
    wf = _walkforward_expand_policy([], exclude_keys=["auto_freq"])
    assert wf["ok"] is False
    assert wf["selected_size"] == DEFAULT_EXPAND_SIZE


def test_decade_expected_promoted_into_expand24():
    """구간 기대수에 있는 번호는 주신호 순위가 밀려도 다중엔진 확장에 들어갈 수 있다."""
    # 단번대: 1,2,3 강수 / 4,5,7 기대 후보가 되도록 빈도 배치
    auto = _lines(
        *[(1, 2, 3, 10, 20, 30)] * 8,
        *[(4, 5, 7, 11, 21, 31)] * 3,
        (12, 22, 32, 40, 41, 42),
    )
    semi = _lines(
        *[(1, 2, 3, 13, 23, 33)] * 8,
        *[(4, 5, 7, 14, 24, 34)] * 3,
        (15, 25, 35, 40, 41, 43),
    )
    sigs = _signals(auto, semi)
    strong, expected = _decade_tier_sets(sigs)
    assert 7 in strong or 7 in expected
    order, meta = _multi_engine_order(sigs, "support", exclude_keys=["auto_freq"])
    cov = _coverage_set_from_signals(
        sigs,
        signal_key="support",
        selected_by="t",
        exclude_keys=["auto_freq"],
        expand_mode="single_raw",
        expand_size=18,
    )
    assert 7 in cov["expand18"] or 7 in meta["decade_strong"] or 7 in meta["decade_expected"]
    # 다중엔진 상위 24 안에 기대/강수 단번대가 포함
    top24 = set(order[:24])
    assert (strong | expected) & top24


def test_default_expand_is_24():
    assert DEFAULT_EXPAND_SIZE == 24
