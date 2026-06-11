"""용지 사진 분석 유닛 테스트 (네트워크 없음)."""
from app.video_analysis.round_resolver import _collect_round_hits, _detect_video_intent
from app.video_analysis.vision import merge_frame_analyses
from app.video_analysis.store import append_analysis, build_accumulated, clear_store
from app.video_analysis.vision_llm import _sanitize_result


def test_round_hits_and_intent():
    hits = _collect_round_hits("1226회 복기 + 1227회 예상용지", "title")
    rounds = {h["round"] for h in hits}
    assert "1226" in rounds and "1227" in rounds
    assert _detect_video_intent("1226회 복기 당첨번호", 1226, 1227) == "review"
    assert _detect_video_intent("1227회 이번주 예상", 1227, 1227) == "current_round"


def test_resolve_ticket_round_user_intent(monkeypatch):
    from pathlib import Path
    from app.video_analysis.round_resolver import resolve_ticket_round

    monkeypatch.setattr(
        "app.video_analysis.round_resolver.get_history_meta",
        lambda: {"latest_round": 1226, "current_round": 1227},
    )
    info = resolve_ticket_round(
        title="용지 사진",
        description="",
        transcript="",
        frame_paths=[],
        user_intent="review",
    )
    assert info["video_intent"] == "review"
    assert info["video_intent_label"] == "복기"


def test_merge_frame_analyses():
    merged = merge_frame_analyses(
        [
            {
                "sheet_mark_counts": {3: 1, 7: 3, 12: 1},
                "highlighted": [7],
                "lines": [{"target_number": 7, "pattern_type": "diagonal line"}],
                "ocr_numbers": [3, 7, 7, 7, 12],
            },
            {
                "sheet_mark_counts": {7: 2, 12: 2},
                "highlighted": [12],
                "lines": [],
                "ocr_numbers": [7, 7, 12, 12],
            },
        ]
    )
    assert merged["identified_multiples"]["type"] in ("쌍수", "중복없음")
    fop = merged["frequency_overlap_patterns"]
    assert fop["tiers"]
    n7 = next(x for x in fop["all_frequent"] if x["number"] == 7)
    assert n7.get("max_overlap_count", n7.get("overlap_count")) >= 2
    assert 7 in merged["strong_candidates"]
    assert merged["frames_analyzed"] == 2


def test_sanitize_vision_result():
    raw = {
        "video_visual_analysis": {"detected_round": "1227", "main_board_summary": "보드 분석"},
        "extracted_visual_patterns": {
            "identified_multiples": {"type": "쌍수", "numbers": [7, 99, 12]},
            "line_patterns": [{"target_number": 7, "pattern_type": "diagonal line"}],
        },
        "final_predictions": {"strong_candidates": [3, 7, 46], "excluded_candidates": [5]},
        "app_ui_message": "1227회 · 추천 3,7",
    }
    out = _sanitize_result(raw)
    assert out["extracted_visual_patterns"]["identified_multiples"]["numbers"] == [7, 12]
    assert out["final_predictions"]["strong_candidates"] == [3, 7]


def test_store_accumulates_votes(monkeypatch, tmp_path):
    monkeypatch.setattr("app.video_analysis.store.STORE_PATH", tmp_path / "store.json")
    clear_store()

    sample = {
        "video_visual_analysis": {
            "video_id": "a",
            "video_title": "용지1",
            "detected_round": "1227",
            "ticket_round": "1227",
        },
        "extracted_visual_patterns": {
            "identified_multiples": {"type": "쌍수", "numbers": [7]},
            "frequency_overlap_patterns": {
                "summary": "test",
                "all_frequent": [{"number": 12, "overlap_count": 4}, {"number": 7, "overlap_count": 2}],
                "tiers": [
                    {"min_count": 2, "label": "2회이상", "pattern_type": "쌍수", "items": [{"number": 7, "overlap_count": 2}]},
                    {"min_count": 3, "label": "3회이상", "pattern_type": "삼수이상", "items": [{"number": 12, "overlap_count": 4}]},
                ],
                "triple_plus_overlap": {"pattern_label": "", "items": [{"number": 12, "overlap_count": 4}]},
            },
            "triple_plus_overlap": {"pattern_label": "", "items": [{"number": 12, "overlap_count": 4}]},
            "line_patterns": [],
        },
        "final_predictions": {"strong_candidates": [7, 12], "excluded_candidates": []},
        "app_ui_message": "test",
    }
    append_analysis("a", sample, source_label="용지1.jpg")
    acc = build_accumulated()
    assert acc["total_analyses"] == 1
    assert 7 in acc["final_predictions"]["strong_candidates"]
