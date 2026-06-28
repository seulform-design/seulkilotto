"""5천원 자동 용지 수기 등록 — A~E × 6번호 → 패턴 분석."""
from __future__ import annotations

from typing import Any, Dict, List, Sequence

from .sheet_grid import GAME_LINE_COUNT, GAME_LINE_LABELS, build_sheet_payload

MANUAL_LAYOUT = "manual_5x6"
_NUMBERS_PER_LINE = 6


def _normalize_label(label: str, index: int) -> str:
    text = (label or "").strip().upper()
    if text in GAME_LINE_LABELS:
        return text
    return GAME_LINE_LABELS[index % len(GAME_LINE_LABELS)]


def validate_game_numbers(numbers: Sequence[int], *, line_label: str = "") -> List[int]:
    """게임 줄 6개 번호 검증."""
    if len(numbers) != _NUMBERS_PER_LINE:
        prefix = f"{line_label}줄: " if line_label else ""
        raise ValueError(f"{prefix}번호는 정확히 6개여야 합니다 (현재 {len(numbers)}개).")
    nums = [int(n) for n in numbers]
    if any(not 1 <= n <= 45 for n in nums):
        prefix = f"{line_label}줄: " if line_label else ""
        raise ValueError(f"{prefix}번호는 1~45 사이여야 합니다.")
    if len(set(nums)) != _NUMBERS_PER_LINE:
        prefix = f"{line_label}줄: " if line_label else ""
        raise ValueError(f"{prefix}같은 번호를 두 번 넣을 수 없습니다.")
    return sorted(nums)


def build_manual_slip_payload(
    slip_index: int,
    lines: List[Dict[str, Any]],
    *,
    slip_name: str = "",
) -> Dict[str, Any]:
    """수기 용지 1장(5천원) → sheet payload."""
    game_lines: List[Dict[str, Any]] = []
    merged_counts: Dict[int, int] = {}
    merged_positions: Dict[int, Dict[str, int]] = {}

    for line_idx, raw in enumerate(lines[:GAME_LINE_COUNT]):
        label = _normalize_label(str(raw.get("label") or ""), line_idx)
        numbers = validate_game_numbers(raw.get("numbers") or [], line_label=label)
        mark_scores = {n: 2 for n in numbers}
        positions = {
            str(n): {
                "row": line_idx,
                "col": col,
                "game_line": line_idx,
                "game_label": label,
            }
            for col, n in enumerate(numbers)
        }
        game_lines.append(
            {
                "line_index": line_idx,
                "label": label,
                "numbers": numbers,
                "mark_scores": mark_scores,
                "positions": positions,
                "source_layout": MANUAL_LAYOUT,
            }
        )
        merged_counts.update(mark_scores)
        for key, pos in positions.items():
            merged_positions[int(key)] = pos

    source_label = (slip_name or "").strip() or f"수기용지 {slip_index}"
    payload = build_sheet_payload(
        merged_counts,
        merged_positions,
        source_image=source_label,
        sub_sheet_index=0,
        lines=game_lines,
        full_numbers=True,  # 수기 입력은 정확 데이터 — 표시강도 필터(7번호 잘림) 미적용
    )
    payload["layout_mode"] = MANUAL_LAYOUT
    payload["source_layout"] = MANUAL_LAYOUT
    payload["image_index"] = slip_index
    payload["image_label"] = f"용지 {slip_index}"
    payload["entry_mode"] = "manual"
    for line in payload.get("lines") or []:
        line["source_layout"] = MANUAL_LAYOUT
    return payload


def build_manual_sheet_payloads(slips: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not slips:
        raise ValueError("등록할 용지가 없습니다.")
    out: List[Dict[str, Any]] = []
    for idx, slip in enumerate(slips, start=1):
        raw_lines = slip.get("lines") or []
        # 부분 용지 허용: 1줄 이상이면 OK (대량 입력의 마지막 슬립이 5줄 미만일 수 있음).
        # 6줄 이상이면 build_manual_slip_payload 가 lines[:GAME_LINE_COUNT] 로 잘라냄.
        if len(raw_lines) < 1:
            raise ValueError(f"용지 {idx}: 최소 1개 게임 줄이 필요합니다.")
        out.append(
            build_manual_slip_payload(
                idx,
                raw_lines,
                slip_name=str(slip.get("name") or slip.get("label") or ""),
            )
        )
    return out


def parse_numbers_text(text: str) -> List[int]:
    """'12 14 22 25 38 42' 또는 '12,14,...' 파싱."""
    import re

    tokens = re.findall(r"\d{1,2}", text or "")
    return [int(t) for t in tokens]


def analyze_manual_slips(
    slips: List[Dict[str, Any]],
    *,
    sheet_intent: str = "current_round",
) -> Dict[str, Any]:
    from .dedup import compute_manual_source_id
    from .image_engine import analyze_from_sheet_payloads

    sheet_payloads = build_manual_sheet_payloads(slips)
    intent = sheet_intent if sheet_intent in ("review", "current_round") else "current_round"
    intent_label = "복기" if intent == "review" else "이번회차"
    title = f"{intent_label} 수기 등록 {len(slips)}장"
    source_id = compute_manual_source_id(slips, intent)
    return analyze_from_sheet_payloads(
        sheet_payloads,
        sheet_intent=intent,
        title=title,
        source_id=source_id,
        entry_mode="manual",
        source_count=len(slips),
    )
