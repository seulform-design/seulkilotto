"""공식 당첨번호 기반 복기 템플릿 — 7×7 용지 위치 + 당첨 조합 검증."""
from __future__ import annotations

from itertools import combinations
from typing import Any, Dict, List, Set

from app.data_meta import get_history_meta
from app.database import NUMBER_COLUMNS, load_history

LOTTO_COLS = 7


def number_to_grid_pos(n: int) -> Dict[str, int]:
    """자동번호표 7×7 격자 위치."""
    if not 1 <= n <= 45:
        return {"row": 0, "col": 0}
    return {"row": (n - 1) // LOTTO_COLS, "col": (n - 1) % LOTTO_COLS}


def get_review_round_no() -> int:
    """복기 기준 = 최신 추첨 완료 회차 (예: 1226)."""
    meta = get_history_meta()
    latest = int(meta.get("latest_round") or 0)
    if latest > 0:
        return latest
    current = int(meta.get("current_round") or 1227)
    return max(1, current - 1)


def get_current_round_no() -> int:
    meta = get_history_meta()
    return int(meta.get("current_round") or meta.get("next_round") or 1227)


def load_draw_result(round_no: int) -> Dict[str, Any]:
    df = load_history()
    if df.empty:
        raise ValueError("당첨 데이터가 없습니다.")
    sub = df[df["round"].astype(int) == int(round_no)]
    if sub.empty:
        raise ValueError(f"{round_no}회 당첨 데이터를 찾을 수 없습니다.")
    row = sub.iloc[-1]
    numbers = sorted(int(row[c]) for c in NUMBER_COLUMNS)
    bonus = int(row["bonus"])
    return {
        "round": int(round_no),
        "numbers": numbers,
        "bonus": bonus,
        "draw_date": str(row.get("draw_date", "")),
    }


def build_draw_review_template(round_no: int | None = None) -> Dict[str, Any]:
    """지난 회차 당첨번호 → 용지 격자 위치 템플릿."""
    rnd = int(round_no or get_review_round_no())
    draw = load_draw_result(rnd)
    main = draw["numbers"]
    positions = {str(n): number_to_grid_pos(n) for n in main}

    pair_combos = [{"numbers": list(c), "size": 2} for c in combinations(main, 2)]
    triple_combos = [{"numbers": list(c), "size": 3} for c in combinations(main, 3)]

    return {
        "source": "official_draw",
        "ticket_round": str(rnd),
        "ticket_rounds": [str(rnd)],
        "intent": "review",
        "winning_numbers": main,
        "bonus": draw["bonus"],
        "marked_numbers": main,
        "positions": positions,
        "draw_date": draw.get("draw_date"),
        "winning_combo_reference": {
            "pair_combos": pair_combos,
            "triple_combos": triple_combos,
            "pair_count": len(pair_combos),
            "triple_count": len(triple_combos),
        },
        "combo_patterns": _winning_combo_hits(main, []),
        "summary": f"{rnd}회 당첨 {main} +보너스 {draw['bonus']}",
    }


def _winning_combo_hits(
    winning: List[int],
    sheet_sets: List[Set[int]] | None = None,
    *,
    sheet_details: List[Dict[str, Any]] | None = None,
    include_bonus: bool = False,
    bonus: int | None = None,
) -> Dict[str, Any]:
    """당첨번호 vs 게임 줄 — 2·3·4·5·6개 일치 + 줄간 당첨 조합."""
    from .line_overlap_patterns import analyze_line_overlap_patterns

    main = sorted(winning)
    details: List[Dict[str, Any]] = list(sheet_details or [])
    if not details and sheet_sets:
        for raw in sheet_sets:
            nums = sorted({int(n) for n in raw if 1 <= int(n) <= 45})
            if len(nums) >= 2:
                details.append({"numbers": nums, "mark_scores": {}})

    out = analyze_line_overlap_patterns(
        details,
        main,
        intent="review",
        bonus=bonus if include_bonus else None,
    )
    out["winning_numbers"] = main
    for bucket in ("pair_duplicates", "triple_duplicates", "quad_duplicates"):
        for item in out.get(bucket) or []:
            item["is_winning_combo"] = True
    return out


def analyze_sheets_with_draw_template(
    template: Dict[str, Any],
    sheet_payloads: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """당첨 템플릿 + 업로드 용지 비교."""
    winning = template.get("winning_numbers") or template.get("marked_numbers") or []
    tpl_pos = template.get("positions") or {}
    sheet_sets = [{int(n) for n in p.get("numbers", set())} for p in sheet_payloads]

    combo_on_sheets = _winning_combo_hits(
        winning,
        sheet_sets,
        sheet_details=sheet_payloads,
        bonus=template.get("bonus"),
    )

    position_hits: List[Dict[str, Any]] = []
    number_hits: List[Dict[str, Any]] = []
    win_set = {int(n) for n in winning}

    for idx, sheet in enumerate(sheet_payloads):
        cur_nums = {int(n) for n in sheet.get("numbers") or []}
        cur_pos = sheet.get("positions") or {}
        for n in win_set:
            if n not in cur_nums:
                continue
            number_hits.append({"number": n, "sheet_index": idx})
            tpl_p = tpl_pos.get(str(n))
            cur_p = cur_pos.get(n) or cur_pos.get(str(n))
            if tpl_p and cur_p:
                if int(tpl_p["row"]) == int(cur_p["row"]) and int(tpl_p["col"]) == int(cur_p["col"]):
                    position_hits.append(
                        {"number": n, "sheet_index": idx, "row": int(tpl_p["row"]), "col": int(tpl_p["col"])}
                    )

    pos_nums = sorted({h["number"] for h in position_hits})
    num_only = sorted({h["number"] for h in number_hits} - set(pos_nums))

    parts: List[str] = []
    rnd = template.get("ticket_round") or "?"
    parts.append(f"{rnd}회 당첨번호 {sorted(win_set)}")
    if pos_nums:
        parts.append(f"용지 동일위치 {pos_nums}")
    if num_only:
        parts.append(f"번호표시 {num_only}")
    if combo_on_sheets.get("pair_duplicates"):
        parts.append(f"2번호조합 {len(combo_on_sheets['pair_duplicates'])}건")
    if combo_on_sheets.get("triple_duplicates"):
        parts.append(f"3번호조합 {len(combo_on_sheets['triple_duplicates'])}건")

    return {
        "summary": " · ".join(parts),
        "review_round": rnd,
        "review_numbers": sorted(win_set),
        "winning_numbers": sorted(win_set),
        "bonus": template.get("bonus"),
        "position_matches": position_hits,
        "number_matches": number_hits,
        "position_match_numbers": pos_nums,
        "number_only_matches": num_only,
        "winning_combo_hits": combo_on_sheets,
        "same_line_matches": combo_on_sheets.get("same_line_matches") or [],
        "combo_hits": [
            *[
                {**x, "current_sheet_hits": x["repeat_count"], "review_repeat": 1}
                for x in combo_on_sheets.get("pair_duplicates") or []
            ],
            *[
                {**x, "current_sheet_hits": x["repeat_count"], "review_repeat": 1}
                for x in combo_on_sheets.get("triple_duplicates") or []
            ],
            *[
                {**x, "current_sheet_hits": x["repeat_count"], "review_repeat": 1}
                for x in combo_on_sheets.get("quad_duplicates") or []
            ],
        ],
    }


def resolve_sheet_round(intent: str) -> Dict[str, Any]:
    """이번회차/복기 회차 명확히 구분."""
    review_rnd = get_review_round_no()
    current_rnd = get_current_round_no()
    if intent == "review":
        return {
            "video_intent": "review",
            "video_intent_label": "복기",
            "ticket_round": str(review_rnd),
            "detected_round": str(review_rnd),
            "ticket_round_confidence": "high",
            "review_round_ref": review_rnd,
            "current_round_ref": current_rnd,
            "referenced_rounds": [str(review_rnd)],
        }
    return {
        "video_intent": "current_round",
        "video_intent_label": "이번회차",
        "ticket_round": str(current_rnd),
        "detected_round": str(current_rnd),
        "ticket_round_confidence": "high",
        "review_round_ref": review_rnd,
        "current_round_ref": current_rnd,
        "referenced_rounds": [str(current_rnd), str(review_rnd)],
    }
