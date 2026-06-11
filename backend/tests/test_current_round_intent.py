from pathlib import Path

import pytest

from app.video_analysis.image_engine import analyze_image_files
from app.video_analysis.store import append_analysis, clear_store, get_photo_review_template


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
        "meta": {
            "sheet_intent": intent,
            "sheet_number_sets": [numbers],
            "photo_review_template": {
                "source": "photo_review",
                "ticket_round": round_no,
                "marked_numbers": numbers,
                "positions": {},
                "combo_patterns": {"pair_duplicates": [], "triple_duplicates": []},
            },
        },
        "app_ui_message": "test",
    }


def test_current_round_uses_photo_review_not_official_draw(monkeypatch, tmp_path):
    monkeypatch.setattr("app.video_analysis.store.STORE_PATH", tmp_path / "store.json")
    clear_store()

    review_nums = [7, 12, 19, 23, 31, 40]
    append_analysis("review-batch", _minimal_result("review-batch", "review", "1226", review_nums))

    photo_tpl = get_photo_review_template()
    assert photo_tpl.get("marked_numbers")
    assert photo_tpl["marked_numbers"] != [4, 6, 13, 17, 26, 28]

    # 빈 이미지 없이 store 기반 로직만 검증
    from app.video_analysis.position_template import apply_template_to_current

    current_sheets = [{"numbers": set(review_nums[:3] + [1, 2]), "positions": {}}]
    applied = apply_template_to_current(photo_tpl, current_sheets)
    assert "복기" in applied["summary"] or applied.get("number_matches") or applied.get("position_match_numbers")
