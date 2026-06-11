from pathlib import Path

import numpy as np

from app.video_analysis.image_io import write_image_jpg
from app.video_analysis.line_overlap_patterns import extract_betting_lines
from app.video_analysis.sheet_grid import (
    GAME_LINE_LABELS,
    LOTTO_COLS,
    LOTTO_ROWS,
    _pick_game_rois_from_candidates,
    _rois_look_like_vertical_games,
    build_sheet_payload,
    consolidate_image_sheets,
    detect_all_sheets_in_image,
)


def _draw_mini_grid(img, x0: int, y0: int, w: int, h: int, marked: list[int]) -> None:
    import cv2

    cell_w = w // LOTTO_COLS
    cell_h = h // LOTTO_ROWS
    for r in range(LOTTO_ROWS):
        for c in range(LOTTO_COLS):
            n = r * LOTTO_COLS + c + 1
            if n > 45:
                continue
            x1 = x0 + c * cell_w
            y1 = y0 + r * cell_h
            if n in marked:
                cv2.circle(
                    img,
                    (x1 + cell_w // 2, y1 + cell_h // 2),
                    max(3, min(cell_w, cell_h) // 4),
                    (20, 20, 20),
                    2,
                )


def _make_stacked_grids(path: Path) -> None:
    width, height = 500, 1200
    img = np.full((height, width, 3), 245, dtype=np.uint8)
    marks = [[1, 2, 3], [7, 8, 9], [13, 14, 15], [20, 21, 22], [30, 31, 32]]
    band_h = height // 5
    gw, gh = int(width * 0.85), band_h - 20
    gx = (width - gw) // 2
    for i, nums in enumerate(marks):
        y0 = i * band_h + 10
        _draw_mini_grid(img, gx, y0, gw, gh, nums)
    write_image_jpg(path, img)


def test_vertical_game_roi_detection():
    rois = [(50, 10, 450, 240), (50, 250, 450, 480), (50, 490, 450, 720)]
    assert _rois_look_like_vertical_games(rois)


def test_pick_game_rois_from_six_candidates():
    rois = [
        (50, 10, 450, 220),
        (50, 230, 450, 440),
        (50, 450, 450, 660),
        (50, 670, 450, 880),
        (50, 890, 450, 1100),
        (10, 5, 30, 30),
    ]
    picked = _pick_game_rois_from_candidates(rois)
    assert len(picked) == 5
    assert _rois_look_like_vertical_games(picked)


def test_consolidate_split_sheets_into_abcde():
    marks = [[1, 2, 3], [7, 8, 9], [13, 14, 15], [20, 21, 22], [30, 31, 32]]
    split = []
    for idx, nums in enumerate(marks):
        counts = {n: 2 for n in nums}
        split.append(
            build_sheet_payload(
                counts,
                {},
                source_image="photo.jpg",
                sub_sheet_index=idx,
                lines=[{"line_index": 0, "label": "A", "numbers": nums, "mark_scores": counts}],
            )
        )
    merged = consolidate_image_sheets(split)
    assert len(merged) == 1
    labels = [ln["label"] for ln in merged[0]["lines"]]
    assert labels == ["A", "B", "C", "D", "E"]


def test_stacked_grids_become_abcde(tmp_path):
    p = tmp_path / "stacked.jpg"
    _make_stacked_grids(p)
    sheets = detect_all_sheets_in_image(p)
    assert len(sheets) == 1
    lines = sheets[0].get("lines") or []
    assert len(lines) >= 3
    labels = {ln["label"] for ln in lines}
    assert "A" in labels
    assert labels & {"B", "C", "D", "E"}

    betting = extract_betting_lines([{**sheets[0], "image_index": 1}])
    assert len({b["line_label"] for b in betting}) >= 3
