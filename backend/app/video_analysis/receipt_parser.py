"""발급 영수증(가로형) — A~E 5줄 × 줄당 6번호 텍스트 추출."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np

from .image_io import read_image_bgr
from .sheet_grid import GAME_LINE_COUNT, GAME_LINE_LABELS, build_sheet_payload

RECEIPT_LAYOUT = "receipt_5x6"
_NUMBERS_PER_LINE = 6
_MIN_RECEIPT_LINES = 4
_MIN_NUMBERS_PER_LINE = 5
_NUM_CONF_MIN = 0.35

_READER = None


def _get_reader():
    global _READER
    if _READER is None:
        import easyocr

        _READER = easyocr.Reader(["en"], gpu=False, verbose=False)
    return _READER


def looks_like_printed_receipt(img) -> bool:
    """가로형 자동번호 영수증 crop 여부."""
    h, w = img.shape[:2]
    if h <= 0 or w <= 0:
        return False
    ratio = w / float(h)
    if ratio >= 1.6 and h <= 900:
        return True
    if ratio >= 1.2 and h <= 320:
        return True
    return False


def _upscale(gray: np.ndarray) -> np.ndarray:
    import cv2

    h, w = gray.shape[:2]
    scale = 3.0 if max(h, w) < 420 else 2.0
    return cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)


def _collect_ocr_numbers(results) -> List[Tuple[float, int, float]]:
    nums: List[Tuple[float, int, float]] = []
    for bbox, text, conf in results:
        if conf < _NUM_CONF_MIN:
            continue
        token = (text or "").strip()
        matched = re.fullmatch(r"0?(\d{1,2})", token)
        if not matched:
            continue
        n = int(matched.group(1))
        if not 1 <= n <= 45:
            continue
        cx = sum(p[0] for p in bbox) / 4.0
        nums.append((cx, n, float(conf)))
    return nums


def _dedupe_sorted_numbers(nums: List[Tuple[float, int, float]]) -> List[int]:
    nums.sort(key=lambda item: item[0])
    dedup: List[Tuple[float, int, float]] = []
    for cx, n, conf in nums:
        if dedup and abs(cx - dedup[-1][0]) < 35:
            if conf > dedup[-1][2]:
                dedup[-1] = (cx, n, conf)
        else:
            dedup.append((cx, n, conf))
    values = [n for _, n, _ in dedup]
    if len(values) > _NUMBERS_PER_LINE:
        values = values[-_NUMBERS_PER_LINE :]
    return values


def _parse_band_numbers(band, reader) -> List[int]:
    if band.size == 0:
        return []
    results = reader.readtext(band, allowlist="0123456789")
    return _dedupe_sorted_numbers(_collect_ocr_numbers(results))


def parse_receipt_lines(img) -> List[Dict[str, Any]] | None:
    """영수증 이미지 → A~E 게임 줄 (각 6번호)."""
    import cv2

    try:
        reader = _get_reader()
    except Exception:
        return None

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    up = _upscale(gray)
    margin = int(up.shape[0] * 0.06)
    content_h = up.shape[0] - 2 * margin
    # 좌측 라벨(A~E) 영역을 잘라내지 않도록 x 오프셋 없음 — D/E 줄 첫 번호 누락 방지
    x0 = 0

    lines: List[Dict[str, Any]] = []
    for i, label in enumerate(GAME_LINE_LABELS[:GAME_LINE_COUNT]):
        y1 = margin + int(content_h * i / GAME_LINE_COUNT)
        y2 = margin + int(content_h * (i + 1) / GAME_LINE_COUNT)
        band = up[y1:y2, x0:]
        numbers = _parse_band_numbers(band, reader)
        if len(numbers) < _MIN_NUMBERS_PER_LINE:
            continue
        mark_scores = {int(n): 2 for n in numbers}
        positions = {
            str(n): {"row": i, "col": col, "game_line": i, "game_label": label}
            for col, n in enumerate(numbers)
        }
        lines.append(
            {
                "line_index": i,
                "label": label,
                "numbers": sorted(numbers),
                "mark_scores": mark_scores,
                "positions": positions,
                "source_layout": RECEIPT_LAYOUT,
            }
        )
    if len(lines) < _MIN_RECEIPT_LINES:
        return None
    return lines


def receipt_parse_quality(lines: List[Dict[str, Any]]) -> bool:
    good = sum(1 for ln in lines if len(ln.get("numbers") or []) >= _MIN_NUMBERS_PER_LINE)
    return good >= _MIN_RECEIPT_LINES


def try_parse_receipt_sheet(
    img,
    *,
    source_image: str = "",
) -> Dict[str, Any] | None:
    lines = parse_receipt_lines(img)
    if not lines or not receipt_parse_quality(lines):
        return None
    merged_counts: Dict[int, int] = {}
    merged_positions: Dict[int, Dict[str, int]] = {}
    for line in lines:
        for n, score in (line.get("mark_scores") or {}).items():
            merged_counts[int(n)] = max(merged_counts.get(int(n), 0), int(score))
        for key, pos in (line.get("positions") or {}).items():
            if isinstance(pos, dict):
                merged_positions[int(key)] = pos
    payload = build_sheet_payload(
        merged_counts,
        merged_positions,
        source_image=source_image,
        sub_sheet_index=0,
        lines=lines,
    )
    payload["layout_mode"] = RECEIPT_LAYOUT
    payload["source_layout"] = RECEIPT_LAYOUT
    for line in payload.get("lines") or []:
        line["source_layout"] = RECEIPT_LAYOUT
    return payload


def detect_receipt_sheet_in_image(path: Path) -> List[Dict[str, Any]]:
    img = read_image_bgr(path)
    if img is None:
        return []
    if not looks_like_printed_receipt(img):
        return []
    sheet = try_parse_receipt_sheet(img, source_image=path.name)
    return [sheet] if sheet else []
