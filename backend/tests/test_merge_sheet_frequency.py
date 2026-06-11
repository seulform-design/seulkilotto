from app.video_analysis.vision import merge_frame_analyses


def test_merge_multi_sheet_uses_per_sheet_overlap_not_photo_count():
    """18장에 번호 1이 있어도 칸 내 겹침 1회면 2회이상 티어에 안 들어감."""
    analyses = [
        {"sheet_mark_counts": {7: 1}, "highlighted": [7], "lines": [], "ocr_numbers": [7]},
        {"sheet_mark_counts": {7: 1}, "highlighted": [7], "lines": [], "ocr_numbers": [7]},
        {"sheet_mark_counts": {12: 3}, "highlighted": [12], "lines": [], "ocr_numbers": [12, 12, 12]},
    ]
    merged = merge_frame_analyses(analyses)
    fop = merged["frequency_overlap_patterns"]
    tier2 = next((t for t in fop["tiers"] if t["min_count"] == 2), None)
    tier3 = next((t for t in fop["tiers"] if t["min_count"] == 3), None)
    assert tier2 is None or 7 not in {x["number"] for x in tier2["items"]}
    assert tier3 is not None
    n12 = next(x for x in tier3["items"] if x["number"] == 12)
    assert n12.get("max_overlap_count", n12.get("overlap_count")) == 3
