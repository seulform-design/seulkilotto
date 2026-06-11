"""용지 사진 분석 결과 누적 저장 (JSON)."""
from __future__ import annotations

import json
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from .dedup import compute_ticket_fingerprint, find_duplicate_entry
from .overlap_patterns import accumulate_frequency_patterns, build_frequency_overlap_patterns
from .position_template import build_sheet_template, merge_review_templates


class DuplicateAnalysisError(Exception):
    """이미 저장된 동일 영상/용지."""

    def __init__(self, reason: str, existing_entry: Dict[str, Any]):
        self.reason = reason
        self.existing_entry = existing_entry
        super().__init__(self._message(reason, existing_entry))

    @staticmethod
    def _message(reason: str, entry: Dict[str, Any]) -> str:
        title = entry.get("video_title") or entry.get("url") or "기존 분석"
        rnd = entry.get("ticket_round") or "?"
        if reason == "same_source":
            return f"이미 분석된 사진입니다: {title}"
        return f"동일 용지가 이미 저장되어 있습니다 ({rnd}회): {title}"

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
STORE_PATH = DATA_DIR / "video_analysis_store.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_raw() -> Dict[str, Any]:
    if not STORE_PATH.exists():
        return {"version": 2, "updated_at": _now_iso(), "entries": []}
    try:
        data = json.loads(STORE_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("invalid store")
        data.setdefault("entries", [])
        data.setdefault("version", 2)
        return data
    except Exception:
        return {"version": 2, "updated_at": _now_iso(), "entries": []}


def _save_raw(data: Dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    data["updated_at"] = _now_iso()
    data["version"] = 2
    STORE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _strip_for_store(result: Dict[str, Any]) -> Dict[str, Any]:
    out = json.loads(json.dumps(result, ensure_ascii=False))
    meta = out.get("meta")
    if isinstance(meta, dict):
        meta.pop("preview_image_base64", None)
    vva = out.get("video_visual_analysis") or {}
    if isinstance(vva, dict):
        vva.pop("round_sources", None)
    return out


def _entry_round(entry: Dict[str, Any]) -> str:
    r = entry.get("ticket_round")
    if r:
        return str(r)
    vva = (entry.get("result") or {}).get("video_visual_analysis") or {}
    return str(vva.get("ticket_round") or vva.get("detected_round") or "미확인")


def check_stored_duplicate(
    source_id: str,
    result: Dict[str, Any] | None = None,
    *,
    allow_duplicate: bool = False,
) -> Dict[str, Any] | None:
    """저장소에 동일 사진/용지가 있으면 기존 엔트리 반환."""
    if allow_duplicate:
        return None
    data = _load_raw()
    entries = data.get("entries") or []
    sid = (result or {}).get("video_visual_analysis", {}).get("video_id") or source_id

    if sid:
        hit = find_duplicate_entry(entries, source_id=sid)
        if hit:
            return hit

    if result:
        fp = compute_ticket_fingerprint(result)
        hit = find_duplicate_entry(
            entries,
            ticket_fingerprint=fp,
            exclude_source_id=sid,
        )
        if hit:
            return hit
    return None


def append_analysis(
    source_id: str,
    result: Dict[str, Any],
    *,
    allow_duplicate: bool = False,
    source_label: str = "",
    replace_existing: bool = False,
) -> Dict[str, Any]:
    existing = check_stored_duplicate(source_id, result, allow_duplicate=allow_duplicate)
    if existing:
        sid = (result.get("video_visual_analysis") or {}).get("video_id") or source_id
        same_source = bool(sid and (existing.get("image_id") or existing.get("video_id")) == sid)
        if replace_existing and same_source:
            delete_entry(str(existing.get("id")))
            existing = None
        else:
            reason = "same_source" if same_source else "same_ticket"
            raise DuplicateAnalysisError(reason, existing)

    data = _load_raw()
    vva = result.get("video_visual_analysis") or {}
    evp = result.get("extracted_visual_patterns") or {}
    fop = evp.get("frequency_overlap_patterns") or build_frequency_overlap_patterns({})
    ticket_fp = compute_ticket_fingerprint(result)
    label = source_label or vva.get("video_title") or source_id

    meta = result.get("meta") or {}
    evp_full = result.get("extracted_visual_patterns") or {}

    entry = {
        "id": str(uuid.uuid4()),
        "source_type": "photo",
        "source_id": source_id,
        "image_id": vva.get("video_id") or source_id,
        "source_label": label,
        "url": label,
        "video_id": vva.get("video_id") or source_id,
        "ticket_fingerprint": ticket_fp,
        "video_title": label,
        "ticket_round": vva.get("ticket_round") or vva.get("detected_round"),
        "ticket_round_confidence": vva.get("ticket_round_confidence"),
        "video_intent": vva.get("video_intent"),
        "video_intent_label": vva.get("video_intent_label"),
        "referenced_rounds": vva.get("referenced_rounds") or [],
        "detected_round": vva.get("detected_round"),
        "frequency_overlap_patterns": fop,
        "triple_plus_overlap": fop.get("triple_plus_overlap") or evp.get("triple_plus_overlap"),
        "combo_patterns": evp_full.get("combo_patterns") or meta.get("combo_patterns"),
        "position_template": (
            meta.get("photo_review_template")
            or meta.get("position_template")
            or evp_full.get("photo_review_template")
            or evp_full.get("position_template")
        ),
        "analyzed_at": _now_iso(),
        "result": _strip_for_store(result),
    }
    data["entries"].append(entry)
    _save_raw(data)
    return entry


def _entry_combo_patterns(entry: Dict[str, Any]) -> Dict[str, Any] | None:
    combo = entry.get("combo_patterns")
    if combo:
        return combo
    r = entry.get("result") or {}
    evp = r.get("extracted_visual_patterns") or {}
    return evp.get("combo_patterns") or (r.get("meta") or {}).get("combo_patterns")


def _entry_position_template(entry: Dict[str, Any]) -> Dict[str, Any] | None:
    tpl = entry.get("position_template")
    if tpl:
        return tpl
    r = entry.get("result") or {}
    meta = r.get("meta") or {}
    evp = r.get("extracted_visual_patterns") or {}
    return meta.get("position_template") or evp.get("position_template")


def _dedupe_sheet_sets(sheet_sets: List[set[int]]) -> List[set[int]]:
    """동일 표시번호 용지는 1장만 집계."""
    seen: set[frozenset[int]] = set()
    out: List[set[int]] = []
    for raw in sheet_sets:
        key = frozenset(raw)
        if key in seen:
            continue
        seen.add(key)
        out.append(raw)
    return out


def _collect_deduped_sheet_sets(entries: List[Dict[str, Any]]) -> List[set[int]]:
    all_sets: List[set[int]] = []
    for entry in entries:
        all_sets.extend(_entry_sheet_sets(entry))
    return _dedupe_sheet_sets(all_sets)


def _entry_sheet_details(entry: Dict[str, Any]) -> List[Dict[str, Any]]:
    r = entry.get("result") or {}
    meta = r.get("meta") or {}
    details = meta.get("sheet_details")
    if isinstance(details, list) and details:
        return details
    per_sheet = meta.get("sheet_number_sets") or []
    legacy: List[Dict[str, Any]] = []
    for raw in per_sheet:
        try:
            nums = [int(n) for n in raw if 1 <= int(n) <= 45]
        except (TypeError, ValueError):
            continue
        if len(nums) >= 2:
            legacy.append({"numbers": nums, "mark_scores": {}})
    return legacy


def _entry_sheet_sets(entry: Dict[str, Any]) -> List[set[int]]:
    """엔트리에서 용지별 표시 번호 집합 추출 (표시 강도 우선)."""
    from .combo_patterns import sheet_sets_from_details

    details = _entry_sheet_details(entry)
    if details:
        sets = sheet_sets_from_details(details, None)
        if sets:
            return sets

    r = entry.get("result") or {}
    meta = r.get("meta") or {}
    sets: List[set[int]] = []
    per_sheet = meta.get("sheet_number_sets")
    if isinstance(per_sheet, list):
        for raw in per_sheet:
            try:
                nums = {int(n) for n in raw if 1 <= int(n) <= 45}
                if len(nums) >= 2:
                    sets.append(nums)
            except (TypeError, ValueError):
                pass
    if sets:
        return sets

    tpl = _entry_position_template(entry)
    if tpl and tpl.get("marked_numbers"):
        nums = {int(n) for n in tpl["marked_numbers"] if 1 <= int(n) <= 45}
        if len(nums) >= 2:
            sets.append(nums)

    fp = r.get("final_predictions") or {}
    fallback = {int(n) for n in fp.get("strong_candidates") or [] if 1 <= int(n) <= 45}
    if len(fallback) >= 2:
        sets.append(fallback)
    return sets


def _is_legacy_entry(entry: Dict[str, Any]) -> bool:
    return not (_entry_combo_patterns(entry) or _entry_position_template(entry))


def _merge_winning_combo_hits(combos: List[Dict[str, Any]]) -> Dict[str, Any]:
    """엔트리별 당첨 조합 일치 결과를 병합 (일반 용지 조합 폭발 방지)."""
    pair_best: Dict[tuple[int, ...], Dict[str, Any]] = {}
    triple_best: Dict[tuple[int, ...], Dict[str, Any]] = {}

    for combo in combos:
        if not combo:
            continue
        for bucket, store, size, label in (
            ("pair_duplicates", pair_best, 2, "당첨2번호"),
            ("triple_duplicates", triple_best, 3, "당첨3번호"),
        ):
            for item in combo.get(bucket) or []:
                try:
                    key = tuple(sorted(int(n) for n in item["numbers"]))
                    cnt = int(item.get("repeat_count", 1))
                except (TypeError, ValueError, KeyError):
                    continue
                prev = store.get(key)
                if not prev or cnt > int(prev.get("repeat_count", 0)):
                    store[key] = {
                        "numbers": list(key),
                        "size": size,
                        "repeat_count": cnt,
                        "label": label,
                        "is_winning_combo": True,
                    }

    pairs = sorted(pair_best.values(), key=lambda x: (-x["repeat_count"], x["numbers"]))
    triples = sorted(triple_best.values(), key=lambda x: (-x["repeat_count"], x["numbers"]))
    parts: List[str] = []
    if pairs:
        parts.append(f"당첨2번호 {len(pairs)}건")
    if triples:
        parts.append(f"당첨3번호 {len(triples)}건")
    return {
        "summary": " · ".join(parts) if parts else "당첨번호 2·3조합 일치 없음",
        "sheet_count": 0,
        "min_repeat": 1,
        "pair_duplicates": pairs,
        "triple_duplicates": triples,
    }


def _accumulate_combo_patterns(entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    """복기=당첨번호 조합, 이번회차=복기 사진 패턴 조합 (의도별 분리)."""
    from .draw_template import _winning_combo_hits, build_draw_review_template

    review_entries = [e for e in entries if e.get("video_intent") == "review"]
    current_entries = [e for e in entries if e.get("video_intent") == "current_round"]
    merged_parts: List[Dict[str, Any]] = []
    summary_bits: List[str] = []

    review_details: List[Dict[str, Any]] = []
    for entry in review_entries:
        review_details.extend(_entry_sheet_details(entry))
    review_sheets = _collect_deduped_sheet_sets(review_entries)
    if review_details or review_sheets:
        official = build_draw_review_template()
        review_out = _winning_combo_hits(
            official.get("winning_numbers") or [],
            review_sheets,
            sheet_details=review_details or None,
            bonus=official.get("bonus"),
        )
        review_out["summary"] = f"복기 당첨조합 · {review_out.get('summary', '')}"
        merged_parts.append(review_out)
        summary_bits.append(f"복기용지 {len(review_sheets)}장")

    current_details: List[Dict[str, Any]] = []
    for entry in current_entries:
        current_details.extend(_entry_sheet_details(entry))
    current_sheets = _collect_deduped_sheet_sets(current_entries)
    if current_details or current_sheets:
        from .combo_patterns import analyze_current_round_sheet_combos

        review_ref = get_photo_review_template().get("marked_numbers") or []
        current_out = analyze_current_round_sheet_combos(
            sheet_details=current_details or None,
            sheet_number_sets=current_sheets if not current_details else None,
            reference_numbers=review_ref,
        )
        merged_parts.append(current_out)
        summary_bits.append(f"이번용지 {len(current_sheets)}장")
    elif current_entries:
        stored = [_entry_combo_patterns(e) for e in current_entries]
        stored = [c for c in stored if c and (c.get("pair_duplicates") or c.get("triple_duplicates"))]
        if stored:
            merged_parts.append(_merge_winning_combo_hits(stored))

    if not merged_parts:
        return _winning_combo_hits(build_draw_review_template().get("winning_numbers") or [], [])

    if len(merged_parts) == 1:
        out = merged_parts[0]
        out["summary"] = f"{' · '.join(summary_bits)} · {out.get('summary', '')}".strip(" · ")
        return out

    pair_all: List[Dict[str, Any]] = []
    triple_all: List[Dict[str, Any]] = []
    for part in merged_parts:
        pair_all.extend(part.get("pair_duplicates") or [])
        triple_all.extend(part.get("triple_duplicates") or [])
    out = {
        "summary": " · ".join(summary_bits + [p.get("summary", "") for p in merged_parts if p.get("summary")]),
        "sheet_count": len(review_sheets) + len(current_sheets),
        "min_repeat": 1,
        "pair_duplicates": pair_all,
        "triple_duplicates": triple_all,
    }
    return out


def _entry_photo_review_template(entry: Dict[str, Any]) -> Dict[str, Any] | None:
    """복기 사진 OCR 기반 템플릿 (당첨번호 공식 템플릿 제외)."""
    r = entry.get("result") or {}
    meta = r.get("meta") or {}
    evp = r.get("extracted_visual_patterns") or {}
    for key in ("photo_review_template",):
        tpl = meta.get(key) or evp.get(key)
        if tpl and tpl.get("marked_numbers") and tpl.get("source") != "official_draw":
            return tpl

    tpl = entry.get("position_template")
    if tpl and tpl.get("source") == "official_draw":
        tpl = None
    if tpl and tpl.get("marked_numbers"):
        return tpl

    sheet_sets = _entry_sheet_sets(entry)
    if not sheet_sets:
        return None
    all_nums: set[int] = set()
    for s in sheet_sets:
        all_nums |= s
    if len(all_nums) < 2:
        return None
    return build_sheet_template(
        numbers=all_nums,
        positions={},
        ticket_round=entry.get("ticket_round"),
        intent="review",
    )


def get_saved_review_templates(limit: int = 20) -> List[Dict[str, Any]]:
    """저장된 복기 용지(사진 OCR) 템플릿."""
    data = _load_raw()
    out: List[Dict[str, Any]] = []
    for entry in reversed(data.get("entries") or []):
        if entry.get("video_intent") != "review":
            continue
        tpl = _entry_photo_review_template(entry)
        if tpl:
            out.append(tpl)
            if len(out) >= limit:
                break
    return out


def get_photo_review_template() -> Dict[str, Any]:
    """이번회차 적용용 — 복기 사진에서 읽은 패턴만."""
    return merge_review_templates(get_saved_review_templates())


def get_merged_review_template() -> Dict[str, Any]:
    """누적 UI용 — 사진 복기 템플릿 + 당첨번호 참고."""
    from .draw_template import build_draw_review_template

    photo = get_photo_review_template()
    official = build_draw_review_template()
    if not photo.get("marked_numbers"):
        return official
    photo["official_draw_reference"] = official
    return photo


def list_entries(limit: int = 100) -> List[Dict[str, Any]]:
    data = _load_raw()
    return list(reversed((data.get("entries") or [])[-limit:]))


def clear_store() -> int:
    data = _load_raw()
    count = len(data.get("entries") or [])
    _save_raw({"version": 2, "updated_at": _now_iso(), "entries": []})
    return count


def delete_entry(entry_id: str) -> bool:
    data = _load_raw()
    entries = data.get("entries") or []
    new_entries = [e for e in entries if e.get("id") != entry_id]
    if len(new_entries) == len(entries):
        return False
    data["entries"] = new_entries
    _save_raw(data)
    return True


def _vote_list(counter: Counter, limit: int = 20) -> List[Dict[str, Any]]:
    return [{"number": n, "votes": c, "video_count": c} for n, c in counter.most_common(limit)]


def _accumulate_entries(entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    strong_votes: Counter = Counter()
    excluded_votes: Counter = Counter()
    multiples_votes: Counter = Counter()
    line_votes: Counter = Counter()
    line_types: Dict[int, Counter] = {}

    for entry in entries:
        r = entry.get("result") or entry
        fp = r.get("final_predictions") or {}
        evp = r.get("extracted_visual_patterns") or {}

        for n in fp.get("strong_candidates") or []:
            try:
                strong_votes[int(n)] += 1
            except (TypeError, ValueError):
                pass
        for n in fp.get("excluded_candidates") or []:
            try:
                excluded_votes[int(n)] += 1
            except (TypeError, ValueError):
                pass
        for n in (evp.get("identified_multiples") or {}).get("numbers") or []:
            try:
                multiples_votes[int(n)] += 1
            except (TypeError, ValueError):
                pass
        for lp in evp.get("line_patterns") or []:
            try:
                tn = int(lp.get("target_number"))
                line_votes[tn] += 1
                line_types.setdefault(tn, Counter())[str(lp.get("pattern_type") or "line")] += 1
            except (TypeError, ValueError):
                pass

    freq_acc = accumulate_frequency_patterns(entries)
    line_patterns = []
    for n, c in line_votes.most_common(20):
        ptype = line_types.get(n, Counter()).most_common(1)
        line_patterns.append(
            {"target_number": n, "votes": c, "pattern_type": ptype[0][0] if ptype else "line"}
        )

    multiples_top = _vote_list(multiples_votes, 15)
    return {
        "strong_candidate_votes": _vote_list(strong_votes),
        "excluded_candidate_votes": _vote_list(excluded_votes),
        "multiples_votes": multiples_top,
        "identified_multiples": {
            "type": "쌍수" if multiples_votes else "중복없음",
            "numbers": [x["number"] for x in multiples_top],
        },
        "frequency_overlap_patterns": freq_acc,
        "triple_plus_overlap": freq_acc["triple_plus_overlap"],
        "line_pattern_votes": line_patterns,
        "final_predictions": {
            "strong_candidates": [n for n, _ in strong_votes.most_common(18)],
            "excluded_candidates": [n for n, _ in excluded_votes.most_common(12)],
        },
    }


def _entries_summary_for(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [
        {
            "id": e.get("id"),
            "url": e.get("url"),
            "video_id": e.get("video_id"),
            "video_title": e.get("video_title"),
            "ticket_round": _entry_round(e),
            "ticket_round_confidence": e.get("ticket_round_confidence"),
            "video_intent": e.get("video_intent"),
            "video_intent_label": e.get("video_intent_label"),
            "referenced_rounds": e.get("referenced_rounds") or [],
            "analyzed_at": e.get("analyzed_at"),
            "strong_candidates": (
                (e.get("result") or {}).get("final_predictions") or {}
            ).get("strong_candidates") or [],
            "frequency_overlap_patterns": e.get("frequency_overlap_patterns")
            or ((e.get("result") or {}).get("extracted_visual_patterns") or {}).get(
                "frequency_overlap_patterns"
            ),
            "triple_plus_overlap": (e.get("triple_plus_overlap") or {}).get("items") or [],
            "ticket_fingerprint": e.get("ticket_fingerprint"),
        }
        for e in reversed(entries)
    ]


def _latest_entry_combo(entry: Dict[str, Any]) -> Dict[str, Any] | None:
    combo = _entry_combo_patterns(entry)
    if combo and combo.get("combo_verification"):
        return combo
    r = entry.get("result") or {}
    evp = r.get("extracted_visual_patterns") or {}
    meta = r.get("meta") or {}
    return evp.get("combo_patterns") or meta.get("combo_patterns") or combo


def _recompute_intent_combo(entries: List[Dict[str, Any]], intent: str) -> Dict[str, Any]:
    from .combo_patterns import analyze_current_round_sheet_combos
    from .draw_template import _winning_combo_hits, build_draw_review_template

    group = [e for e in entries if e.get("video_intent") == intent]
    if not group:
        return {"summary": "분석 없음", "pair_duplicates": [], "triple_duplicates": []}

    latest = group[-1]
    stored = _latest_entry_combo(latest)
    if stored and stored.get("combo_verification"):
        return stored

    if intent == "review":
        details: List[Dict[str, Any]] = []
        for entry in group:
            details.extend(_entry_sheet_details(entry))
        sheets = _collect_deduped_sheet_sets(group)
        official = build_draw_review_template()
        out = _winning_combo_hits(
            official.get("winning_numbers") or [],
            sheets,
            sheet_details=details or None,
            bonus=official.get("bonus"),
        )
        out["summary"] = f"복기 당첨조합 · {out.get('summary', '')}"
        return out

    details = []
    for entry in group:
        details.extend(_entry_sheet_details(entry))
    sheets = _collect_deduped_sheet_sets(group)
    review_ref = get_photo_review_template().get("marked_numbers") or []
    return analyze_current_round_sheet_combos(
        sheet_details=details or None,
        sheet_number_sets=sheets if not details else None,
        reference_numbers=review_ref,
    )


def _build_intent_slice(entries: List[Dict[str, Any]], intent: str) -> Dict[str, Any]:
    """복기 / 이번회차 탭별 누적 데이터."""
    from .draw_template import build_draw_review_template, get_review_round_no, get_current_round_no

    group = [e for e in entries if e.get("video_intent") == intent]
    label = "복기" if intent == "review" else "이번회차"
    round_no = str(get_review_round_no()) if intent == "review" else str(get_current_round_no())
    combo = _recompute_intent_combo(entries, intent) if group else {
        "summary": f"{label} 분석 없음",
        "pair_duplicates": [],
        "triple_duplicates": [],
    }
    parts: List[str] = [f"{label} {len(group)}건"]
    if group:
        parts.append(f"{round_no}회")
    if combo.get("pair_duplicates") or combo.get("triple_duplicates"):
        parts.append(combo.get("summary", ""))

    slice_out: Dict[str, Any] = {
        "video_intent": intent,
        "video_intent_label": label,
        "ticket_round": round_no,
        "total_analyses": len(group),
        "accumulated_combo_patterns": combo,
        "entries_summary": _entries_summary_for(group),
        "app_ui_message": " · ".join(p for p in parts if p),
    }
    if intent == "review":
        official = build_draw_review_template()
        photo = get_photo_review_template()
        slice_out["draw_template"] = official
        slice_out["saved_review_template"] = photo if photo.get("marked_numbers") else None
    else:
        slice_out["saved_review_template"] = get_photo_review_template()
        if group:
            slice_out["pattern_ready"] = bool(slice_out["saved_review_template"].get("marked_numbers"))
    return slice_out


def build_accumulated() -> Dict[str, Any]:
    data = _load_raw()
    entries: List[Dict[str, Any]] = data.get("entries") or []
    overall = _accumulate_entries(entries)

    by_round: Dict[str, Any] = {}
    by_intent: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    round_groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

    for entry in entries:
        rnd = _entry_round(entry)
        round_groups[rnd].append(entry)
        by_intent[entry.get("video_intent") or "unknown"].append(entry)

    for rnd, group in round_groups.items():
        acc = _accumulate_entries(group)
        intents = Counter(e.get("video_intent") or "unknown" for e in group)
        by_round[rnd] = {
            "ticket_round": rnd,
            "analysis_count": len(group),
            "dominant_intent": intents.most_common(1)[0][0] if intents else "unknown",
            "dominant_intent_label": next(
                (e.get("video_intent_label") for e in reversed(group) if e.get("video_intent_label")),
                None,
            ),
            **acc,
        }

    unique_ids = {e.get("video_id") for e in entries if e.get("video_id")}
    accumulated_combo = _accumulate_combo_patterns(entries)
    legacy_count = sum(1 for e in entries if _is_legacy_entry(e))
    review_template = get_merged_review_template()
    if review_template.get("marked_numbers") and not review_template.get("combo_patterns"):
        review_template["combo_patterns"] = _accumulate_combo_patterns(
            [e for e in entries if e.get("video_intent") == "review"]
        )

    ui_parts: List[str] = []
    if entries:
        ui_parts.append(f"누적 {len(entries)}건")
    if by_round:
        rounds_sorted = sorted(
            (k for k in by_round if k != "미확인"),
            key=lambda x: int(x) if x.isdigit() else 0,
            reverse=True,
        )
        if rounds_sorted:
            ui_parts.append(f"회차 {', '.join(f'{r}회' for r in rounds_sorted[:4])}")
    deduped_sheets = len(_collect_deduped_sheet_sets(entries))
    if deduped_sheets:
        ui_parts.append(f"고유용지 {deduped_sheets}장")
    if accumulated_combo.get("pair_duplicates"):
        top = accumulated_combo["pair_duplicates"][0]
        ui_parts.append(f"당첨2조합 {top['numbers']} ×{top['repeat_count']}")
    if accumulated_combo.get("triple_duplicates"):
        top = accumulated_combo["triple_duplicates"][0]
        ui_parts.append(f"당첨3조합 {top['numbers']} ×{top['repeat_count']}")
    if review_template.get("marked_numbers"):
        ui_parts.append(f"복기저장 {len(review_template['marked_numbers'])}개")
    if legacy_count:
        ui_parts.append(f"구형데이터 {legacy_count}건(재분석 권장)")

    return {
        "total_analyses": len(entries),
        "unique_videos": len(unique_ids),
        "unique_photos": len(unique_ids),
        "updated_at": data.get("updated_at"),
        "legacy_entry_count": legacy_count,
        "accumulated_combo_patterns": accumulated_combo,
        "saved_review_template": review_template if review_template.get("marked_numbers") else None,
        **overall,
        "by_ticket_round": by_round,
        "by_video_intent": {
            k: {"count": len(v), "ticket_rounds": sorted({_entry_round(e) for e in v})}
            for k, v in by_intent.items()
        },
        "by_intent": {
            "review": _build_intent_slice(entries, "review"),
            "current_round": _build_intent_slice(entries, "current_round"),
        },
        "app_ui_message": " · ".join(ui_parts) if ui_parts else "저장된 분석이 없습니다.",
        "entries_summary": _entries_summary_for(entries),
    }
