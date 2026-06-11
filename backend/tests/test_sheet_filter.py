from app.video_analysis.combo_patterns import analyze_current_round_sheet_combos, sheet_sets_from_details
from app.video_analysis.sheet_grid import filter_marked_numbers_for_combo


def test_filter_by_mark_strength_not_number_order():
    counts = {n: 1 for n in range(1, 21)}
    counts[7] = 5
    counts[12] = 4
    counts[24] = 3
    out = filter_marked_numbers_for_combo(counts)
    assert 7 in out and 12 in out
    assert 20 not in out or len(out) <= 10


def test_sheet_sets_from_details_uses_scores():
    details = [
        {"numbers": list(range(1, 16)), "mark_scores": {str(n): (5 if n == 7 else 1) for n in range(1, 16)}},
        {"numbers": [7, 12, 24], "mark_scores": {"7": 4, "12": 3, "24": 2}},
    ]
    sets = sheet_sets_from_details(details, None)
    assert sets
    assert 7 in sets[0]


def test_analyze_with_details_consistent():
    details = [
        {"numbers": [7, 12, 24], "mark_scores": {"7": 3, "12": 2, "24": 2}},
        {"numbers": [7, 12, 30], "mark_scores": {"7": 3, "12": 2, "30": 2}},
        {"numbers": [7, 12, 24], "mark_scores": {"7": 3, "12": 2, "24": 2}},
        {"numbers": [3, 7, 12], "mark_scores": {"3": 1, "7": 2, "12": 2}},
    ]
    out = analyze_current_round_sheet_combos(sheet_details=details, raw_sheet_count=2)
    assert out.get("combo_verification")
    assert (7, 12) in [tuple(x["numbers"]) for x in out.get("pair_duplicates") or []]
