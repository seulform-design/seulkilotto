"""전회차(복기) 용지 위치 템플릿 저장 · 이번회차 적용."""
from __future__ import annotations

from collections import Counter
from typing import Any, Dict, List, Set

from .combo_patterns import find_repeated_combos

GridPos = Dict[str, int]  # {"row": r, "col": c}


def build_photo_review_template_from_sheets(
    sheet_payloads: List[Dict[str, Any]],
    *,
    ticket_round: str | None = None,
) -> Dict[str, Any]:
    """복기 용지 OCR → 이번회차에 적용할 사진 기반 템플릿."""
    number_votes: Counter = Counter()
    pos_votes: Dict[int, Counter] = {}
    all_sets: List[Set[int]] = []

    for sheet in sheet_payloads:
        nums = {int(n) for n in (sheet.get("numbers") or []) if 1 <= int(n) <= 45}
        if len(nums) < 2:
            continue
        all_sets.append(nums)
        cur_pos = sheet.get("positions") or {}
        for n in nums:
            number_votes[n] += 1
            p = cur_pos.get(n) or cur_pos.get(str(n))
            if isinstance(p, dict):
                pos_key = (int(p.get("row", 0)), int(p.get("col", 0)))
                pos_votes.setdefault(n, Counter())[pos_key] += 1

    merged_positions: Dict[str, GridPos] = {}
    merged_numbers = [n for n, c in number_votes.most_common() if c >= 2]
    if len(merged_numbers) < 4:
        merged_numbers = [n for n, _ in number_votes.most_common(12)]
    merged_numbers = sorted(merged_numbers)
    for n in merged_numbers:
        if n in pos_votes and pos_votes[n]:
            row, col = pos_votes[n].most_common(1)[0][0]
            merged_positions[str(n)] = {"row": row, "col": col}

    combo = find_repeated_combos(all_sets) if len(all_sets) >= 2 else {
        "summary": "",
        "pair_duplicates": [],
        "triple_duplicates": [],
        "sheet_count": len(all_sets),
        "min_repeat": 2,
    }

    return {
        "source": "photo_review",
        "ticket_round": ticket_round,
        "ticket_rounds": [ticket_round] if ticket_round else [],
        "intent": "review",
        "marked_numbers": merged_numbers,
        "positions": merged_positions,
        "combo_patterns": combo,
        "summary": f"복기 용지 {len(all_sets)}장 · 표시번호 {len(merged_numbers)}개",
    }


def build_sheet_template(
    *,
    numbers: Set[int] | List[int],
    positions: Dict[int, GridPos] | None = None,
    ticket_round: str | None = None,
    intent: str = "review",
) -> Dict[str, Any]:
    nums = sorted({int(n) for n in numbers if 1 <= int(n) <= 45})
    pos_out: Dict[str, GridPos] = {}
    if positions:
        for n, p in positions.items():
            if 1 <= int(n) <= 45 and isinstance(p, dict):
                pos_out[str(int(n))] = {"row": int(p.get("row", 0)), "col": int(p.get("col", 0))}
    return {
        "ticket_round": ticket_round,
        "intent": intent,
        "marked_numbers": nums,
        "positions": pos_out,
    }


def merge_review_templates(templates: List[Dict[str, Any]]) -> Dict[str, Any]:
    """복기 용지 템플릿 통합 — 번호별 대표 격자 위치."""
    if not templates:
        return {}

    number_votes: Dict[int, Counter] = {}
    pos_votes: Dict[int, Counter] = {}
    all_sets: List[Set[int]] = []
    rounds: List[str] = []

    for tpl in templates:
        nums = tpl.get("marked_numbers") or []
        all_sets.append({int(n) for n in nums})
        if tpl.get("ticket_round"):
            rounds.append(str(tpl["ticket_round"]))
        positions = tpl.get("positions") or {}
        for n in nums:
            ni = int(n)
            number_votes.setdefault(ni, Counter())[ni] += 1
            key = positions.get(str(ni)) or positions.get(ni)
            if key:
                pos_key = (int(key["row"]), int(key["col"]))
                pos_votes.setdefault(ni, Counter())[pos_key] += 1

    merged_positions: Dict[str, GridPos] = {}
    # ⚠️ 임계 없이 전 번호를 union 하면(구버전 버그) 복기 용지가 쌓일수록
    # marked_numbers 가 1~45 전부로 부풀어(오염) 이번회차 적용 시 모든 조합이
    # 매칭돼 무의미해진다. build_photo_review_template_from_sheets 와 동일하게
    # '2개 이상 템플릿에 등장' 우선, 너무 적으면(<4) 상위 12개로 캡한다.
    vote_of: Dict[int, int] = {n: cnt[n] for n, cnt in number_votes.items()}
    merged_numbers = sorted(n for n, v in vote_of.items() if v >= 2)
    if len(merged_numbers) < 4:
        merged_numbers = sorted(n for n, _ in Counter(vote_of).most_common(12))
    for n in merged_numbers:
        if n in pos_votes and pos_votes[n]:
            row, col = pos_votes[n].most_common(1)[0][0]
            merged_positions[str(n)] = {"row": row, "col": col}

    combo = find_repeated_combos(all_sets) if len(all_sets) >= 2 else {
        "summary": "",
        "pair_duplicates": [],
        "triple_duplicates": [],
        "sheet_count": len(all_sets),
        "min_repeat": 2,
    }

    rounds_sorted = sorted(set(rounds), reverse=True)
    return {
        "source": "photo_review",
        "intent": "review",
        "source_count": len(templates),
        # 단수 ticket_round 도 채운다(구버전은 ticket_rounds 만 반환해 소비처에서 빈 회차).
        "ticket_round": rounds_sorted[0] if rounds_sorted else None,
        "ticket_rounds": rounds_sorted,
        "marked_numbers": merged_numbers,
        "positions": merged_positions,
        "combo_patterns": combo,
    }


