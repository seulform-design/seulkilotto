"""carryover_learning smoke test — 이월 역산 백테스트 구조·기준선·누수 없음 검증."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.video_analysis import carryover_learning as cl  # noqa: E402
from app.video_analysis import feature_learning_engine as fle  # noqa: E402
from app.video_analysis.feature_learning_engine import build_number_features, RoundSample  # noqa: E402


def _mk(rno, auto, semi, win):
    return RoundSample(rno, auto, semi, win, build_number_features(auto, semi))


def test_carryover_detects_injected_signal_and_no_leakage(monkeypatch):
    # 강수(1-12)를 반복 등록. round1 당첨은 강수와 무관, round2/3 당첨엔 강수 미당첨 번호가 이월.
    auto = [[1, 2, 3, 4, 5, 6]] * 10 + [[7, 8, 9, 10, 11, 12]] * 10
    semi = [[1, 2, 3, 4, 5, 6]] * 8 + [[7, 8, 9, 10, 11, 12]] * 8
    r1 = _mk(1, auto, semi, [40, 41, 42, 43, 44, 45])
    r2 = _mk(2, auto, semi, [1, 7, 20, 21, 22, 23])   # 강수 1,7 이 이월 당첨
    r3 = _mk(3, auto, semi, [2, 8, 30, 31, 32, 33])   # 강수 2,8 이 이월 당첨
    monkeypatch.setattr(fle, "collect_round_samples", lambda: [r1, r2, r3])

    out = cl.build_carryover_learning()
    assert out["ok"] is True
    assert out["round_count"] == 3
    assert out["backtest"]["pairs"] == 2
    # 주입한 이월 신호 → K6 lift > 1
    assert out["backtest"]["by_k"]["6"]["lift"] > 1.0
    # 기준선 = pool * 6/45 (선형기대) 정확
    k6 = out["backtest"]["by_k"]["6"]
    assert abs(k6["exp"] - k6["pairs"] * 6 * (6 / 45)) < 1e-6
    # 누수 없음: 이번회차 후보는 최신(r3) 당첨을 포함하지 않는다
    cand = {c["number"] for c in out["current_candidates"]}
    assert cand.isdisjoint({2, 8, 30, 31, 32, 33})


def test_carryover_insufficient_rounds(monkeypatch):
    monkeypatch.setattr(fle, "collect_round_samples", lambda: [])
    out = cl.build_carryover_learning()
    assert out["ok"] is False
    assert out["calibration_flat"] is True
    assert out["current_candidates"] == []


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-q"]))
