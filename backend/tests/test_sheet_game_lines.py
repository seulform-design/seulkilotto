from pathlib import Path

import numpy as np

from app.video_analysis.image_io import write_image_jpg
from app.video_analysis.line_overlap_patterns import extract_betting_lines
from app.video_analysis.sheet_grid import (
    GAME_LINE_COUNT,
    GAME_LINE_LABELS,
    LOTTO_COLS,
    LOTTO_ROWS,
    _slip_layout_mode,
    detect_all_sheets_in_image,
)


def _draw_grid_band(img, y_offset: int, band_h: int, width: int, marked_numbers: list[int]) -> None:
    import cv2

    cell = width // LOTTO_COLS
    for r in range(LOTTO_ROWS):
        for c in range(LOTTO_COLS):
            n = r * LOTTO_COLS + c + 1
            if n > 45:
                continue
            x1, y1 = c * cell, y_offset + r * (band_h // LOTTO_ROWS)
            x2, y2 = x1 + cell, y1 + band_h // LOTTO_ROWS
            cv2.rectangle(img, (x1, y1), (x2, y2), (180, 180, 180), 1)
            if n in marked_numbers:
                cx, cy = x1 + cell // 2, y1 + (band_h // LOTTO_ROWS) // 2
                cv2.circle(img, (cx, cy), max(4, cell // 4), (20, 20, 20), 3)


def _make_5game_slip(path: Path, marks_per_game: list[list[int]]) -> None:
    import cv2

    width = 520
    height = 1500
    img = np.full((height, width, 3), 245, dtype=np.uint8)
    band_h = height // GAME_LINE_COUNT
    for i, marks in enumerate(marks_per_game[:GAME_LINE_COUNT]):
        y0 = i * band_h + 8
        _draw_grid_band(img, y0, band_h - 16, width, marks)
        cv2.putText(
            img,
            GAME_LINE_LABELS[i],
            (12, y0 + 28),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.9,
            (40, 40, 40),
            2,
        )
        if i > 0:
            cv2.line(img, (0, i * band_h), (width, i * band_h), (120, 120, 120), 2)
    write_image_jpg(path, img)


def test_slip_layout_mode_detects_multi_game():
    assert _slip_layout_mode(1500, 520) == "multi_game"
    assert _slip_layout_mode(840, 840) == "single_game"


def test_detect_five_game_lines_abcde(tmp_path):
    marks = [
        [1, 2, 3],
        [7, 8, 9],
        [13, 14, 15],
        [20, 21, 22],
        [30, 31, 32],
    ]
    p = tmp_path / "auto5.jpg"
    _make_5game_slip(p, marks)
    sheets = detect_all_sheets_in_image(p)
    assert sheets
    sheet = sheets[0]
    lines = sheet.get("lines") or []
    assert len(lines) >= 4
    labels = [ln["label"] for ln in lines]
    assert "A" in labels and "E" in labels or "D" in labels
    for ln in lines:
        assert len(ln.get("numbers") or []) >= 2


def test_extract_betting_lines_from_abcde_payload():
    detail = {
        "numbers": [1, 2, 7, 8, 13, 14],
        "mark_scores": {},
        "lines": [
            {"line_index": 0, "label": "A", "numbers": [1, 2, 3], "mark_scores": {"1": 2, "2": 2, "3": 2}},
            {"line_index": 1, "label": "B", "numbers": [7, 8, 9], "mark_scores": {"7": 2, "8": 2, "9": 2}},
            {"line_index": 2, "label": "C", "numbers": [13, 14, 15], "mark_scores": {"13": 2, "14": 2, "15": 2}},
        ],
    }
    lines = extract_betting_lines([detail])
    assert len(lines) == 3
    assert [ln["line_label"] for ln in lines] == ["A", "B", "C"]
    assert lines[0]["line_id"] == "i1-s0-sub0-A"
