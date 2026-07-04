import pytest

from app.video_analysis.dedup import compute_source_id, compute_ticket_fingerprint
from app.video_analysis.store import (
    DuplicateAnalysisError,
    append_analysis,
    check_stored_duplicate,
    clear_store,
)


def _sample_result(image_id: str, round_no: str, nums: list[int]) -> dict:
    return {
        "video_visual_analysis": {
            "video_id": image_id,
            "video_title": f"photo-{image_id}",
            "ticket_round": round_no,
            "detected_round": round_no,
            "video_intent": "review",
            "video_intent_label": "복기",
        },
        "extracted_visual_patterns": {
            "frequency_overlap_patterns": {
                "summary": "t",
                "all_frequent": [{"number": n, "overlap_count": 3} for n in nums],
                "tiers": [],
                "triple_plus_overlap": {"pattern_label": "", "items": []},
            }
        },
        "final_predictions": {"strong_candidates": nums, "excluded_candidates": []},
        "meta": {
            "sheet_intent": "review",
            "sheet_number_sets": [nums],
        },
        "app_ui_message": "test",
    }


def _sample_result_with_lines(image_id: str, round_no: str, lines: list[list[int]]) -> dict:
    detail_lines = [
        {"label": chr(ord("A") + idx), "numbers": nums}
        for idx, nums in enumerate(lines)
    ]
    return {
        "video_visual_analysis": {
            "video_id": image_id,
            "video_title": f"photo-{image_id}",
            "ticket_round": round_no,
            "detected_round": round_no,
            "video_intent": "review",
            "video_intent_label": "복기",
        },
        "extracted_visual_patterns": {
            "frequency_overlap_patterns": {
                "summary": "t",
                "all_frequent": [],
                "tiers": [],
                "triple_plus_overlap": {"pattern_label": "", "items": []},
            }
        },
        "final_predictions": {"strong_candidates": [], "excluded_candidates": []},
        "meta": {
            "sheet_intent": "review",
            "sheet_details": [
                {
                    "numbers": sorted({n for row in lines for n in row}),
                    "lines": detail_lines,
                }
            ],
        },
        "app_ui_message": "test",
    }


def test_compute_source_id(tmp_path):
    a = tmp_path / "a.jpg"
    b = tmp_path / "b.jpg"
    a.write_bytes(b"\xff\xd8\xff" + b"a")
    b.write_bytes(b"\xff\xd8\xff" + b"b")
    assert compute_source_id([a]) != compute_source_id([b])


def test_duplicate_same_source(monkeypatch, tmp_path):
    monkeypatch.setattr("app.video_analysis.store.STORE_PATH", tmp_path / "store.json")
    clear_store()
    r1 = _sample_result("img1", "1227", [3, 7, 12])
    append_analysis("img1", r1, source_label="test.jpg")
    hit = check_stored_duplicate("img1", r1)
    assert hit is not None
    with pytest.raises(DuplicateAnalysisError):
        append_analysis("img1", r1)


def test_duplicate_same_ticket_with_different_source(monkeypatch, tmp_path):
    monkeypatch.setattr("app.video_analysis.store.STORE_PATH", tmp_path / "store.json")
    clear_store()
    r1 = _sample_result("img1", "1227", [3, 7, 12, 18, 24, 30])
    r2 = _sample_result("img2", "1227", [3, 7, 12, 18, 24, 30])
    assert compute_ticket_fingerprint(r1) == compute_ticket_fingerprint(r2)
    append_analysis("img1", r1, source_label="test-a.jpg")
    hit = check_stored_duplicate("img2", r2)
    assert hit is not None
    with pytest.raises(DuplicateAnalysisError):
        append_analysis("img2", r2, source_label="test-b.jpg")


def test_line_level_fingerprint_avoids_union_collisions():
    r1 = _sample_result_with_lines("img1", "1227", [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]])
    r2 = _sample_result_with_lines("img2", "1227", [[1, 2, 3, 7, 8, 9], [4, 5, 6, 10, 11, 12]])
    assert compute_ticket_fingerprint(r1) != compute_ticket_fingerprint(r2)


def test_content_fingerprint_dedups_across_round_variance(monkeypatch, tmp_path):
    """같은 티켓을 재업로드했는데 회차 인식이 흔들려도(1231→1230) 중복으로 잡힌다."""
    from app.video_analysis.dedup import compute_content_fingerprint
    monkeypatch.setattr("app.video_analysis.store.STORE_PATH", tmp_path / "store.json")
    clear_store()
    lines = [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]]
    r1 = _sample_result_with_lines("imgA", "1231", lines)
    r2 = _sample_result_with_lines("imgB", "1230", lines)  # 회차만 다르게 인식
    # 기존 ticket 지문은 회차 때문에 갈라지지만, content 지문은 동일해야 함
    assert compute_ticket_fingerprint(r1) != compute_ticket_fingerprint(r2)
    assert compute_content_fingerprint(r1) == compute_content_fingerprint(r2)
    append_analysis("imgA", r1, source_label="a.jpg")
    with pytest.raises(DuplicateAnalysisError):
        append_analysis("imgB", r2, source_label="b.jpg")


def test_content_fingerprint_order_independent():
    """용지 분할·줄 순서가 달라도 같은 줄 묶음이면 같은 content 지문."""
    from app.video_analysis.dedup import compute_content_fingerprint
    r1 = _sample_result_with_lines("img1", "1227", [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]])
    r2 = _sample_result_with_lines("img2", "1227", [[7, 8, 9, 10, 11, 12], [1, 2, 3, 4, 5, 6]])
    assert compute_content_fingerprint(r1) == compute_content_fingerprint(r2)


def _manual_result(image_id: str, lines: list[list[int]]) -> dict:
    r = _sample_result_with_lines(image_id, "1231", lines)
    r["video_visual_analysis"]["video_intent"] = "current_round"
    r["meta"]["sheet_intent"] = "current_round"
    r["meta"]["entry_mode"] = "manual"
    return r


def test_manual_resave_replaces_prior_no_pileup(monkeypatch, tmp_path):
    """수기/대량 재저장 — 내용이 달라져도 같은 회차·intent 수기 세트는 1건만
    유지(replace_prior_manual)해 통계가 누적(중복)되지 않는다."""
    monkeypatch.setattr("app.video_analysis.store.STORE_PATH", tmp_path / "store.json")
    clear_store()
    from app.video_analysis.store import append_analysis, _live_entries

    rA = _manual_result("a", [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]])
    append_analysis("a", rA, replace_existing=True, replace_prior_manual=True)
    assert len(_live_entries()) == 1
    # 다른 내용으로 재저장 → 이전 수기 세트 대체(누적 아님)
    rB = _manual_result("b", [[10, 20, 30, 40, 41, 42], [1, 5, 9, 13, 17, 21]])
    append_analysis("b", rB, replace_existing=True, replace_prior_manual=True)
    assert len(_live_entries()) == 1
