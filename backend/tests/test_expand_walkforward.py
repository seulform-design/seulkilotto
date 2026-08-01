"""expand walk-forward (mode × size) · top36 중하위 미포착대 보존."""
from __future__ import annotations

from app.video_analysis.feature_learning_engine import RoundSample
from app.video_analysis.review_verification import (
    COVERAGE_BUILD_ID,
    DEFAULT_EXPAND_SIZE,
    MAX_EXPAND_SIZE,
    MIN_EXPAND_SIZE,
    _coverage_hit_audit,
    _coverage_set_from_signals,
    _signals,
    _ticket_tail_rescue,
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


def test_walkforward_picks_expand_mode_and_coverage_includes_core():
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
    assert wf["selected_size"] in (24, 30, 36)
    key = f"{wf['selected_mode']}@{wf['selected_size']}"
    assert key in wf["means"]
    assert "means_by_size" in wf

    sigs = _signals(s1.auto_lines, s1.semi_lines)
    cov = _coverage_set_from_signals(
        sigs,
        signal_key="support",
        selected_by="multi_round",
        exclude_keys=ban,
        expand_mode=wf["selected_mode"],
        expand_size=wf["selected_size"],
    )
    assert set(cov["core6"]).issubset(set(cov["expand18"]))
    assert MIN_EXPAND_SIZE <= len(cov["expand18"]) <= MAX_EXPAND_SIZE
    assert cov["expand_size"] == len(cov["expand18"])
    assert cov["coverage_build"] == COVERAGE_BUILD_ID == "expand36-v5"

    audit = _coverage_hit_audit(sigs, cov, s1.winning, exclude_keys=ban)
    assert audit["catchable_count"] + len(audit["uncatchable"]) == 6
    assert audit["expand_size"] == len(cov["expand18"])
    assert "outside_expand" in audit


def test_walkforward_fallback_when_too_few_samples():
    wf = _walkforward_expand_policy([], exclude_keys=["auto_freq"])
    assert wf["ok"] is False
    assert wf["selected_size"] == DEFAULT_EXPAND_SIZE


def test_coverage_floors_small_size_to_24():
    auto = _lines((1, 2, 3, 7, 8, 9), (1, 2, 4, 10, 11, 12), (3, 5, 6, 13, 14, 15))
    semi = _lines((1, 2, 3, 16, 17, 18), (4, 5, 6, 19, 20, 21), (7, 8, 9, 22, 23, 24))
    sigs = _signals(auto, semi)
    cov = _coverage_set_from_signals(
        sigs,
        signal_key="support",
        selected_by="t",
        exclude_keys=["auto_freq"],
        expand_mode="single_raw",
        expand_size=18,  # 하한 24
    )
    assert cov["expand_size"] == 24
    assert len(cov["expand18"]) == 24
    assert cov["coverage_build"] == "expand36-v5"


def test_ticket_tail_rescue_prefers_present():
    ranked = list(range(1, 46))
    present = set(range(1, 40))
    # 비등장 40–45 가 앞에 섞여 있어도 용지 등장분이 먼저 채워짐
    expand = [40, 41, 42, 1, 2, 3]
    out = _ticket_tail_rescue(ranked, present, expand, size=6)
    assert all(n in present for n in out)
    assert len(out) == 6


def test_default_expand_is_36():
    assert DEFAULT_EXPAND_SIZE == 36
