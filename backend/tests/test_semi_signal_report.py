"""반자동 빈도(semi_freq) 신호 · 복기 검증 리포트."""
from __future__ import annotations

from app.video_analysis.review_verification import (
    _SIGNAL_LABELS,
    _build_semi_signal_report,
    _signals,
)


def _lines(*tickets: tuple[int, ...]) -> list[list[int]]:
    return [list(t) for t in tickets]


def test_signals_include_semi_freq_excluding_fixed():
    # 반자동 12줄: 7만 전원 반복(고정수). 나머지는 줄마다 달라 ≥50% 미달.
    semi = _lines(*((7, 8 + i, 20 + (i % 9), 30 + (i % 8), 1 + (i % 6), 15 + (i % 5)) for i in range(12)))
    auto = _lines((1, 2, 3, 4, 5, 6), (10, 11, 12, 13, 14, 15))
    sigs = _signals(auto, semi)
    assert "semi_freq" in sigs
    assert "semi_freq" in _SIGNAL_LABELS
    assert sigs["semi_freq"][7] == 0.0  # 고정수 제외
    # 가변 번호 중 최소 하나는 빈도 > 0
    assert any(sigs["semi_freq"][n] > 0 for n in range(1, 46) if n != 7)


def test_semi_signal_report_verdict_and_tops():
    lb = {
        "rounds": 4,
        "small_sample": True,
        "random_baseline": {"top6": 0.8, "top18": 2.4},
        "leaderboard": [
            {
                "key": "semi_freq",
                "label": "반자동 빈도(고정수 제외)",
                "mean_top6": 1.0,
                "mean_top18": 3.0,
                "beats_random18": True,
                "underperforming": False,
                "significance": {"p_value": 0.04, "significant": False, "small_sample": True},
            }
        ],
    }
    semi = _lines((10, 11, 12, 13, 14, 15), (10, 11, 12, 20, 21, 22), (10, 11, 30, 31, 32, 33))
    sigs = _signals([], semi)
    report = _build_semi_signal_report(
        leaderboard=lb,
        current_sigs=sigs,
        current_semi=semi,
        current_fixed=[],
    )
    assert report["ok"] is True
    assert report["mean_top18"] == 3.0
    assert report["beats_random18"] is True
    assert "소표본" in report["verdict"]
    assert 10 in report["current_top12"]
    assert report["show_in_recommend"] is True
