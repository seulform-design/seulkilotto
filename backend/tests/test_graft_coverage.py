"""접목 커버리지 API — 구간커버·recall-EV·백테스트."""
from __future__ import annotations

from app.video_analysis.feature_learning_engine import RoundSample
from app.video_analysis.graft_coverage import (
    GRAFT_BUILD_ID,
    _build_sets_for_lines,
    _loo_backtest,
    optimize_sharing_recall,
    pick_coverage_core6,
)


def _lines(*tickets: tuple[int, ...]) -> list[list[int]]:
    return [list(t) for t in tickets]


def test_pick_coverage_promotes_high_decades():
    expand = [5, 6, 9, 11, 15, 16, 21, 25, 27, 31, 36, 39, 41, 43, 45, 1, 4, 7]
    auto = {n: 1.0 for n in expand}
    semi = {n: 1.0 for n in expand}
    # 양쪽 강한 고번호
    for n, a, s in [(6, 7, 7), (11, 8, 8), (15, 7, 7), (39, 5, 5), (43, 4, 4), (7, 6, 6)]:
        auto[n], semi[n] = float(a), float(s)
    scores = {n: float(100 - i) for i, n in enumerate(expand)}
    core = pick_coverage_core6(expand, auto, semi, scores)
    assert len(core) == 6
    assert any(n >= 30 for n in core)
    assert any(n >= 40 for n in core)


def test_recall_ev_keeps_top12_members():
    ranked = list(range(1, 25))
    out = optimize_sharing_recall(ranked, top_window=24, min_from_top12=4)
    assert out is not None
    top12 = set(ranked[:12])
    assert sum(1 for n in out["numbers"] if n in top12) >= 4


def test_build_and_backtest_smoke():
    auto = _lines(
        (5, 6, 9, 11, 15, 16),
        (6, 7, 11, 15, 39, 43),
        (10, 11, 15, 21, 25, 27),
        (6, 11, 16, 31, 36, 41),
    )
    semi = _lines(
        (5, 6, 11, 15, 16, 21),
        (6, 7, 11, 15, 39, 43),
        (9, 11, 15, 25, 39, 45),
        (7, 16, 27, 36, 43, 45),
    )
    built = _build_sets_for_lines(auto, semi)
    assert built is not None
    assert len(built["core6"]) == 6
    assert len(built["expand24"]) == 24 or len(built["expand24"]) >= 6
    win = [6, 7, 11, 15, 39, 43]
    # 확장망이 당첨을 상당수 담는지(용지에 모두 있음)
    assert len(set(built["expand24"]) & set(win)) >= 4

    s = RoundSample(
        round_no=1235,
        auto_lines=auto,
        semi_lines=semi,
        winning=win,
        features={n: {"support_rank": n} for n in range(1, 46)},
    )
    bt = _loo_backtest([s])
    assert bt["ok"] is True
    assert bt["rounds"] == 1
    assert "decade_core6" in bt["means"]
    assert GRAFT_BUILD_ID.startswith("graft-")
