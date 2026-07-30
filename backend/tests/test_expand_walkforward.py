"""expand18 walk-forward 모드 선택 · coverage 감사 스모크."""
from __future__ import annotations

from app.video_analysis.feature_learning_engine import RoundSample
from app.video_analysis.review_verification import (
    _coverage_hit_audit,
    _coverage_set_from_signals,
    _signals,
    _walkforward_expand_policy,
)


def _lines(*tickets: tuple[int, ...]) -> list[list[int]]:
    return [list(t) for t in tickets]


def _sample(round_no: int, winning: list[int], auto, semi) -> RoundSample:
    # features 는 multi_round 전용 — coverage/WF 경로에서는 미사용.
    return RoundSample(
        round_no=round_no,
        auto_lines=auto,
        semi_lines=semi,
        winning=winning,
        features={n: {"support_rank": n} for n in range(1, 46)},
    )


def test_walkforward_picks_expand_mode_and_coverage_includes_core():
    # 두 회차 이상 — LOO 가능. 당첨이 티켓에 있도록 구성.
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
    assert wf["selected_mode"] in wf["means"]
    assert wf["rounds"] == 3

    sigs = _signals(s1.auto_lines, s1.semi_lines)
    cov = _coverage_set_from_signals(
        sigs,
        signal_key="support",
        selected_by="multi_round",
        exclude_keys=ban,
        expand_mode=wf["selected_mode"],
    )
    assert set(cov["core6"]).issubset(set(cov["expand18"]))
    assert len(cov["expand18"]) == 18
    assert cov["expand18_mode"] == wf["selected_mode"]

    audit = _coverage_hit_audit(sigs, cov, s1.winning, exclude_keys=ban)
    assert audit["catchable_count"] + len(audit["uncatchable"]) == 6
    assert audit["core6_count"] == len(audit["core6_hit"])
    assert audit["expand18_count"] == len(audit["expand18_hit"])


def test_walkforward_fallback_when_too_few_samples():
    wf = _walkforward_expand_policy([], exclude_keys=["auto_freq"])
    assert wf["ok"] is False
    assert wf["selected_mode"] == "boe_balanced"
