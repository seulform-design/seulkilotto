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


def test_prediction_signals_review_mode_disables_next_round_sources():
    out = build_prediction_signals(intent="review")
    assert out["target_round"] == out["latest_round"]
    assert out["sources"]["photo_sheet"]["intent"] == "review"
    assert out["sources"]["machine"]["available"] is False
    assert out["sources"]["classic"]["available"] is False
    assert out["sources"]["parallel_round"]["available"] is False
