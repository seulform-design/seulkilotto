from pathlib import Path

import numpy as np

from app.video_analysis.sheet_grid import LOTTO_COLS, LOTTO_ROWS, detect_sheet_mark_counts, detect_sheet_numbers
from app.video_analysis.vision import analyze_frame, merge_frame_analyses


def _make_marked_sheet(path: Path, marked_numbers: list[int]) -> None:
    import cv2

    size = 840
    img = np.full((size, size, 3), 245, dtype=np.uint8)
    cell = size // LOTTO_COLS
    for r in range(LOTTO_ROWS):
        for c in range(LOTTO_COLS):
            n = r * LOTTO_COLS + c + 1
            if n > 45:
                continue
            x1, y1 = c * cell, r * cell
            x2, y2 = x1 + cell, y1 + cell
            cv2.rectangle(img, (x1, y1), (x2, y2), (180, 180, 180), 1)
            cv2.putText(
                img,
                str(n),
                (x1 + cell // 4, y1 + cell * 2 // 3),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                (30, 30, 30),
                2,
            )
            if n in marked_numbers:
                cx, cy = x1 + cell // 2, y1 + cell // 2
                cv2.circle(img, (cx, cy), cell // 3, (20, 20, 20), 3)
    from app.video_analysis.image_io import write_image_jpg

    write_image_jpg(path, img)


def test_detect_sheet_mark_counts(tmp_path):
    p = tmp_path / "sheet.jpg"
    _make_marked_sheet(p, [3, 7, 12, 24, 35])
    counts = detect_sheet_mark_counts(p)
    assert len(counts) >= 3
    assert set(counts) & {3, 7, 12, 24, 35}
    assert all(v >= 1 for v in counts.values())


def test_detect_sheet_numbers(tmp_path):
    p = tmp_path / "sheet.jpg"
    _make_marked_sheet(p, [7, 12])
    hits = detect_sheet_numbers(p)
    nums = {n for n, _ in hits}
    assert nums & {7, 12}


def test_analyze_frame_with_grid(tmp_path):
    p = tmp_path / "sheet2.jpg"
    _make_marked_sheet(p, [7, 7, 12, 12, 19])
    frame = analyze_frame(p)
    assert len(frame["ocr_numbers"]) >= 2
    merged = merge_frame_analyses([frame, frame])
    assert merged["strong_candidates"]