def apply_template_to_current(
    review_template: Dict[str, Any],
    current_sheets: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    전회차 템플릿을 이번회차 용지에 적용.
    current_sheets: [{numbers: set, positions: {n: {row,col}}}]
    """
    if not review_template or not current_sheets:
        return {
            "summary": "적용할 복기 템플릿 또는 이번회차 용지가 없습니다.",
            "position_matches": [],
            "number_matches": [],
            "combo_hits": [],
        }

    tpl_nums = {int(n) for n in review_template.get("marked_numbers") or []}
    tpl_pos = review_template.get("positions") or {}

    position_hits: List[Dict[str, Any]] = []
    number_hits: List[Dict[str, Any]] = []
    current_sets: List[Set[int]] = []

    for idx, sheet in enumerate(current_sheets):
        cur_nums = {int(n) for n in (sheet.get("numbers") or [])}
        cur_pos = sheet.get("positions") or {}
        current_sets.append(cur_nums)

        for n in tpl_nums:
            if n not in cur_nums:
                continue
            number_hits.append({"number": n, "sheet_index": idx})

            tpl_p = tpl_pos.get(str(n)) or tpl_pos.get(n)
            cur_p = cur_pos.get(str(n)) or cur_pos.get(n) or cur_pos.get(int(n))
            if tpl_p and cur_p:
                if int(tpl_p["row"]) == int(cur_p["row"]) and int(tpl_p["col"]) == int(cur_p["col"]):
                    position_hits.append(
                        {
                            "number": n,
                            "sheet_index": idx,
                            "row": int(tpl_p["row"]),
                            "col": int(tpl_p["col"]),
                        }
                    )

    from .line_overlap_patterns import analyze_line_overlap_patterns

    line_analysis = analyze_line_overlap_patterns(
        current_sheets,
        review_template.get("marked_numbers") or [],
        intent="current_round",
    )
    combo_hits: List[Dict[str, Any]] = []
    for item in line_analysis.get("same_line_matches") or []:
        if int(item.get("overlap_count", 0)) >= 2:
            combo_hits.append(
                {
                    "numbers": item.get("matching_numbers") or [],
                    "size": int(item.get("overlap_count", 0)),
                    "review_repeat": 1,
                    "current_sheet_hits": 1,
                    "sheet_indices": [int(item.get("sheet_index", 0))],
                    "line_label": item.get("line_label"),
                    "prize_tier": item.get("prize_tier"),
                }
            )
    for bucket in ("pair_duplicates", "triple_duplicates", "quad_duplicates"):
        for item in line_analysis.get(bucket) or []:
            combo_hits.append(
                {
                    "numbers": sorted(item.get("numbers") or []),
                    "size": int(item.get("size", 2)),
                    "review_repeat": item.get("line_count"),
                    "current_sheet_hits": item.get("line_count"),
                    "sheet_indices": item.get("sheet_indices") or [],
                    "label": item.get("label"),
                }
            )

    pos_nums = sorted({h["number"] for h in position_hits})
    num_only = sorted({h["number"] for h in number_hits} - set(pos_nums))
    parts: List[str] = []
    if position_hits:
        parts.append(f"동일 위치 {len(pos_nums)}개 {pos_nums[:6]}")
    if num_only:
        parts.append(f"번호 일치 {len(num_only)}개 {num_only[:6]}")
    if combo_hits:
        parts.append(f"복기 조합 재출현 {len(combo_hits)}건")

    review_round = None
    rounds = review_template.get("ticket_rounds") or []
    if rounds:
        review_round = str(rounds[0])
    elif review_template.get("ticket_round"):
        review_round = str(review_template["ticket_round"])

    return {
        "summary": " · ".join(parts) if parts else "복기 패턴과 일치하는 표시 없음",
        "review_round": review_round,
        "review_rounds": rounds or ([review_round] if review_round else []),
        "review_numbers": sorted(tpl_nums),
        "position_matches": position_hits,
        "number_matches": number_hits,
        "combo_hits": combo_hits,
        "position_match_numbers": pos_nums,
        "number_only_matches": num_only,
    }
