"""로또 자동번호표 격자 분석 — Tesseract 없이 OpenCV만으로 표시 번호 추출."""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np

from .image_io import read_image_bgr

LOTTO_COLS = 7
LOTTO_ROWS = 7
ALL_NUMBERS = set(range(1, 46))
GAME_LINE_COUNT = 5
GAME_LINE_LABELS = ("A", "B", "C", "D", "E")
BAND_EDGE_TRIM = 0.05


def _cell_number(row: int, col: int) -> int | None:
    n = row * LOTTO_COLS + col + 1
    return n if n in ALL_NUMBERS else None


def _resize_for_analysis(img, max_side: int = 1400):
    import cv2

    h, w = img.shape[:2]
    scale = min(1.0, max_side / max(h, w))
    if scale < 1.0:
        return cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA), scale
    return img, 1.0


def _iou_box(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    area_a = max(1, (ax2 - ax1) * (ay2 - ay1))
    area_b = max(1, (bx2 - bx1) * (by2 - by1))
    return inter / float(area_a + area_b - inter)


def _nms_grid_boxes(boxes: List[tuple[int, int, int, int, float]], iou_thresh: float = 0.35) -> List[tuple[int, int, int, int]]:
    if not boxes:
        return []
    boxes = sorted(boxes, key=lambda b: b[4], reverse=True)
    kept: List[tuple[int, int, int, int]] = []
    for x1, y1, x2, y2, _ in boxes:
        rect = (x1, y1, x2, y2)
        if any(_iou_box(rect, k) > iou_thresh for k in kept):
            continue
        kept.append(rect)
    return sorted(kept, key=lambda b: (b[1], b[0]))


def _find_all_grid_rois(gray: np.ndarray) -> List[tuple[int, int, int, int]]:
    """사진 안 복수 용지 격자 영역 탐지."""
    import cv2

    h, w = gray.shape[:2]
    img_area = h * w
    min_area = img_area * 0.06
    edges = cv2.Canny(gray, 40, 120)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes: List[tuple[int, int, int, int, float]] = []
    for c in contours:
        x, y, bw, bh = cv2.boundingRect(c)
        area = bw * bh
        if area < min_area:
            continue
        if bw < w * 0.22 or bh < h * 0.10:
            continue
        if bw > w * 0.98 and bh > h * 0.98:
            continue
        aspect = bw / max(bh, 1)
        if aspect < 0.35 or aspect > 3.0:
            continue
        pad_x = int(bw * 0.02)
        pad_y = int(bh * 0.02)
        boxes.append(
            (
                max(0, x - pad_x),
                max(0, y - pad_y),
                min(w, x + bw + pad_x),
                min(h, y + bh + pad_y),
                float(area),
            )
        )
    rois = _nms_grid_boxes(boxes)
    if len(rois) >= 2:
        return rois
    return [_find_grid_roi(gray)]


def _find_grid_roi(gray: np.ndarray) -> tuple[int, int, int, int]:
    """용지 격자가 있을 법한 영역 (상단 회차·하단 여백 제외)."""
    h, w = gray.shape[:2]
    y1 = int(h * 0.08)
    y2 = int(h * 0.92)
    x1 = int(w * 0.04)
    x2 = int(w * 0.96)

    edges = __import__("cv2").Canny(gray, 40, 120)
    contours, _ = __import__("cv2").findContours(edges, __import__("cv2").RETR_EXTERNAL, __import__("cv2").CHAIN_APPROX_SIMPLE)
    best = None
    best_area = 0
    min_area = w * h * 0.15
    for c in contours:
        x, y, bw, bh = __import__("cv2").boundingRect(c)
        area = bw * bh
        if area < min_area:
            continue
        if bw < w * 0.35 or bh < h * 0.25:
            continue
        if area > best_area:
            best_area = area
            best = (x, y, x + bw, y + bh)
    if best:
        bx1, by1, bx2, by2 = best
        return (
            max(x1, bx1),
            max(y1, by1),
            min(x2, bx2),
            min(y2, by2),
        )
    return x1, y1, x2, y2


def _cell_mark_score(cell_bgr: np.ndarray) -> float:
    """칸 안 손글씨·동그라미·색칠 정도."""
    import cv2

    if cell_bgr.size == 0:
        return 0.0
    h, w = cell_bgr.shape[:2]
    if h < 8 or w < 8:
        return 0.0

    gray = cv2.cvtColor(cell_bgr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    _, ink = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    margin = max(2, min(h, w) // 5)
    ring = np.zeros_like(ink)
    ring[:margin, :] = ink[:margin, :]
    ring[-margin:, :] = ink[-margin:, :]
    ring[:, :margin] = np.maximum(ring[:, :margin], ink[:, :margin])
    ring[:, -margin:] = np.maximum(ring[:, -margin:], ink[:, -margin:])
    ink_ratio = float(ring.mean()) / 255.0

    hsv = cv2.cvtColor(cell_bgr, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    color_mark = float(((sat > 45) & (val < 220)).mean())

    circles = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=max(8, min(h, w) // 2),
        param1=60,
        param2=18,
        minRadius=max(3, min(h, w) // 10),
        maxRadius=max(6, min(h, w) // 2),
    )
    circle_score = 0.35 if circles is not None and len(circles[0]) > 0 else 0.0

    return ink_ratio * 2.2 + color_mark * 0.8 + circle_score


def _cell_overlap_layers(cell_bgr: np.ndarray) -> int:
    """한 칸 안 표시 겹침 횟수 (동그라미·손글씨 레이어)."""
    import cv2

    score = _cell_mark_score(cell_bgr)
    if score < 0.06:
        return 0

    h, w = cell_bgr.shape[:2]
    gray = cv2.cvtColor(cell_bgr, cv2.COLOR_BGR2GRAY)
    circles = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=max(6, min(h, w) // 3),
        param1=55,
        param2=16,
        minRadius=max(2, min(h, w) // 12),
        maxRadius=max(5, min(h, w) // 2),
    )
    circle_n = len(circles[0]) if circles is not None else 0

    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    _, ink = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(ink, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    blob_n = sum(1 for c in contours if cv2.contourArea(c) >= max(12, (h * w) // 80))

    score_layers = 1
    if score >= 0.14:
        score_layers = 2
    if score >= 0.24:
        score_layers = 3
    if score >= 0.36:
        score_layers = 4
    if score >= 0.50:
        score_layers = 5

    layers = max(circle_n, blob_n, score_layers)
    return min(int(layers), 6)


def _neighbor_mean(scores: List[List[float]], r: int, c: int) -> float:
    vals: List[float] = []
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if dr == 0 and dc == 0:
                continue
            rr, cc = r + dr, c + dc
            if 0 <= rr < len(scores) and 0 <= cc < len(scores[0]):
                vals.append(scores[rr][cc])
    return float(np.mean(vals)) if vals else 0.0


def _pick_marked_cells(scores: List[List[float]]) -> List[Tuple[int, int]]:
    rel_scores: List[List[float]] = []
    for r, row in enumerate(scores):
        rel_row: List[float] = []
        for c, s in enumerate(row):
            rel_row.append(s - _neighbor_mean(scores, r, c))
        rel_scores.append(rel_row)

    flat = [s for row in rel_scores for s in row if s > 0]
    if not flat:
        flat = [s for row in scores for s in row if s > 0]
        rel_scores = scores
    if not flat:
        return []

    arr = np.array(flat, dtype=np.float32)
    med = float(np.median(arr))
    mad = float(np.median(np.abs(arr - med))) or 0.01
    threshold = med + max(0.04, mad * 1.8)
    marked: List[Tuple[int, int]] = []
    for r, row in enumerate(rel_scores):
        for c, s in enumerate(row):
            if s >= threshold and scores[r][c] >= 0.08:
                marked.append((r, c))
    return marked


def _extract_cell(roi, r: int, c: int, cell_h: float, cell_w: float):
    cy1 = int(r * cell_h)
    cy2 = int((r + 1) * cell_h)
    cx1 = int(c * cell_w)
    cx2 = int((c + 1) * cell_w)
    pad_y = max(1, int(cell_h * 0.06))
    pad_x = max(1, int(cell_w * 0.06))
    return roi[cy1 + pad_y : cy2 - pad_y, cx1 + pad_x : cx2 - pad_x]


def _should_try_five_bands(rh: int, rw: int) -> bool:
    """자동5 — 세로 5구역 분할 시도 여부 (정사각 단일 격자 제외)."""
    if rh < 200 or rw < 70:
        return False
    if rh >= rw * 1.12 and rh >= 260:
        return True
    if rh >= 380 and rh >= rw * 1.06:
        return True
    if rh >= 520 and rh > rw:
        return True
    return False


def _slip_layout_mode(rh: int, rw: int, *, force_five_bands: bool = False) -> str:
    """세로로 긴 용지 = 자동5(A~E), 정사각에 가까우면 단일 게임."""
    if force_five_bands or _should_try_five_bands(rh, rw):
        return "multi_game"
    if rh < 120 or rw < 80:
        return "single_game"
    return "single_game"


def _scan_roi_counts(
    roi,
    origin: Tuple[int, int],
    *,
    grid_rows: int | None = None,
) -> tuple[Dict[int, int], Dict[int, Dict[str, int]]]:
    """한 격자 ROI — 번호별 겹침 횟수 + 격자 위치."""
    x1, y1 = origin
    rh, rw = roi.shape[:2]
    if rh < 40 or rw < 60:
        return {}, {}
    rows = int(grid_rows or LOTTO_ROWS)
    rows = max(5, min(LOTTO_ROWS, rows))
    cell_h = rh / rows
    cell_w = rw / LOTTO_COLS
    layers: List[List[int]] = []
    scores: List[List[float]] = []

    for r in range(rows):
        row_layers: List[int] = []
        row_scores: List[float] = []
        for c in range(LOTTO_COLS):
            if _cell_number(r, c) is None:
                row_layers.append(0)
                row_scores.append(0.0)
                continue
            cell = _extract_cell(roi, r, c, cell_h, cell_w)
            row_layers.append(_cell_overlap_layers(cell))
            row_scores.append(_cell_mark_score(cell))
        layers.append(row_layers)
        scores.append(row_scores)

    marked = _pick_marked_cells(scores)
    if len(marked) < 2:
        flat = [lv for row in layers for lv in row if lv > 0]
        if flat:
            threshold = max(1, int(np.percentile(flat, 72)))
            marked = [
                (r, c)
                for r, row in enumerate(layers)
                for c, lv in enumerate(row)
                if lv >= threshold and _cell_number(r, c) is not None
            ]

    counts: Dict[int, int] = {}
    positions: Dict[int, Dict[str, int]] = {}
    for r, c in marked:
        num = _cell_number(r, c)
        if num is None:
            continue
        lv = max(1, layers[r][c])
        counts[num] = max(counts.get(num, 0), lv)
        positions[num] = {"row": r, "col": c}
    return counts, positions


def _build_line_payload(
    line_index: int,
    counts: Dict[int, int],
    positions: Dict[int, Dict[str, int]],
) -> Dict[str, Any] | None:
    """게임 줄 A~E — 줄별 표시 강도 필터."""
    if not counts:
        return None
    mark_scores = {int(k): int(v) for k, v in counts.items() if 1 <= int(k) <= 45}
    nums = filter_marked_numbers_for_combo(mark_scores, max_numbers=12, soft_cap=9)
    if len(nums) < 2:
        return None
    pos_out: Dict[str, Dict[str, int]] = {}
    for n in nums:
        p = positions.get(n) or positions.get(str(n))
        if isinstance(p, dict):
            pos_out[str(n)] = {
                "row": int(p.get("row", 0)),
                "col": int(p.get("col", 0)),
            }
    label = GAME_LINE_LABELS[line_index % len(GAME_LINE_LABELS)]
    return {
        "line_index": line_index,
        "label": label,
        "numbers": sorted(nums),
        "mark_scores": {str(k): mark_scores[k] for k in nums if k in mark_scores},
        "positions": pos_out,
    }


def _merge_sheet_level(
    lines: List[Dict[str, Any]],
) -> tuple[Dict[int, int], Dict[int, Dict[str, int]]]:
    """용지 전체 numbers/positions — 줄 합집합(하위 호환)."""
    merged_counts: Dict[int, int] = {}
    merged_positions: Dict[int, Dict[str, int]] = {}
    for line in lines:
        for k, v in (line.get("mark_scores") or {}).items():
            n = int(k)
            merged_counts[n] = max(merged_counts.get(n, 0), int(v))
        for k, p in (line.get("positions") or {}).items():
            n = int(k)
            if isinstance(p, dict):
                merged_positions[n] = {
                    "row": int(p.get("row", 0)),
                    "col": int(p.get("col", 0)),
                    "game_line": int(line.get("line_index", 0)),
                    "game_label": str(line.get("label") or "A"),
                }
    return merged_counts, merged_positions


def _extract_five_band_lines(roi, origin: Tuple[int, int]) -> List[Dict[str, Any]]:
    """ROI를 세로 5구역으로 나눠 A~E 줄 추출."""
    rh, rw = roi.shape[:2]
    lines: List[Dict[str, Any]] = []
    band_h = rh / GAME_LINE_COUNT
    for i in range(GAME_LINE_COUNT):
        trim = band_h * BAND_EDGE_TRIM
        by1 = int(i * band_h + trim)
        by2 = int((i + 1) * band_h - trim)
        if by2 - by1 < 24:
            continue
        band = roi[by1:by2, :]
        counts, positions = _scan_roi_counts(band, (origin[0], origin[1] + by1))
        line = _build_line_payload(i, counts, positions)
        if line:
            lines.append(line)
    return lines


def _rois_look_like_vertical_games(rois: List[tuple[int, int, int, int]]) -> bool:
    """사진 안 격자 ROI가 세로로 쌓인 자동5 게임 줄인지."""
    if not 2 <= len(rois) <= GAME_LINE_COUNT:
        return False
    ordered = sorted(rois, key=lambda r: (r[1], r[0]))
    widths = [r[2] - r[0] for r in ordered]
    w0 = max(widths[0], 1)
    if not all(abs(w - w0) <= w0 * 0.45 for w in widths):
        return False
    for i in range(1, len(ordered)):
        prev, cur = ordered[i - 1], ordered[i]
        gap = cur[1] - prev[3]
        band_h = max(cur[3] - cur[1], prev[3] - prev[1], 1)
        if gap > band_h * 2.5:
            return False
    return True


def _pick_game_rois_from_candidates(
    rois: List[tuple[int, int, int, int]],
) -> List[tuple[int, int, int, int]]:
    """후보 ROI 중 세로 게임 줄 A~E에 해당하는 5개 선택."""
    ordered = sorted(rois, key=lambda r: (r[1], r[0]))
    if len(ordered) <= GAME_LINE_COUNT:
        return ordered
    best_window = ordered[:GAME_LINE_COUNT]
    best_score = -1.0
    for i in range(len(ordered) - GAME_LINE_COUNT + 1):
        window = ordered[i : i + GAME_LINE_COUNT]
        if not _rois_look_like_vertical_games(window):
            continue
        score = float(sum((r[2] - r[0]) * (r[3] - r[1]) for r in window))
        if score > best_score:
            best_score = score
            best_window = window
    if best_score >= 0:
        return best_window
    areas = sorted(ordered, key=lambda r: (r[2] - r[0]) * (r[3] - r[1]), reverse=True)
    top = sorted(areas[:GAME_LINE_COUNT], key=lambda r: r[1])
    return top


def _lines_from_stacked_rois(
    img,
    rois: List[tuple[int, int, int, int]],
) -> List[Dict[str, Any]]:
    """세로로 나란한 격자 ROI → A,B,C,D,E 한 용지."""
    ordered = _pick_game_rois_from_candidates(rois)
    lines: List[Dict[str, Any]] = []
    for i, (x1, y1, x2, y2) in enumerate(ordered):
        counts, positions = _scan_roi_counts(img[y1:y2, x1:x2], (x1, y1))
        line = _build_line_payload(i, counts, positions)
        if line:
            lines.append(line)
    return lines


def _scan_roi_game_lines(
    roi,
    origin: Tuple[int, int],
    *,
    force_five_bands: bool = False,
) -> tuple[Dict[int, int], Dict[int, Dict[str, int]], List[Dict[str, Any]]]:
    """용지 ROI → A~E 게임 줄 분리 인식."""
    rh, rw = roi.shape[:2]
    mode = _slip_layout_mode(rh, rw, force_five_bands=force_five_bands)
    lines: List[Dict[str, Any]] = []

    if mode == "multi_game":
        lines = _extract_five_band_lines(roi, origin)

    if not lines and mode == "single_game":
        counts, positions = _scan_roi_counts(roi, origin)
        line = _build_line_payload(0, counts, positions)
        if line:
            lines = [line]
        if len(lines) <= 1 and _should_try_five_bands(rh, rw):
            band_lines = _extract_five_band_lines(roi, origin)
            if band_lines:
                lines = band_lines
        if len(lines) > 1:
            merged_counts, merged_positions = _merge_sheet_level(lines)
            return merged_counts, merged_positions, lines
        return counts, positions, lines

    if not lines:
        counts, positions = _scan_roi_counts(roi, origin)
        line = _build_line_payload(0, counts, positions)
        if line:
            lines = [line]
        return counts, positions, lines

    merged_counts, merged_positions = _merge_sheet_level(lines)
    return merged_counts, merged_positions, lines


def _find_slip_rois(gray: np.ndarray) -> List[tuple[int, int, int, int]]:
    """자동5 전체 용지(세로형) 우선 탐지."""
    import cv2

    h, w = gray.shape[:2]
    if h >= w * 1.15 and h >= 200:
        return [(int(w * 0.02), int(h * 0.01), int(w * 0.98), int(h * 0.99))]

    img_area = h * w
    min_area = img_area * 0.12
    edges = cv2.Canny(gray, 40, 120)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    tall: List[tuple[int, int, int, int, float]] = []
    for c in contours:
        x, y, bw, bh = cv2.boundingRect(c)
        area = bw * bh
        if area < min_area:
            continue
        if bw < w * 0.20 or bh < h * 0.28:
            continue
        if bw > w * 0.98 and bh > h * 0.98:
            continue
        aspect = bh / max(bw, 1)
        if aspect < 1.12:
            continue
        pad_x = int(bw * 0.02)
        pad_y = int(bh * 0.01)
        tall.append(
            (
                max(0, x - pad_x),
                max(0, y - pad_y),
                min(w, x + bw + pad_x),
                min(h, y + bh + pad_y),
                float(area * aspect),
            )
        )
    if tall:
        tall.sort(key=lambda b: b[4], reverse=True)
        best = tall[0]
        return [(best[0], best[1], best[2], best[3])]
    return _find_all_grid_rois(gray)


def _best_roi_counts(img, scale: float) -> tuple[Dict[int, int], Dict[int, Dict[str, int]]]:
    import cv2

    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gx1, gy1, gx2, gy2 = _find_grid_roi(gray)
    candidates: List[tuple[Dict[int, int], Dict[int, Dict[str, int]]]] = []
    rois = [
        (gx1, gy1, gx2, gy2),
        (int(w * 0.06), int(h * 0.10), int(w * 0.94), int(h * 0.90)),
        (int(w * 0.10), int(h * 0.14), int(w * 0.90), int(h * 0.86)),
        (0, int(h * 0.08), w, int(h * 0.95)),
    ]
    seen: set[tuple[int, int, int, int]] = set()
    for x1, y1, x2, y2 in rois:
        key = (x1, y1, x2, y2)
        if key in seen:
            continue
        seen.add(key)
        counts, positions = _scan_roi_counts(img[y1:y2, x1:x2], (x1, y1))
        if counts:
            candidates.append((counts, positions))

    if not candidates:
        return {}, {}

    def _rank(item: tuple[Dict[int, int], Dict[int, Dict[str, int]]]) -> tuple[float, int]:
        c, _ = item
        n = len(c)
        if n < 2:
            return (-1.0, 0)
        if 5 <= n <= 12:
            sweet = 18.0
        elif 3 <= n <= 14:
            sweet = 10.0
        elif n <= 18:
            sweet = 2.0
        else:
            sweet = -float(n) * 1.5
        strength = sum(v for v in c.values() if v >= 2)
        return (sweet + strength * 0.15, n)

    return max(candidates, key=_rank)


def filter_marked_numbers_for_combo(
    counts: Dict[int, int] | Dict[str, int],
    *,
    max_numbers: int = 10,
    soft_cap: int = 8,
) -> set[int]:
    """조합 분석용 — 용지당 강한 표시번호만 (표시 강도·횟수 기준)."""
    if not counts:
        return set()
    ranked = sorted(
        ((int(k), int(v)) for k, v in counts.items() if 1 <= int(k) <= 45),
        key=lambda x: (-x[1], x[0]),
    )
    if not ranked:
        return set()
    n = len(ranked)
    cap = soft_cap if n > max_numbers else min(max_numbers, n)
    if n > 16:
        cap = min(7, cap)
    elif n > 12:
        cap = min(8, cap)
    return {num for num, _ in ranked[:cap]}


def build_sheet_payload(
    counts: Dict[int, int],
    positions: Dict[int, Dict[str, int]],
    *,
    source_image: str = "",
    sub_sheet_index: int = 0,
    lines: List[Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    """용지 1장 — A~E 게임 줄 + 표시 강도 필터."""
    game_lines = list(lines or [])
    if game_lines:
        merged_counts, merged_positions = _merge_sheet_level(game_lines)
        counts = merged_counts or counts
        positions = merged_positions or positions

    mark_scores = {int(k): int(v) for k, v in counts.items() if 1 <= int(k) <= 45}
    nums = filter_marked_numbers_for_combo(mark_scores)
    pos_out: Dict[int, Dict[str, int]] = {}
    for n in nums:
        p = positions.get(n) or positions.get(str(n))
        if isinstance(p, dict):
            pos_out[n] = {
                "row": int(p.get("row", 0)),
                "col": int(p.get("col", 0)),
            }
            if p.get("game_line") is not None:
                pos_out[n]["game_line"] = int(p["game_line"])
            if p.get("game_label"):
                pos_out[n]["game_label"] = str(p["game_label"])

    payload: Dict[str, Any] = {
        "numbers": nums,
        "positions": pos_out,
        "mark_scores": {str(k): mark_scores[k] for k in nums if k in mark_scores},
        "raw_mark_count": len(mark_scores),
        "source_image": source_image,
        "sub_sheet_index": sub_sheet_index,
        "lines": game_lines,
        "game_line_count": len(game_lines),
        "game_line_labels": [str(l.get("label") or "") for l in game_lines],
    }
    return payload


def _roi_quality_rank(
    counts: Dict[int, int],
    lines: List[Dict[str, Any]],
) -> tuple[float, int, int]:
    n = len(counts)
    line_n = len(lines)
    if n < 2 and line_n < 1:
        return (-1.0, 0, 0)
    if 5 <= n <= 12:
        sweet = 18.0
    elif 3 <= n <= 14:
        sweet = 10.0
    elif n <= 18:
        sweet = 2.0
    else:
        sweet = -float(n) * 1.2
    strength = sum(v for v in counts.values() if v >= 2)
    multi_bonus = 12.0 if line_n >= 3 else (6.0 if line_n == 2 else 0.0)
    return (sweet + strength * 0.15 + line_n * 4.0 + multi_bonus, n, line_n)


def _candidate_rois(gray: np.ndarray) -> List[tuple[int, int, int, int]]:
    import cv2

    h, w = gray.shape[:2]
    if h >= w * 1.15 and h >= 200:
        return [(int(w * 0.02), int(h * 0.01), int(w * 0.98), int(h * 0.99))]

    gx1, gy1, gx2, gy2 = _find_grid_roi(gray)
    rois = [
        (0, 0, w, h),
        (gx1, gy1, gx2, gy2),
        (int(w * 0.06), int(h * 0.10), int(w * 0.94), int(h * 0.90)),
        (int(w * 0.10), int(h * 0.14), int(w * 0.90), int(h * 0.86)),
        (0, int(h * 0.08), w, int(h * 0.95)),
    ]
    extra = _find_all_grid_rois(gray)
    seen: set[tuple[int, int, int, int]] = set()
    out: List[tuple[int, int, int, int]] = []
    for rect in rois + extra:
        if rect in seen:
            continue
        seen.add(rect)
        out.append(rect)
    return out


def _scan_sheets_from_image(
    img,
) -> List[tuple[Dict[int, int], Dict[int, Dict[str, int]], List[Dict[str, Any]]]]:
    import cv2

    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    grid_rois = _find_all_grid_rois(gray)
    picked_rois = _pick_game_rois_from_candidates(grid_rois) if len(grid_rois) >= 2 else grid_rois
    if len(picked_rois) >= 2 and _rois_look_like_vertical_games(picked_rois):
        stacked_lines = _lines_from_stacked_rois(img, picked_rois)
        if len(stacked_lines) >= 2:
            merged_counts, merged_positions = _merge_sheet_level(stacked_lines)
            return [(merged_counts, merged_positions, stacked_lines)]

    if _should_try_five_bands(h, w):
        full_counts, full_positions, full_lines = _scan_roi_game_lines(
            img,
            (0, 0),
            force_five_bands=True,
        )
        valid_full = [ln for ln in full_lines if len(ln.get("numbers") or []) >= 2]
        if len(valid_full) >= 2:
            return [(full_counts, full_positions, valid_full)]

    rois = _candidate_rois(gray)
    scanned: List[
        tuple[tuple[float, int, int], Dict[int, int], Dict[int, Dict[str, int]], List[Dict[str, Any]], tuple[int, int, int, int]]
    ] = []

    for x1, y1, x2, y2 in rois:
        rh, rw = y2 - y1, x2 - x1
        force = _should_try_five_bands(rh, rw) and (x1, y1, x2, y2) == (0, 0, w, h)
        counts, positions, lines = _scan_roi_game_lines(
            img[y1:y2, x1:x2],
            (x1, y1),
            force_five_bands=force,
        )
        valid_lines = [ln for ln in lines if len(ln.get("numbers") or []) >= 2]
        if not valid_lines and (not counts or len(counts) < 2):
            continue
        if not valid_lines:
            line = _build_line_payload(0, counts, positions)
            valid_lines = [line] if line else []
        if not valid_lines:
            continue
        if not counts:
            counts, positions = _merge_sheet_level(valid_lines)
        rank = _roi_quality_rank(counts, valid_lines)
        scanned.append((rank, counts, positions, valid_lines, (x1, y1, x2, y2)))

    if not scanned:
        return []

    if len(scanned) >= 2:
        small_rois = [item[4] for item in scanned if item[0][2] <= 2]
        if len(small_rois) >= 2 and _rois_look_like_vertical_games(small_rois):
            stacked_lines = _lines_from_stacked_rois(img, small_rois)
            if len(stacked_lines) >= 2:
                merged_counts, merged_positions = _merge_sheet_level(stacked_lines)
                return [(merged_counts, merged_positions, stacked_lines)]

    multi_physical = len(scanned) >= 2 and all(item[0][2] <= 1 for item in scanned)
    if multi_physical and not _rois_look_like_vertical_games([item[4] for item in scanned]):
        return [(c, p, ln) for _, c, p, ln, _ in scanned]

    _, counts, positions, lines, _ = max(scanned, key=lambda item: item[0])
    return [(counts, positions, lines)]


def _line_from_sheet_fallback(sheet: Dict[str, Any], line_index: int) -> Dict[str, Any] | None:
    """저장/분리된 용지 payload → 게임 줄 1개."""
    existing = sheet.get("lines") or []
    if existing:
        src = existing[0]
        label = GAME_LINE_LABELS[line_index % len(GAME_LINE_LABELS)]
        return {
            **src,
            "line_index": line_index,
            "label": label,
            "numbers": sorted(src.get("numbers") or []),
        }
    mark_scores = sheet.get("mark_scores") or {}
    counts = {int(k): int(v) for k, v in mark_scores.items() if 1 <= int(k) <= 45}
    if not counts:
        nums = sheet.get("numbers") or set()
        counts = {int(n): 2 for n in nums if 1 <= int(n) <= 45}
    positions = {
        int(k): v for k, v in (sheet.get("positions") or {}).items() if isinstance(v, dict)
    }
    line = _build_line_payload(line_index, counts, positions)
    if line:
        line["label"] = GAME_LINE_LABELS[line_index % len(GAME_LINE_LABELS)]
        line["line_index"] = line_index
    return line


def consolidate_image_sheets(sheets: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """같은 사진에서 여러 격자가 잡히면 A~E 한 용지로 병합."""
    from collections import defaultdict

    groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for sheet in sheets:
        groups[str(sheet.get("source_image") or "__single")].append(sheet)

    out: List[Dict[str, Any]] = []
    for group in groups.values():
        group.sort(key=lambda s: int(s.get("sub_sheet_index", 0)))
        if len(group) == 1:
            sheet = group[0]
            lines = sheet.get("lines") or []
            if len(lines) == 1 and lines[0].get("label") == "A":
                only = lines[0]
                if int(only.get("line_index", 0)) != 0:
                    only = {**only, "line_index": 0, "label": "A"}
                    sheet = {**sheet, "lines": [only], "game_line_labels": ["A"]}
            out.append(sheet)
            continue

        combined: List[Dict[str, Any]] = []
        for idx, sheet in enumerate(group[:GAME_LINE_COUNT]):
            line = _line_from_sheet_fallback(sheet, idx)
            if line and len(line.get("numbers") or []) >= 2:
                combined.append(line)

        if len(combined) >= 2:
            merged_counts, merged_positions = _merge_sheet_level(combined)
            out.append(
                build_sheet_payload(
                    merged_counts,
                    merged_positions,
                    source_image=group[0].get("source_image", ""),
                    sub_sheet_index=0,
                    lines=combined,
                )
            )
        else:
            out.extend(group)
    return out


def detect_all_sheets_in_image(path: Path) -> List[Dict[str, Any]]:
    """사진 1장 — 용지 1~N장 분리 + 장당 A~E 게임 줄 인식."""
    img = read_image_bgr(path)
    if img is None:
        return []

    from .receipt_parser import looks_like_printed_receipt, try_parse_receipt_sheet

    if looks_like_printed_receipt(img):
        receipt_sheet = try_parse_receipt_sheet(img, source_image=path.name)
        if receipt_sheet:
            return [receipt_sheet]

    img, _scale = _resize_for_analysis(img)
    raw = _scan_sheets_from_image(img)
    out: List[Dict[str, Any]] = []
    for idx, (counts, positions, lines) in enumerate(raw):
        out.append(
            build_sheet_payload(
                counts,
                positions,
                source_image=path.name,
                sub_sheet_index=idx,
                lines=lines,
            )
        )
    return consolidate_image_sheets(out)


def detect_sheet_mark_counts(path: Path) -> Dict[int, int]:
    """한 장 용지 — 번호별 표시 횟수."""
    counts, _ = detect_sheet_analysis(path)
    return counts


def detect_sheet_analysis(path: Path) -> tuple[Dict[int, int], Dict[int, Dict[str, int]]]:
    """한 장 용지 — 번호별 표시 + 7×7 격자 위치 (첫 용지)."""
    sheets = detect_all_sheets_in_image(path)
    if sheets:
        scores = sheets[0].get("mark_scores") or {}
        counts = {int(k): int(v) for k, v in scores.items()}
        positions = {
            int(k): v for k, v in (sheets[0].get("positions") or {}).items()
        }
        if counts:
            return counts, positions
    img = read_image_bgr(path)
    if img is None:
        return {}, {}
    img, _scale = _resize_for_analysis(img)
    return _best_roi_counts(img, _scale)


def detect_sheet_numbers(path: Path) -> List[Tuple[int, Tuple[int, int]]]:
    """표시된 번호와 대략적 좌표 (빈도 분석은 detect_sheet_mark_counts 사용)."""
    counts = detect_sheet_mark_counts(path)
    return [(n, (0, 0)) for n in sorted(counts)]
