"""용지·사진 중복 분석 방지."""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Dict, List, Optional


def _normalize_numbers(raw_numbers: Any) -> List[int]:
    nums: List[int] = []
    for raw in raw_numbers or []:
        try:
            value = int(raw)
        except (TypeError, ValueError):
            continue
        if 1 <= value <= 45:
            nums.append(value)
    return sorted(set(nums))


def _sheet_signature(detail: Dict[str, Any]) -> str:
    line_parts: List[str] = []
    for idx, raw_line in enumerate(detail.get("lines") or []):
        if not isinstance(raw_line, dict):
            continue
        nums = _normalize_numbers(raw_line.get("numbers"))
        if len(nums) < 2:
            continue
        label = str(raw_line.get("label") or idx).strip().upper()
        line_parts.append(f"{label}:{','.join(str(n) for n in nums)}")
    if line_parts:
        return "LINES|" + "|".join(line_parts)

    sheet_nums = _normalize_numbers(detail.get("numbers"))
    if len(sheet_nums) >= 2:
        return "SHEET|" + ",".join(str(n) for n in sheet_nums)
    return ""


def compute_ticket_fingerprint(result: Dict[str, Any]) -> str:
    """용지 패턴 지문 — source id 와 무관한 회차·의도·번호 패턴 기반."""
    vva = result.get("video_visual_analysis") or {}
    meta = result.get("meta") or {}

    parts: List[str] = [
        str(vva.get("ticket_round") or vva.get("detected_round") or ""),
        str(vva.get("video_intent") or meta.get("sheet_intent") or ""),
    ]

    sheet_details = meta.get("sheet_details") or []
    signatures = sorted(
        sig
        for detail in sheet_details
        if isinstance(detail, dict)
        for sig in [_sheet_signature(detail)]
        if sig
    )
    if signatures:
        parts.extend(f"SD:{sig}" for sig in signatures)
    else:
        sheet_sets = meta.get("sheet_number_sets") or []
        for raw in sorted(sheet_sets, key=lambda xs: ",".join(str(n) for n in xs)):
            nums = _normalize_numbers(raw)
            if len(nums) >= 2:
                parts.append("SH:" + ",".join(str(n) for n in nums))

    if len(parts) <= 2:
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


def compute_content_fingerprint(result: Dict[str, Any]) -> str:
    """번호 내용 전용 지문 — 회차 감지·용지 그룹핑·줄 순서와 무관하게
    '같은 줄들의 묶음'이면 같은 값. 같은 티켓을 재업로드했는데 회차 인식이
    흔들리거나 용지 분할이 달라져도 중복으로 잡아낸다. (intent 만 구분)

    sheet_details 의 각 줄(2번호 이상) 번호튜플을 전부 모아 정렬·해시한다.
    강한 내용 신호(줄 2개 이상)가 없으면 '' 반환 → 이 지문으로는 판단 보류."""
    meta = result.get("meta") or {}
    vva = result.get("video_visual_analysis") or {}
    intent = str(vva.get("video_intent") or meta.get("sheet_intent") or "")

    line_keys: List[str] = []
    for detail in meta.get("sheet_details") or []:
        if not isinstance(detail, dict):
            continue
        for raw_line in detail.get("lines") or []:
            if not isinstance(raw_line, dict):
                continue
            nums = _normalize_numbers(raw_line.get("numbers"))
            if len(nums) >= 2:
                line_keys.append(",".join(str(n) for n in nums))
        # 줄 구조가 없으면 용지 전체 번호로 대체
        if not (detail.get("lines")):
            nums = _normalize_numbers(detail.get("numbers"))
            if len(nums) >= 2:
                line_keys.append("S:" + ",".join(str(n) for n in nums))

    if not line_keys:
        for raw in meta.get("sheet_number_sets") or []:
            nums = _normalize_numbers(raw)
            if len(nums) >= 2:
                line_keys.append("S:" + ",".join(str(n) for n in nums))

    if len(line_keys) < 1:
        return ""
    raw = "CONTENT|" + intent + "|" + "|".join(sorted(line_keys))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _entry_fingerprint(entry: Dict[str, Any]) -> str:
    if entry.get("ticket_fingerprint"):
        return str(entry["ticket_fingerprint"])
    return compute_ticket_fingerprint(entry.get("result") or entry)


def _entry_content_fingerprint(entry: Dict[str, Any]) -> str:
    if entry.get("content_fingerprint"):
        return str(entry["content_fingerprint"])
    return compute_content_fingerprint(entry.get("result") or entry)


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


def compute_manual_source_id(
    slips: List[Dict[str, Any]], sheet_intent: str = "", pick_type: str = ""
) -> str:
    """수기 등록 세트 ID — 픽 타입(자동/반자동)까지 구분해 자동·반자동 세트가 충돌하지 않게 한다."""
    h = hashlib.sha256()
    h.update((sheet_intent or "").encode("utf-8"))
    h.update(b"manual")
    h.update((pick_type or "").encode("utf-8"))
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
    content_fingerprint: Optional[str] = None,
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
        # 내용 지문 — 회차/그룹핑 흔들려도 같은 줄 묶음이면 중복.
        if content_fingerprint:
            if exclude_source_id and sid == exclude_source_id:
                continue
            if _entry_content_fingerprint(entry) == content_fingerprint:
                return entry
    return None
