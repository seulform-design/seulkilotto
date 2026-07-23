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


def _rounds_with_carryover(n):
    """n개 회차 — 강수(1-12) 미당첨 번호가 다음 회차에 이월 당첨되도록 구성."""
    auto = [[1, 2, 3, 4, 5, 6]] * 10 + [[7, 8, 9, 10, 11, 12]] * 10
    semi = [[1, 2, 3, 4, 5, 6]] * 8 + [[7, 8, 9, 10, 11, 12]] * 8
    wins = [
        [40, 41, 42, 43, 44, 45],
        [1, 7, 20, 21, 22, 23],
        [2, 8, 30, 31, 32, 33],
        [3, 9, 24, 25, 26, 27],
        [4, 10, 28, 29, 34, 35],
    ]
    return [_mk(i + 1, auto, semi, wins[i]) for i in range(n)]


def test_carryover_small_sample_stays_flat_even_with_high_lift(monkeypatch):
    # 3 회차(2 전이): 이월 신호를 주입해도 표본 부족이라 평탄(순위 미가산·배지만).
    monkeypatch.setattr(fle, "collect_round_samples", lambda: _rounds_with_carryover(3))
    out = cl.build_carryover_learning()
    assert out["ok"] is True
    assert out["backtest"]["pairs"] == 2
    assert out["backtest"]["by_k"]["6"]["lift"] > 1.0  # lift 는 계산됨
    assert out["calibration_flat"] is True              # 그러나 표본 부족 → 평탄
    # 기준선 = pool * 6/45 (선형기대) 정확
    k6 = out["backtest"]["by_k"]["6"]
    assert abs(k6["exp"] - k6["pairs"] * 6 * (6 / 45)) < 1e-6
    # 누수 없음: 이번회차 후보는 최신 회차 당첨을 포함하지 않는다
    cand = {c["number"] for c in out["current_candidates"]}
    assert cand.isdisjoint({2, 8, 30, 31, 32, 33})


def test_carryover_validates_with_enough_pairs(monkeypatch):
    # 4 회차(3 전이) + 재현 신호 → 비평탄(신호 반영).
    monkeypatch.setattr(fle, "collect_round_samples", lambda: _rounds_with_carryover(4))
    out = cl.build_carryover_learning()
    assert out["backtest"]["pairs"] == 3
    assert out["calibration_flat"] is False


def test_carryover_insufficient_rounds(monkeypatch):
    monkeypatch.setattr(fle, "collect_round_samples", lambda: [])
    out = cl.build_carryover_learning()
    assert out["ok"] is False
    assert out["calibration_flat"] is True
    assert out["current_candidates"] == []


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-q"]))
