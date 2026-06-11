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
