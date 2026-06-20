"""이번회차 intent 가 복기 데이터를 끌어오지 않는지 검증."""
from pathlib import Path

import pytest

from app.video_analysis.image_engine import analyze_from_sheet_payloads
from app.video_analysis.store import append_analysis, build_accumulated, clear_store


def _manual_slip_payload(numbers_per_line: list[list[int]]) -> dict:
    lines = []
    labels = ["A", "B", "C", "D", "E"]
    for i, nums in enumerate(numbers_per_line):
        lines.append({"label": labels[i], "numbers": nums})
    return {
        "numbers": sorted({n for row in numbers_per_line for n in row}),
        "mark_scores": {str(n): 2 for row in numbers_per_line for n in row},
        "positions": {},
        "lines": [
            {
                "line_index": i,
                "label": labels[i],
                "numbers": sorted(nums),
                "mark_scores": {n: 2 for n in nums},
                "source_layout": "manual_5x6",
            }
            for i, nums in enumerate(numbers_per_line)
        ],
        "source_image": "수기용지 1",
        "layout_mode": "manual_5x6",
        "source_layout": "manual_5x6",
    }


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


def test_current_round_slice_excludes_review_template(monkeypatch, tmp_path):
    monkeypatch.setattr("app.video_analysis.store.STORE_PATH", tmp_path / "store.json")
    monkeypatch.setattr("app.datasets.current.CURRENT_DIR", tmp_path / "current")
    monkeypatch.setattr("app.datasets.current.STATE_PATH", tmp_path / "current" / "state.json")
    monkeypatch.setattr("app.datasets.current.PHOTO_PATH", tmp_path / "current" / "photo.json")
    monkeypatch.setattr("app.datasets.current.DERIVED_PATH", tmp_path / "current" / "derived.json")
    clear_store()

    review_nums = [7, 12, 19, 23, 31, 40]
    append_analysis("review-batch", _minimal_result("review-batch", "review", "1226", review_nums))

    current_nums = [1, 2, 3, 4, 5, 6]
    append_analysis(
        "current-batch",
        _minimal_result("current-batch", "current_round", "1227", current_nums),
    )

    acc = build_accumulated()
    current_slice = acc["by_intent"]["current_round"]
    assert current_slice.get("saved_review_template") is None
    assert current_slice.get("draw_template") is None
    combo = current_slice["accumulated_combo_patterns"]
    assert not combo.get("reference_numbers")


def test_analyze_current_round_does_not_use_review_reference(monkeypatch):
    """수기 이번회차 분석 시 review_reference_template 미주입."""
    sheets = [
        _manual_slip_payload(
            [
                [7, 12, 14, 22, 25, 38],
                [7, 10, 24, 25, 38, 41],
                [12, 27, 32, 37, 38, 44],
                [1, 2, 5, 12, 18, 32],
                [11, 14, 15, 16, 32, 39],
            ]
        )
    ]
    out = analyze_from_sheet_payloads(
        sheets,
        sheet_intent="current_round",
        title="이번회차 수기",
        source_id="manual-current-1",
        entry_mode="manual",
    )
    evp = out.get("extracted_visual_patterns") or {}
    assert evp.get("review_reference_template") is None
    meta = out.get("meta") or {}
    assert meta.get("draw_template") is None
    combo = evp.get("combo_patterns") or meta.get("combo_patterns") or {}
    assert combo.get("reference_numbers") in (None, [])
