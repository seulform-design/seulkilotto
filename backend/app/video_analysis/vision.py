"""프레임 비전 분석 — OCR·원·선·중복 패턴."""
from __future__ import annotations

import re
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Set, Tuple

import numpy as np

from .image_io import image_to_base64_jpeg, read_image_bgr
from .overlap_patterns import build_frequency_overlap_patterns
from .sheet_grid import detect_sheet_analysis, detect_sheet_mark_counts, detect_sheet_numbers

ALL_NUMBERS = set(range(1, 46))


def _parse_numbers_from_text(text: str) -> List[int]:
    found: List[int] = []
    for m in re.finditer(r"(?<!\d)([1-9]|[1-3]\d|4[0-5])(?!\d)", text or ""):
        n = int(m.group(1))
        if n in ALL_NUMBERS:
            found.append(n)
    return found


def _ocr_tesseract(img) -> List[Tuple[int, Tuple[int, int]]]:
    """Tesseract 있을 때만 보조 OCR."""
    import cv2

    results: List[Tuple[int, Tuple[int, int]]] = []
    try:
        import pytesseract

        variants = [img]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        up = cv2.resize(gray, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
        _, th = cv2.threshold(up, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        variants.extend([cv2.cvtColor(up, cv2.COLOR_GRAY2BGR), cv2.cvtColor(th, cv2.COLOR_GRAY2BGR)])

        for variant in variants:
            rgb = cv2.cvtColor(variant, cv2.COLOR_BGR2RGB)
            config = "--psm 6 -c tessedit_char_whitelist=0123456789"
            data = pytesseract.image_to_data(
                rgb, output_type=pytesseract.Output.DICT, lang="eng", config=config
            )
            for i, text in enumerate(data["text"]):
                text = (text or "").strip()
                if not text.isdigit():
                    continue
                n = int(text)
                if n not in ALL_NUMBERS:
                    continue
                x = data["left"][i] + data["width"][i] // 2
                y = data["top"][i] + data["height"][i] // 2
                conf = int(data["conf"][i]) if str(data["conf"][i]).lstrip("-").isdigit() else 0
                if conf >= 20:
                    results.append((n, (x, y)))
            full = pytesseract.image_to_string(rgb, lang="kor+eng", config="--psm 6")
            for n in _parse_numbers_from_text(full):
                results.append((n, (0, 0)))
    except Exception:
        pass
    return results


def _merge_number_points(points: List[Tuple[int, Tuple[int, int]]]) -> List[Tuple[int, Tuple[int, int]]]:
    merged: List[Tuple[int, Tuple[int, int]]] = []
    for n, (x, y) in points:
        if any(abs(x - mx) < 24 and abs(y - my) < 24 and mn == n for mn, (mx, my) in merged):
            continue
        merged.append((n, (x, y)))
    return merged


def _ocr_numbers(path: Path) -> List[Tuple[int, Tuple[int, int]]]:
    """(번호, (cx,cy)) — 격자 표시 분석 우선, Tesseract는 보조."""
    img = read_image_bgr(path)
    if img is None:
        return []

    results = detect_sheet_numbers(path)
    if len(results) < 3:
        tesseract_hits = _ocr_tesseract(img)
        if tesseract_hits:
            results.extend(tesseract_hits)

    return _merge_number_points(results)


def _detect_circles(path: Path) -> List[Tuple[int, int]]:
    import cv2

    img = read_image_bgr(path)
    if img is None:
        return []
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.medianBlur(gray, 5)
    circles = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=25,
        param1=80,
        param2=30,
        minRadius=8,
        maxRadius=60,
    )
    if circles is None:
        return []
    return [(int(c[0]), int(c[1])) for c in circles[0]]


def _detect_lines(path: Path) -> List[Dict[str, Any]]:
    import cv2

    img = read_image_bgr(path)
    if img is None:
        return []
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 50, 150)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=80, minLineLength=60, maxLineGap=15)
    patterns: List[Dict[str, Any]] = []
    if lines is None:
        return patterns

    ocr_pts = _ocr_numbers(path)
    for line in lines[:40]:
        x1, y1, x2, y2 = line[0]
        dx, dy = x2 - x1, y2 - y1
        if abs(dx) < 10 and abs(dy) > 40:
            ptype = "vertical stack"
        elif abs(dy) < 10 and abs(dx) > 40:
            ptype = "horizontal block"
        elif abs(dx) > 30 and abs(dy) > 30:
            ptype = "diagonal line"
        else:
            ptype = "line segment"
        # 선 근처 번호
        for n, (cx, cy) in ocr_pts:
            dist = _point_line_dist(cx, cy, x1, y1, x2, y2)
            if dist < 35:
                patterns.append({"target_number": n, "pattern_type": ptype})
    return patterns


def _point_line_dist(px: int, py: int, x1: int, y1: int, x2: int, y2: int) -> float:
    num = abs((y2 - y1) * px - (x2 - x1) * py + x2 * y1 - y2 * x1)
    den = ((y2 - y1) ** 2 + (x2 - x1) ** 2) ** 0.5
    return num / den if den else 999.0


