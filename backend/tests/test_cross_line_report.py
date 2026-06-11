from app.video_analysis.line_overlap_patterns import (
    build_cross_line_analysis_report,
    extract_betting_lines,
)


def _details_with_lines():
    return [
        {
            "source_image": "a.jpg",
            "image_index": 1,
            "image_label": "이미지 1",
            "lines": [
                {"line_index": 0, "label": "A", "numbers": [7, 12, 24], "mark_scores": {"7": 2, "12": 2, "24": 2}},
                {"line_index": 1, "label": "B", "numbers": [7, 12, 30], "mark_scores": {"7": 2, "12": 2, "30": 2}},
            ],
        },
        {
            "source_image": "b.jpg",
            "image_index": 2,
            "image_label": "이미지 2",
            "lines": [
                {"line_index": 2, "label": "C", "numbers": [7, 12, 35], "mark_scores": {"7": 2, "12": 2, "35": 2}},
            ],
        },
    ]


def test_cross_report_pair_and_triple_locations():
    lines = extract_betting_lines(_details_with_lines())
    report = build_cross_line_analysis_report(lines, min_repeat=2)
    pair_nums = [tuple(x["numbers"]) for x in report["pair_sets"]]
    assert (7, 12) in pair_nums
    top_pair = next(x for x in report["pair_sets"] if x["numbers"] == [7, 12])
    assert top_pair["appearance_count"] >= 3
    assert any("[이미지 1]의 A줄" in loc for loc in top_pair["locations"])
    assert any("[이미지 2]의 C줄" in loc for loc in top_pair["locations"])
    assert "■ 1." in report["formatted_text"]
    assert "■ 2." in report["formatted_text"]
    assert "■ 3." in report["formatted_text"]
    assert report["summary_opinion"]
