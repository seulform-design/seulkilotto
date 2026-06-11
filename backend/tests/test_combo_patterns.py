from app.video_analysis.combo_patterns import find_repeated_combos
from app.video_analysis.position_template import (
    apply_template_to_current,
    build_sheet_template,
    merge_review_templates,
)


def test_pair_and_triple_duplicates():
    sheets = [
        {7, 12, 24},
        {7, 12, 30},
        {7, 12, 24, 35},
        {3, 7, 12},
    ]
    out = find_repeated_combos(sheets)
    pair_nums = [tuple(x["numbers"]) for x in out["pair_duplicates"]]
    assert (7, 12) in pair_nums
    triple_nums = [tuple(x["numbers"]) for x in out["triple_duplicates"]]
    assert (7, 12, 24) in triple_nums
    hit = next(x for x in out["pair_duplicates"] if x["numbers"] == [7, 12])
    assert hit["repeat_count"] >= 3


def test_review_template_apply_to_current():
    review = merge_review_templates(
        [
            build_sheet_template(
                numbers=[7, 12, 24],
                positions={7: {"row": 0, "col": 6}, 12: {"row": 1, "col": 4}, 24: {"row": 3, "col": 2}},
                ticket_round="1226",
                intent="review",
            )
        ]
    )
    current = [
        {"numbers": {7, 12, 24}, "positions": {7: {"row": 0, "col": 6}, 12: {"row": 1, "col": 4}, 24: {"row": 3, "col": 2}}},
        {"numbers": {7, 12}, "positions": {7: {"row": 0, "col": 6}, 12: {"row": 1, "col": 4}}},
    ]
    applied = apply_template_to_current(review, current)
    assert 7 in applied["position_match_numbers"]
    assert applied["combo_hits"] or applied["number_matches"]