def _numbers_near_circles(
    ocr_pts: List[Tuple[int, Tuple[int, int]]], circles: List[Tuple[int, int]]
) -> Set[int]:
    highlighted: Set[int] = set()
    for n, (cx, cy) in ocr_pts:
        for ccx, ccy in circles:
            if (cx - ccx) ** 2 + (cy - ccy) ** 2 < 55**2:
                highlighted.add(n)
    return highlighted


def analyze_frame(path: Path) -> Dict[str, Any]:
    sheet_counts, sheet_positions = detect_sheet_analysis(path)
    if not sheet_counts:
        ocr_pts = _ocr_numbers(path)
        sheet_counts = dict(Counter(n for n, _ in ocr_pts))
        sheet_positions = {}
    else:
        ocr_pts = [(n, (0, 0)) for n in sorted(sheet_counts)]
    numbers = [n for n, c in sheet_counts.items() for _ in range(max(1, int(c)))]
    counts = Counter(sheet_counts)
    circles = _detect_circles(path)
    highlighted = set(_numbers_near_circles(ocr_pts, circles))
    # 격자 표시 번호는 동그라미 없어도 강조로 취급
    for n, _ in ocr_pts:
        highlighted.add(n)
    highlighted = sorted(highlighted)
    lines = _detect_lines(path)

    multiples_3 = [n for n, c in counts.items() if c >= 3]
    multiples_2 = [n for n, c in counts.items() if c == 2]

    return {
        "path": str(path),
        "sheet_mark_counts": dict(sheet_counts),
        "sheet_positions": dict(sheet_positions),
        "ocr_numbers": numbers,
        "counts": dict(counts),
        "highlighted": sorted(highlighted),
        "circles_detected": len(circles),
        "lines": lines,
        "multiples_3": multiples_3,
        "multiples_2": multiples_2,
        "sharpness": 0.0,
    }


def merge_frame_analyses(analyses: List[Dict[str, Any]]) -> Dict[str, Any]:
    from .overlap_patterns import accumulate_frequency_patterns

    all_highlighted: Counter = Counter()
    all_lines: List[Dict[str, Any]] = []
    best = max(
        analyses,
        key=lambda a: len(a.get("sheet_mark_counts") or {}) or len(a.get("ocr_numbers", [])),
    )

    sheet_entries: List[Dict[str, Any]] = []
    per_sheet_max: Counter = Counter()

    for a in analyses:
        raw = a.get("sheet_mark_counts") or {}
        if not raw:
            raw = dict(Counter(a.get("ocr_numbers", [])))
        if not raw:
            continue
        sheet_entries.append(
            {
                "result": {
                    "extracted_visual_patterns": {
                        "frequency_overlap_patterns": build_frequency_overlap_patterns(raw),
                    }
                }
            }
        )
        for n, c in raw.items():
            per_sheet_max[n] = max(per_sheet_max[n], int(c))
        for n in a.get("highlighted", []):
            all_highlighted[n] += 1
        all_lines.extend(a.get("lines", []))

    if len(sheet_entries) <= 1 and sheet_entries:
        freq_patterns = sheet_entries[0]["result"]["extracted_visual_patterns"]["frequency_overlap_patterns"]
        freq_patterns = {
            **freq_patterns,
            "summary": "용지 내 번호 겹침 빈도 (같은 칸 표시 횟수)",
        }
    elif sheet_entries:
        freq_patterns = accumulate_frequency_patterns(sheet_entries)
        freq_patterns = {
            **freq_patterns,
            "summary": f"{len(sheet_entries)}장 용지 — 칸 내 최대 겹침 + 해당 패턴 용지 수",
        }
    else:
        freq_patterns = build_frequency_overlap_patterns({})

    triples = [n for n, c in per_sheet_max.items() if c >= 3]
    pairs = [n for n, c in per_sheet_max.items() if c == 2]
    mtype = "쌍수" if pairs else "중복없음"
    mnums = pairs

    strong = sorted(
        set(triples + pairs + list(all_highlighted.keys())),
        key=lambda n: (-per_sheet_max[n], -all_highlighted.get(n, 0), n),
    )[:15]

    line_by_num: Dict[int, str] = {}
    for lp in all_lines:
        tn = lp.get("target_number")
        if tn and tn not in line_by_num:
            line_by_num[tn] = lp.get("pattern_type", "line")

    line_patterns = [
        {"target_number": n, "pattern_type": line_by_num[n]}
        for n in sorted(line_by_num.keys())
    ][:20]

    return {
        "best_frame": best.get("path"),
        "sheets_analyzed": len(sheet_entries),
        "aggregated_counts": dict(per_sheet_max),
        "identified_multiples": {"type": mtype, "numbers": mnums},
        "frequency_overlap_patterns": freq_patterns,
        "triple_plus_overlap": freq_patterns["triple_plus_overlap"],
        "line_patterns": line_patterns,
        "strong_candidates": strong,
        "frames_analyzed": len(analyses),
    }


def frame_to_base64_preview(path: Path, max_width: int = 640) -> str | None:
    return image_to_base64_jpeg(path, max_width=max_width, quality=75)
