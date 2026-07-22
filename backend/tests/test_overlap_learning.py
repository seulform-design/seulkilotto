"""줄겹침 학습 · 신호 정면비교 — 아카이브 경로가 실제로 실행되는지 검증.

⚠️ 이 경로는 로컬에 보관 배치가 없으면 조기 반환돼 커버되지 않는다(실제로
_line_freq/_rank_signal 미정의 NameError 가 프로덕션 500 으로만 드러났음).
합성 배치로 build_overlap_learning 의 signal_comparison 까지 강제로 태운다.
"""
import pytest

from app.video_analysis.overlap_learning import (
    build_overlap_learning,
    combo_strength_by_number,
    _compare_signals_across_rounds,
)


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    monkeypatch.setattr("app.video_analysis.store.STORE_PATH", tmp_path / "store.json")
    monkeypatch.setattr("app.datasets.current.CURRENT_DIR", tmp_path / "current")
    monkeypatch.setattr("app.datasets.current.STATE_PATH", tmp_path / "current" / "state.json")
    monkeypatch.setattr("app.datasets.current.PHOTO_PATH", tmp_path / "current" / "photo.json")
    monkeypatch.setattr("app.datasets.current.DERIVED_PATH", tmp_path / "current" / "derived.json")


def _manual_auto_entry(lines):
    return {
        "id": "e1",
        "video_intent": "current_round",
        "ticket_round": "1233",
        "entry_mode": "manual",
        "pick_type": "자동",
        "result": {"meta": {"entry_mode": "manual", "pick_type": "자동", "sheet_details": [{"numbers": l} for l in lines]}},
    }


def test_combo_strength_runs_and_scores():
    # {1,2} 가 개별 빈도 기대보다 '초과' 로 함께 등장해야 lift>1 → 강도>0.
    # (모든 줄에 함께 있으면 lift=1.0 이라 신호 0 — 이건 올바른 보수적 동작이다.)
    lines = [
        [1, 2, 40], [1, 2, 41], [1, 2, 42],  # 1,2 함께 3줄
        [1, 30, 31], [2, 32, 33],            # 1,2 각 1줄 더 (개별 빈도 4)
        [3, 4, 5], [6, 7, 8], [9, 10, 11], [12, 13, 14], [15, 16, 17],  # 노이즈
    ]
    cs = combo_strength_by_number(lines, "t")
    assert len(cs) == 45
    assert cs[1] > 0 and cs[2] > 0  # lift>1 (관측3 > 기대 4*4/10=1.6)
    assert cs[45] == 0.0  # 미등장


def test_compare_signals_no_nameerror():
    """회귀: _line_freq/_rank_signal 미정의로 500 나던 경로를 직접 실행."""
    batch = {
        "round_no": 1233,
        "entries": [
            _manual_auto_entry(
                [[2, 7, 20, 25, 37, 40], [2, 7, 11, 15, 22, 30], [2, 20, 25, 31, 33, 44], [7, 20, 40, 5, 9, 13]]
            )
        ],
    }
    res = _compare_signals_across_rounds([batch], {1233: [2, 7, 20, 25, 37, 40]})
    assert res["rounds"] == 1
    keys = {s["key"] for s in res["signals"]}
    assert keys == {"support", "combo_strength"}
    assert "verdict" in res


def test_build_overlap_learning_full_path(monkeypatch):
    """build_overlap_learning 이 보관 배치 + 당첨으로 끝까지 도는지(500 방지)."""
    from app.video_analysis import store

    hist = store._load_historical_raw()
    hist["archived_current_rounds"] = [
        {
            "round_no": 1233,
            "entries": [
                _manual_auto_entry(
                    [[2, 7, 20, 25, 37, 40], [2, 7, 11, 15, 22, 30], [2, 20, 25, 31, 33, 44], [7, 20, 40, 5, 9, 13]]
                )
            ],
        }
    ]
    store._save_historical_raw(hist)

    import pandas as pd

    df = pd.DataFrame([{"round": 1233, "num1": 2, "num2": 7, "num3": 20, "num4": 25, "num5": 37, "num6": 40, "bonus": 29}])
    monkeypatch.setattr("app.video_analysis.overlap_learning.load_history", lambda: df, raising=False)
    # overlap_learning 은 함수 내부에서 from ..database import load_history 하므로 그쪽을 패치
    monkeypatch.setattr("app.database.load_history", lambda: df)

    res = build_overlap_learning()
    assert res["ok"] is True
    assert res["round_count"] == 1
    assert "signal_comparison" in res
    assert res["signal_comparison"]["rounds"] == 1
