"""통합 예측 신호 API 검증."""
from pathlib import Path

import pytest

from app.prediction_signals import RULES_VERSION, build_prediction_signals
from app.video_analysis.store import append_analysis, build_accumulated, clear_store


def _minimal_result(image_id: str, intent: str, round_no: str, numbers: list[int]) -> dict:
    return {
        "video_visual_analysis": {
            "video_id": image_id,
            "video_title": "test",
            "ticket_round": round_no,
            "detected_round": round_no,
            "video_intent": intent,
            "video_intent_label": "복기" if intent == "review" else "이번회차",
        },
        "extracted_visual_patterns": {},
        "final_predictions": {"strong_candidates": numbers, "excluded_candidates": []},
        "meta": {"sheet_intent": intent},
        "app_ui_message": "test",
    }


def test_prediction_signals_returns_unified_strong_candidates():
    out = build_prediction_signals(intent="current_round")
    assert out.get("error") is None
    assert out["rules_version"] == RULES_VERSION
    assert out["strong_candidates"]
    assert out["strong_details"]
    assert all("sources" in item for item in out["strong_details"])
    assert out["sources"]["machine"]["available"]
    assert out["sources"]["classic"]["available"]
    assert out["sources"]["parallel_round"]["available"]
    assert "parallel-strong" in out["source_weights"]


def test_prediction_signals_uses_intent_photo_slice(monkeypatch, tmp_path):
    monkeypatch.setattr("app.video_analysis.store.STORE_PATH", tmp_path / "store.json")
    monkeypatch.setattr("app.datasets.current.CURRENT_DIR", tmp_path / "current")
    monkeypatch.setattr("app.datasets.current.STATE_PATH", tmp_path / "current" / "state.json")
    monkeypatch.setattr("app.datasets.current.PHOTO_PATH", tmp_path / "current" / "photo.json")
    monkeypatch.setattr("app.datasets.current.DERIVED_PATH", tmp_path / "current" / "derived.json")
    clear_store()

    review_nums = [7, 12, 19, 23, 31, 40]
    append_analysis("r1", _minimal_result("r1", "review", "1226", review_nums))
    current_nums = [1, 2, 3, 4, 5, 6]
    append_analysis("c1", _minimal_result("c1", "current_round", "1227", current_nums))

    review_out = build_prediction_signals(intent="review")
    current_out = build_prediction_signals(intent="current_round")

    review_ranked = {x["number"]: x for x in review_out["ranked_numbers"]}
    assert any(
        "photo-vote" in (review_ranked.get(n, {}).get("sources") or [])
        for n in review_nums
    )
    assert review_out["sources"]["photo_sheet"]["intent"] == "review"
    assert current_out["sources"]["photo_sheet"]["intent"] == "current_round"

    acc = build_accumulated()
    assert acc["by_intent"]["review"]["total_analyses"] == 1


def test_prediction_signals_review_mode_enables_signals_and_accuracy():
    """복기 탭: 대상은 최신 추첨 회차(+그 호기). 신호원별 적중률 백테스트 동봉."""
    out = build_prediction_signals(intent="review")
    # 복기 = 이미 추첨된 회차 (이번회차 next 와 분리)
    assert out["target_round"] == out["latest_round"]
    assert out["target_round"] != out["next_round"]
    assert out["machine_id"] in (1, 2, 3)
    assert out["sources"]["photo_sheet"]["intent"] == "review"
    assert out["sources"]["machine"]["available"] is True
    assert out["sources"]["classic"]["available"] is True
    assert out["sources"]["parallel_round"]["available"] is True

    acc = out.get("signal_accuracy")
    assert acc is not None
    assert acc["available"] is True
    by_source = acc["by_source"]
    for src in ("machine", "classic", "parallel"):
        assert src in by_source
        assert by_source[src]["rounds_tested"] >= 1
    # 약/강 신호원이 식별된다 (이번회차 가중치 보정 참고용)
    assert acc["weakest_source"] in by_source
    assert acc["strongest_source"] in by_source


def test_prediction_signals_review_and_current_use_different_targets():
    """복기 회차·호기와 이번회차 회차·호기는 달라야 한다."""
    review = build_prediction_signals(intent="review")
    current = build_prediction_signals(intent="current_round")
    assert review["target_round"] == review["latest_round"]
    assert current["target_round"] == current["next_round"]
    assert review["target_round"] != current["target_round"]
    # 호기 순환상 인접 회차는 보통 다른 호기(확정 기록 기준). 같으면 스킵하지 않고
    # 최소한 machine_id 필드가 채워져 있는지만 본다.
    assert review["machine_id"] in (1, 2, 3)
    assert current["machine_id"] in (1, 2, 3)


def test_prediction_signals_current_round_has_no_backtest():
    """이번회차는 적중률 백테스트를 동봉하지 않는다 (복기 전용)."""
    out = build_prediction_signals(intent="current_round")
    assert "signal_accuracy" not in out
    assert out["target_round"] == out["next_round"]
