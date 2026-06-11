import pytest

from app.video_analysis.line_overlap_patterns import extract_betting_lines
from app.video_analysis.manual_entry import (
    MANUAL_LAYOUT,
    analyze_manual_slips,
    build_manual_slip_payload,
    parse_numbers_text,
    validate_game_numbers,
)

SAMPLE_SLIP = {
    "name": "테스트 용지",
    "lines": [
        {"label": "A", "numbers": [12, 14, 22, 25, 38, 42]},
        {"label": "B", "numbers": [7, 10, 24, 25, 38, 41]},
        {"label": "C", "numbers": [12, 27, 32, 37, 38, 44]},
        {"label": "D", "numbers": [1, 2, 5, 12, 18, 32]},
        {"label": "E", "numbers": [11, 14, 15, 16, 32, 39]},
    ],
}


def test_parse_numbers_text():
    assert parse_numbers_text("12 14 22 25 38 42") == [12, 14, 22, 25, 38, 42]


def test_validate_game_numbers():
    assert validate_game_numbers([1, 2, 3, 4, 5, 6]) == [1, 2, 3, 4, 5, 6]
    with pytest.raises(ValueError):
        validate_game_numbers([1, 2, 3, 4, 5], line_label="A")


def test_build_manual_slip_payload():
    payload = build_manual_slip_payload(1, SAMPLE_SLIP["lines"])
    assert payload["layout_mode"] == MANUAL_LAYOUT
    assert len(payload["lines"]) == 5
    assert payload["lines"][0]["label"] == "A"
    assert payload["lines"][0]["numbers"] == [12, 14, 22, 25, 38, 42]


def test_analyze_manual_slips_review():
    result = analyze_manual_slips([SAMPLE_SLIP], sheet_intent="review")
    assert result["meta"]["entry_mode"] == "manual"
    assert result["meta"]["physical_sheets_detected"] == 1
    assert result["extracted_visual_patterns"]["combo_patterns"]
    betting = extract_betting_lines(result["meta"]["sheet_details"])
    assert len(betting) == 5
    assert sorted(betting[0]["numbers"]) == [12, 14, 22, 25, 38, 42]
