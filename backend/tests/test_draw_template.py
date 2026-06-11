from app.video_analysis.draw_template import (
    analyze_sheets_with_draw_template,
    build_draw_review_template,
    number_to_grid_pos,
    resolve_sheet_round,
)


def test_number_grid_pos():
    assert number_to_grid_pos(1) == {"row": 0, "col": 0}
    assert number_to_grid_pos(8) == {"row": 1, "col": 0}
    assert number_to_grid_pos(13) == {"row": 1, "col": 5}


def test_build_draw_review_template():
    tpl = build_draw_review_template(1226)
    assert tpl["ticket_round"] == "1226"
    assert len(tpl["winning_numbers"]) == 6
    assert tpl["winning_combo_reference"]["pair_count"] == 15
    assert tpl["winning_combo_reference"]["triple_count"] == 20
    assert "13" in tpl["positions"]


def test_resolve_sheet_round():
    review = resolve_sheet_round("review")
    current = resolve_sheet_round("current_round")
    assert review["video_intent"] == "review"
    assert current["video_intent"] == "current_round"
    assert int(review["ticket_round"]) < int(current["ticket_round"])


def test_winning_combo_on_sheets():
    tpl = build_draw_review_template(1226)
    main = tpl["winning_numbers"]
    sheets = [
        {"numbers": set(main), "positions": {n: tpl["positions"][str(n)] for n in main}},
        {"numbers": {main[0], main[1], main[2]}, "positions": {}},
    ]
    out = analyze_sheets_with_draw_template(tpl, sheets)
    assert out["winning_combo_hits"]["pair_duplicates"]
    assert out["position_match_numbers"]
