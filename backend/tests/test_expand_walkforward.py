"""expand walk-forward (mode × size) · top24 가까운 미포착대 보존."""
from __future__ import annotations

from app.video_analysis.feature_learning_engine import RoundSample
from app.video_analysis.review_verification import (
    DEFAULT_EXPAND_SIZE,
    _coverage_hit_audit,
    _coverage_set_from_signals,
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
    assert wf["selected_size"] in (18, 24)
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
    assert len(cov["expand18"]) == wf["selected_size"]
    assert cov["expand_size"] == wf["selected_size"]

    audit = _coverage_hit_audit(sigs, cov, s1.winning, exclude_keys=ban)
    assert audit["catchable_count"] + len(audit["uncatchable"]) == 6
    assert audit["expand_size"] == len(cov["expand18"])


def test_walkforward_fallback_when_too_few_samples():
    wf = _walkforward_expand_policy([], exclude_keys=["auto_freq"])
    assert wf["ok"] is False
    assert wf["selected_size"] == DEFAULT_EXPAND_SIZE


def test_top24_recovers_near_miss_band_like_1234():
    """1234 유형: 당첨이 지지 23–24위에 있으면 top18은 놓치고 top24는 잡는다."""
    # 인위적 줄 — support 순위에서 당첨 일부가 뒤로 밀리게.
    auto = _lines(
        *[(i, i + 1, i + 2, i + 3, i + 4, i + 5) for i in range(1, 20, 2)],
        (19, 20, 21, 22, 23, 24),
        (25, 26, 27, 28, 29, 30),
        (31, 32, 33, 34, 35, 36),
    )
    semi = _lines(
        *[(i, i + 1, i + 2, i + 3, i + 4, i + 5) for i in range(1, 20, 2)],
        (19, 21, 23, 25, 27, 29),
        (31, 33, 35, 37, 39, 41),
    )
    winning = [1, 2, 3, 19, 35, 43]
    # 43을 support에 올리기 위해 양쪽 줄에 반복 삽입
    auto = auto + _lines((15, 21, 23, 30, 36, 43), (15, 21, 23, 30, 36, 43))
    semi = semi + _lines((15, 21, 23, 30, 36, 43), (15, 21, 23, 30, 36, 43))
    sigs = _signals(auto, semi)
    cov18 = _coverage_set_from_signals(
        sigs, signal_key="support", selected_by="t", exclude_keys=["auto_freq"],
        expand_mode="single_raw", expand_size=18,
    )
    cov24 = _coverage_set_from_signals(
        sigs, signal_key="support", selected_by="t", exclude_keys=["auto_freq"],
        expand_mode="single_raw", expand_size=24,
    )
    assert len(cov24["expand18"]) == 24
    # top24 ⊇ top18
    assert set(cov18["expand18"]).issubset(set(cov24["expand18"]))
