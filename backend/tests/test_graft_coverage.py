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


def test_light_backtest_is_fast_and_ok():
    """접목 LOO light 경로 — 중첩 EV/LOO 없이 수 초 내 완료(API 타임아웃 회귀 방지)."""
    import time

    auto = _lines(
        *[(5, 6, 9, 16, 15, 19)] * 8,
        *[(21, 27, 25, 39, 36, 31)] * 6,
        (6, 7, 11, 15, 39, 43),
    )
    semi = _lines(
        *[(5, 6, 9, 16, 15, 19)] * 8,
        *[(21, 27, 25, 39, 36, 31)] * 6,
        (6, 7, 11, 15, 39, 43),
    )
    samples = [
        RoundSample(
            round_no=1200 + i,
            auto_lines=auto,
            semi_lines=semi,
            winning=[6, 7, 11, 15, 39, 43],
            features={n: {"support_rank": n} for n in range(1, 46)},
        )
        for i in range(5)
    ]
    t0 = time.time()
    bt = _loo_backtest(samples)
    elapsed = time.time() - t0
    assert bt["ok"] is True
    assert bt["rounds"] == 5
    assert elapsed < 3.0, f"light backtest too slow: {elapsed:.2f}s"


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
    # 기본 핵심 = raw top6 (구간커버가 더 못 잡던 회귀 방지)
    assert built["core6"] == built["raw_top6"]
    assert len(built["decade_core6"]) == 6
    assert len(built["expand24"]) == 24 or len(built["expand24"]) == len(built["ranked"])
    win = [6, 7, 11, 15, 39, 43]
    assert len(set(built["expand24"]) & set(win)) >= 4

    s = RoundSample(
        round_no=1235,
        auto_lines=auto,
        semi_lines=semi,
        winning=win,
        features={n: {"support_rank": n} for n in range(1, 46)},
    )
    bt = _loo_backtest([s, s])  # 소표본 → 무조건 raw
    assert bt["ok"] is True
    assert bt["selected_core_mode"] == "raw_top6"
    assert GRAFT_BUILD_ID == "graft-v9-precision-primary"


def test_decade_worse_than_raw_is_not_emitted_as_default():
    """구간커버가 raw 당첨을 빼면 selected 는 raw."""
    # raw top 에 당첨 몰림, decade 는 고번호로 분산
    auto = _lines(*[(6, 7, 11, 15, 16, 19)] * 5, (32, 34, 36, 39, 41, 43))
    semi = _lines(*[(6, 7, 11, 15, 21, 25)] * 5, (32, 34, 36, 39, 43, 45))
    built = _build_sets_for_lines(auto, semi)
    assert built is not None
    win = [6, 7, 11, 15, 39, 43]
    raw_h = len(set(built["raw_top6"]) & set(win))
    dec_h = len(set(built["decade_core6"]) & set(win))
    # 이 구성에선 raw 가 구간커버 이상이어야 정책 의도와 맞음
    assert raw_h >= dec_h or built["core6"] == built["raw_top6"]
