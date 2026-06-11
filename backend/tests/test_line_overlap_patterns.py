from app.video_analysis.line_overlap_patterns import (
    analyze_line_overlap_patterns,
    extract_betting_lines,
    find_cross_line_combos,
    score_lines_vs_reference,
)
from app.video_analysis.combo_patterns import analyze_current_round_sheet_combos
from app.video_analysis.draw_template import _winning_combo_hits


def _details(*sheet_nums):
    return [{"numbers": list(nums), "mark_scores": {str(n): 2 for n in nums}} for nums in sheet_nums]


def test_extract_one_line_per_sheet():
    details = _details({7, 12, 24}, {3, 7, 12})
    lines = extract_betting_lines(details)
    assert len(lines) == 2
    assert lines[0]["line_label"] == "A"


def test_same_line_vs_winning_tiers():
    winning = [4, 6, 13, 17, 26, 28]
    details = _details({4, 6, 13, 20, 21}, {4, 6, 13, 17, 26, 28, 30})
    lines = extract_betting_lines(details)
    hits = score_lines_vs_reference(lines, winning)
    assert any(h["overlap_count"] == 3 for h in hits)
    assert any(h["overlap_count"] == 6 for h in hits)


def test_cross_line_two_three_four():
    details = _details(
        {7, 12, 24},
        {7, 12, 30},
        {7, 12, 24, 35},
        {3, 7, 12},
    )
    lines = extract_betting_lines(details)
    cross = find_cross_line_combos(lines, min_line_repeat=2)
    sizes = {tuple(c["numbers"]): c["line_count"] for c in cross}
    assert sizes[(7, 12)] >= 4
    assert sizes[(7, 12, 24)] >= 2


def test_analyze_current_round_with_reference():
    details = _details({7, 12, 24}, {7, 12, 30}, {7, 12, 24, 35})
    out = analyze_current_round_sheet_combos(
        sheet_details=details,
        reference_numbers=[7, 12, 24, 35, 40],
    )
    assert out["analysis_mode"] == "line_overlap"
    assert any(m["overlap_count"] >= 3 for m in out["same_line_matches"])
    assert any(x["numbers"] == [7, 12] for x in out["pair_duplicates"])
    assert out.get("strong_candidates")


def test_review_winning_line_hits():
    winning = [4, 6, 13, 17, 26, 28]
    details = _details({4, 6, 13, 17, 26, 28}, {4, 6, 13, 1, 2, 3})
    out = _winning_combo_hits(winning, sheet_details=details)
    assert out["same_line_by_tier"]["6"]
    assert out["same_line_by_tier"]["3"]
