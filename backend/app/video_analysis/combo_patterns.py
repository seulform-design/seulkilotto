"""용지 간 2·3번호 조합 중복 출현 분석."""
from __future__ import annotations

from collections import Counter
from itertools import combinations
from typing import Any, Dict, Iterable, List, Set


def _combo_items(
    counter: Counter,
    size: int,
    min_repeat: int,
    label: str,
) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for combo, cnt in counter.items():
        if cnt < min_repeat:
            continue
        out.append(
            {
                "numbers": list(combo),
                "size": size,
                "repeat_count": int(cnt),
                "label": label,
            }
        )
    out.sort(key=lambda x: (-x["repeat_count"], x["numbers"]))
    return out


def find_repeated_combos(
    sheet_number_sets: List[Set[int] | Iterable[int]],
    *,
    min_repeat: int = 2,
    triple_min_repeat: int | None = None,
    pair_label: str = "2번호 중복",
    triple_label: str = "3번호 중복",
) -> Dict[str, Any]:
    """
    여러 용지에서 함께 반복 출현한 2·3번호 조합.
    repeat_count = 해당 조합이 나타난 용지 수.
    """
    triple_min = int(triple_min_repeat if triple_min_repeat is not None else min_repeat)
    pair_counter: Counter = Counter()
    triple_counter: Counter = Counter()
    pair_sheets: Dict[tuple[int, ...], List[int]] = {}
    triple_sheets: Dict[tuple[int, ...], List[int]] = {}
    valid_sheets = 0

    for idx, raw in enumerate(sheet_number_sets):
        nums = sorted({int(n) for n in raw if 1 <= int(n) <= 45})
        if len(nums) < 2:
            continue
        valid_sheets += 1
        for combo in combinations(nums, 2):
            pair_counter[combo] += 1
            pair_sheets.setdefault(combo, []).append(idx)
        if len(nums) >= 3:
            for combo in combinations(nums, 3):
                triple_counter[combo] += 1
                triple_sheets.setdefault(combo, []).append(idx)

    pairs = _combo_items(pair_counter, 2, min_repeat, pair_label)
    triples = _combo_items(triple_counter, 3, triple_min, triple_label)
    for item in pairs:
        key = tuple(item["numbers"])
        item["sheet_indices"] = pair_sheets.get(key, [])
    for item in triples:
        key = tuple(item["numbers"])
        item["sheet_indices"] = triple_sheets.get(key, [])

    parts: List[str] = []
    if valid_sheets:
        parts.append(f"분석 용지 {valid_sheets}장")
    if pairs:
        top = pairs[0]
        parts.append(f"2번호 중복 {len(pairs)}건 (최다 {top['numbers']} ×{top['repeat_count']})")
    if triples:
        top = triples[0]
        parts.append(f"3번호 중복 {len(triples)}건 (최다 {top['numbers']} ×{top['repeat_count']})")

    return {
        "summary": " · ".join(parts) if parts else "중복 조합 없음 (용지 2장 이상·표시 2개 이상 필요)",
        "sheet_count": valid_sheets,
        "min_repeat": min_repeat,
        "triple_min_repeat": triple_min,
        "pair_duplicates": pairs,
        "triple_duplicates": triples,
    }


def _adaptive_min_repeat(sheet_count: int, combo_size: int) -> int:
    """용지 수에 따라 겹침 기준 상향 (대량 업로드 노이즈 방지)."""
    if sheet_count < 6:
        return 2
    if combo_size == 2:
        return max(3, min(5, sheet_count // 6))
    return max(3, min(6, sheet_count // 5))


def sheet_sets_from_details(
    sheet_details: List[Dict[str, Any]] | None,
    sheet_number_sets: List[Set[int] | Iterable[int]] | None = None,
) -> List[Set[int]]:
    """표시 강도(mark_scores) 기반 용지 번호 집합."""
    from .sheet_grid import filter_marked_numbers_for_combo

    sets: List[Set[int]] = []
    if sheet_details:
        for detail in sheet_details:
            scores = detail.get("mark_scores") or {}
            if scores:
                nums = filter_marked_numbers_for_combo(scores)
            else:
                nums = {int(n) for n in detail.get("numbers") or [] if 1 <= int(n) <= 45}
            if len(nums) >= 2:
                sets.append(set(nums))
        if sets:
            return sets
    for raw in sheet_number_sets or []:
        nums = {int(n) for n in raw if 1 <= int(n) <= 45}
        if len(nums) >= 2:
            sets.append(nums)
    return sets


def analyze_current_round_sheet_combos(
    sheet_number_sets: List[Set[int] | Iterable[int]] | None = None,
    *,
    sheet_details: List[Dict[str, Any]] | None = None,
    raw_sheet_count: int | None = None,
    reference_numbers: Iterable[int] | None = None,
) -> Dict[str, Any]:
    """이번회차 — 게임 줄 단위 기준번호 일치 + 줄간 2·3·4번호 조합."""
    from .line_overlap_patterns import analyze_line_overlap_patterns

    details: List[Dict[str, Any]] = list(sheet_details or [])
    if not details and sheet_number_sets:
        for raw in sheet_number_sets:
            nums = sorted({int(n) for n in raw if 1 <= int(n) <= 45})
            if len(nums) >= 2:
                details.append({"numbers": nums, "mark_scores": {}})

    out = analyze_line_overlap_patterns(
        details,
        reference_numbers,
        intent="current_round",
    )
    ver = out.get("combo_verification") or {}
    if raw_sheet_count:
        ver["images_uploaded"] = raw_sheet_count
    out["combo_verification"] = ver
    return out
