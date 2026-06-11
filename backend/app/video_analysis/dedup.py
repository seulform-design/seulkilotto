"""용지·사진 중복 분석 방지."""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Dict, List, Optional


def compute_ticket_fingerprint(result: Dict[str, Any]) -> str:
    """용지 패턴 지문 — 회차·의도·용지별 표시번호 기반."""
    vva = result.get("video_visual_analysis") or {}
    meta = result.get("meta") or {}

    parts: List[str] = [
        str(vva.get("ticket_round") or vva.get("detected_round") or ""),
        str(vva.get("video_intent") or meta.get("sheet_intent") or ""),
        str(vva.get("video_id") or ""),
    ]
    sheet_sets = meta.get("sheet_number_sets") or []
    if sheet_sets:
        for raw in sorted(sheet_sets, key=lambda xs: ",".join(str(n) for n in xs)):
            try:
                nums = sorted({int(n) for n in raw if 1 <= int(n) <= 45})
                if len(nums) >= 2:
                    parts.append("SH:" + ",".join(str(n) for n in nums))
            except (TypeError, ValueError):
                pass
    else:
        evp = result.get("extracted_visual_patterns") or {}
        fop = evp.get("frequency_overlap_patterns") or {}
        fp = result.get("final_predictions") or {}
        for item in sorted(fop.get("all_frequent") or [], key=lambda x: x.get("number", 0)):
            try:
                parts.append(f"{int(item['number'])}:{int(item.get('overlap_count', 2))}")
            except (TypeError, ValueError, KeyError):
                pass
        for n in sorted(fp.get("strong_candidates") or []):
            try:
                parts.append(f"S{int(n)}")
            except (TypeError, ValueError):
                pass
    raw = "|".join(parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _entry_fingerprint(entry: Dict[str, Any]) -> str:
    if entry.get("ticket_fingerprint"):
        return str(entry["ticket_fingerprint"])
    return compute_ticket_fingerprint(entry.get("result") or entry)


def file_content_hash(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return hashlib.sha256(str(path).encode("utf-8")).hexdigest()


def dedupe_paths_by_content(paths: List[Path]) -> tuple[List[Path], int]:
    """동일 바이트 이미지 제거. (고유 목록, 제거 수)"""
    seen: set[str] = set()
    unique: List[Path] = []
    removed = 0
    for p in paths:
        key = file_content_hash(p)
        if key in seen:
            removed += 1
            continue
        seen.add(key)
        unique.append(p)
    return unique, removed


def compute_manual_source_id(slips: List[Dict[str, Any]], sheet_intent: str = "") -> str:
    """수기 등록 세트 ID."""
    h = hashlib.sha256()
    h.update((sheet_intent or "").encode("utf-8"))
    h.update(b"manual")
    for slip in slips:
        name = str(slip.get("name") or slip.get("label") or "").strip()
        h.update(name.encode("utf-8"))
        for line_idx, label in enumerate(("A", "B", "C", "D", "E")):
            raw_lines = slip.get("lines") or []
            nums: List[int] = []
            if line_idx < len(raw_lines):
                row = raw_lines[line_idx]
                if isinstance(row, dict):
                    label = str(row.get("label") or label).upper()
                    nums = sorted(int(n) for n in (row.get("numbers") or []) if 1 <= int(n) <= 45)
            h.update(f"{label}:{','.join(str(n) for n in nums)}".encode("utf-8"))
    return h.hexdigest()[:24]


def compute_source_id(paths: List[Path], sheet_intent: str = "") -> str:
    """분석 세트 ID — 이미지 내용 + 전회차/이번회차 구분."""
    h = hashlib.sha256()
    h.update((sheet_intent or "").encode("utf-8"))
    for p in sorted(paths, key=lambda x: x.name):
        h.update(file_content_hash(p).encode("utf-8"))
    return h.hexdigest()[:24]


def compute_images_hash(paths: List[Path]) -> str:
    return compute_source_id(paths, "")


def find_duplicate_entry(
    entries: List[Dict[str, Any]],
    *,
    source_id: Optional[str] = None,
    ticket_fingerprint: Optional[str] = None,
    exclude_source_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    for entry in reversed(entries):
        sid = entry.get("image_id") or entry.get("video_id") or entry.get("source_id")
        if source_id and sid == source_id:
            return entry
        if ticket_fingerprint:
            if exclude_source_id and sid == exclude_source_id:
                continue
            if _entry_fingerprint(entry) == ticket_fingerprint:
                return entry
    return None
