"""업로드 사진(용지) → 패턴 JSON 분석."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List

from app.config import settings

from .combo_patterns import analyze_current_round_sheet_combos, find_repeated_combos
from .sheet_grid import detect_all_sheets_in_image
from .dedup import compute_source_id, dedupe_paths_by_content
from .draw_template import (
    _winning_combo_hits,
    analyze_sheets_with_draw_template,
    build_draw_review_template,
    resolve_sheet_round,
)
from .position_template import (
    apply_template_to_current,
    build_photo_review_template_from_sheets,
)
from .round_resolver import resolve_ticket_round
from .vision import analyze_frame, frame_to_base64_preview, merge_frame_analyses
from .vision_llm import analyze_frames_with_vision


def _vision_api_key() -> str:
    return (settings.VIDEO_VISION_API_KEY or os.environ.get("OPENAI_API_KEY") or "").strip()


def vision_api_configured() -> bool:
    return bool(settings.PHOTO_USE_VISION_API and _vision_api_key())


def _should_use_vision() -> bool:
    return bool(settings.PHOTO_USE_VISION_API and _vision_api_key())


def _normalize_vision_error(exc: Exception) -> str | None:
    """결제·한도·인증 오류는 사용자에게 노출하지 않고 로컬 분석으로 진행."""
    msg = str(exc).strip()
    if not msg:
        return None
    lower = msg.lower()
    skippable = (
        "한도",
        "잔액",
        "quota",
        "billing",
        "insufficient_quota",
        "exceeded your current",
        "유효하지 않",
        "401",
        "429",
        "api 키",
        "전송할 프레임",
    )
    if any(token in lower or token in msg for token in skippable):
        return None
    return msg[:200]


def _merge_candidates(primary: List[int], extra: List[int], limit: int = 18) -> List[int]:
    seen = set(primary)
    out = list(primary)
    for n in extra:
        if n not in seen:
            out.append(n)
            seen.add(n)
        if len(out) >= limit:
            break
    return sorted(out)[:limit]


def _merge_vision_with_cv(vision: Dict[str, Any], cv: Dict[str, Any]) -> Dict[str, Any]:
    from .overlap_patterns import merge_frequency_patterns

    v_im = vision["extracted_visual_patterns"]["identified_multiples"]
    c_im = cv.get("identified_multiples", {})
    if not v_im.get("numbers") and c_im.get("numbers"):
        v_im = c_im

    v_lines = vision["extracted_visual_patterns"]["line_patterns"]
    if not v_lines:
        v_lines = cv.get("line_patterns", [])

    strong = _merge_candidates(
        vision["final_predictions"]["strong_candidates"],
        cv.get("strong_candidates", []),
    )
    excluded = sorted(
        set(vision["final_predictions"]["excluded_candidates"])
        | set(cv.get("excluded_candidates", []))
    )

    summary = vision["video_visual_analysis"]["main_board_summary"]
    if not summary:
        summary = cv.get("main_board_summary", "")

    return {
        "video_visual_analysis": {
            "detected_round": vision["video_visual_analysis"]["detected_round"],
            "main_board_summary": summary,
        },
        "extracted_visual_patterns": {
            "identified_multiples": v_im,
            "frequency_overlap_patterns": merge_frequency_patterns(
                vision["extracted_visual_patterns"].get("frequency_overlap_patterns"),
                cv.get("frequency_overlap_patterns"),
            ),
            "triple_plus_overlap": merge_frequency_patterns(
                vision["extracted_visual_patterns"].get("frequency_overlap_patterns"),
                cv.get("frequency_overlap_patterns"),
            )["triple_plus_overlap"],
            "line_patterns": v_lines,
        },
        "final_predictions": {
            "strong_candidates": strong,
            "excluded_candidates": excluded,
        },
        "app_ui_message": vision.get("app_ui_message") or "",
    }


def _build_ui_message(
    detected_round: str | None,
    merged: Dict[str, Any],
    strong: list[int],
    excluded: list[int],
) -> str:
    parts: list[str] = []
    if detected_round:
        parts.append(f"{detected_round}회 용지")
    m = merged.get("identified_multiples", {})
    if m.get("numbers"):
        parts.append(f"{m.get('type')} {m['numbers'][:6]}")
    combo = merged.get("combo_patterns") or {}
    is_current_overlap = any(
        str(x.get("label", "")).endswith("겹침") for x in (combo.get("pair_duplicates") or [])[:1]
    ) or any(str(x.get("label", "")).endswith("겹침") for x in (combo.get("triple_duplicates") or [])[:1])
    pair_label, triple_label = (
        ("2번호겹침", "3번호겹침") if is_current_overlap else ("당첨2조합", "당첨3조합")
    )
    for bucket, label in (("pair_duplicates", pair_label), ("triple_duplicates", triple_label)):
        items = combo.get(bucket) or []
        if items:
            top = items[0]
            parts.append(f"{label} {top['numbers']} ×{top.get('repeat_count', 1)}")
    apply = merged.get("pattern_application") or merged.get("draw_analysis") or {}
    if apply.get("position_match_numbers"):
        parts.append(f"동일위치 {apply['position_match_numbers'][:6]}")
    if strong:
        parts.append(f"추천 후보 {strong[:6]}")
    if excluded:
        parts.append(f"제외 {excluded[:4]}")
    if not parts:
        return "등록한 용지에서 분석할 패턴을 찾지 못했습니다."
    return " · ".join(parts)


def _manual_summary(
    sheet_count: int,
    detected_round: str | None,
    intent_label: str,
) -> str:
    parts = [f"{intent_label} 수기 등록 {sheet_count}장", "5×6 (A~E×6번호)"]
    if detected_round:
        parts.append(f"회차 {detected_round}회")
    return " · ".join(parts)


def _opencv_summary(
    merged: Dict[str, Any],
    ocr_count: int,
    detected_round: str | None,
    analysis_mode: str,
    image_count: int,
    *,
    entry_mode: str = "photo",
    sheet_count: int | None = None,
    intent_label: str = "",
) -> str:
    if entry_mode == "manual":
        return _manual_summary(sheet_count or image_count, detected_round, intent_label or "용지")
    mode_label = {"vision": "Vision+로컬", "local": "로컬(OpenCV)", "opencv": "로컬(OpenCV)"}.get(
        analysis_mode, analysis_mode
    )
    parts = [
        f"분석 사진 {image_count}장",
        f"표시 번호 {ocr_count}개",
        f"엔진 {mode_label}",
    ]
    if merged["identified_multiples"]["numbers"]:
        parts.append(
            f"{merged['identified_multiples']['type']} {merged['identified_multiples']['numbers']}"
        )
    if merged["line_patterns"]:
        parts.append(f"선 패턴 {len(merged['line_patterns'])}건")
    if detected_round:
        parts.append(f"회차 {detected_round}회")
    return " · ".join(parts)


def _layout_hint_from_payloads(sheet_payloads: List[Dict[str, Any]], entry_mode: str) -> str:
    if entry_mode == "manual":
        return f"수기 {len(sheet_payloads)}장(5×6)"
    receipt_sheets = sum(1 for p in sheet_payloads if p.get("layout_mode") == "receipt_5x6")
    if receipt_sheets:
        return f"영수증 {receipt_sheets}장(5×6)"
    return "마킹용지(7×7) 또는 영수증"


def _merged_from_manual(sheet_payloads: List[Dict[str, Any]], intent: str) -> Dict[str, Any]:
    from collections import Counter

    counts: Counter = Counter()
    for sheet in sheet_payloads:
        for line in sheet.get("lines") or []:
            for n in line.get("numbers") or []:
                counts[int(n)] += 1
    multiples = [n for n, c in counts.items() if c >= 2]
    multiples.sort(key=lambda n: (-counts[n], n))
    mtype = "3중복" if any(c >= 3 for c in counts.values()) else "2중복"
    physical = len(sheet_payloads)
    layout_hint = _layout_hint_from_payloads(sheet_payloads, "manual")
    summary = (
        f"복기 — 수기 용지 {physical}장 · {layout_hint}"
        if intent == "review"
        else f"이번회차 — 수기 용지 {physical}장 게임 줄 단위 겹침 · {layout_hint}"
    )
    return {
        "identified_multiples": {"type": mtype, "numbers": multiples[:12]},
        "frequency_overlap_patterns": {
            "summary": summary,
            "all_frequent": [{"number": n, "overlap_count": counts[n]} for n in multiples],
            "tiers": [],
            "triple_plus_overlap": {"items": []},
        },
        "triple_plus_overlap": {"pattern_label": "수기 3회이상 겹침", "items": []},
        "line_patterns": [],
        "strong_candidates": [],
        "best_frame": None,
    }


def analyze_from_sheet_payloads(
    sheet_payloads: List[Dict[str, Any]],
    *,
    sheet_intent: str,
    title: str,
    source_id: str,
    entry_mode: str = "photo",
    source_count: int = 0,
    paths: List[Path] | None = None,
    analyses: List[Dict[str, Any]] | None = None,
    dup_removed: int = 0,
    images_with_multi: int = 0,
    ocr_count: int = 0,
) -> Dict[str, Any]:
    """sheet payload 기준 공통 분석 (사진·수기 공용)."""
    if not sheet_payloads:
        raise ValueError("분석할 용지 데이터가 없습니다.")

    intent = sheet_intent if sheet_intent in ("review", "current_round") else "current_round"
    intent_label = "복기" if intent == "review" else "이번회차"
    round_ctx = resolve_sheet_round(intent)
    analysis_mode = "manual" if entry_mode == "manual" else "local"
    vision_error: str | None = None
    paths = paths or []

    draw_template = build_draw_review_template(round_ctx["review_round_ref"])
    sheet_sets = [p["numbers"] for p in sheet_payloads]
    combo_patterns: Dict[str, Any] = {}
    general_combo = find_repeated_combos(sheet_sets)

    if entry_mode == "manual":
        merged = _merged_from_manual(sheet_payloads, intent)
    else:
        merged = merge_frame_analyses(analyses or [])
        layout_hint = _layout_hint_from_payloads(sheet_payloads, entry_mode)
        physical_sheets = len(sheet_payloads)
        if intent == "review":
            merged["frequency_overlap_patterns"] = {
                **(merged.get("frequency_overlap_patterns") or {}),
                "summary": f"복기 — 용지 {physical_sheets}장 · {layout_hint}",
            }
        else:
            merged["frequency_overlap_patterns"] = {
                **(merged.get("frequency_overlap_patterns") or {}),
                "summary": f"이번회차 — 용지 {physical_sheets}장 게임 줄 단위 겹침 · {layout_hint}",
            }

    merged["combo_patterns"] = combo_patterns
    excluded: list[int] = []
    vision_result: Dict[str, Any] | None = None

    if entry_mode == "photo" and _should_use_vision() and paths:

        def _pick_vision_paths(limit: int = 4) -> List[Path]:
            ranked = sorted(
                zip(paths, analyses or []),
                key=lambda item: (
                    len(item[1].get("ocr_numbers", [])),
                    len(item[1].get("lines", [])),
                ),
                reverse=True,
            )
            return [p for p, _ in ranked[:limit]] or paths[:limit]

        try:
            vision_result = analyze_frames_with_vision(
                _pick_vision_paths(4),
                api_key=_vision_api_key(),
                model=settings.VIDEO_VISION_MODEL,
                video_title=title,
            )
            analysis_mode = "vision"
        except Exception as exc:
            vision_error = _normalize_vision_error(exc)
            analysis_mode = "local"

    if entry_mode == "manual":
        round_info = dict(round_ctx)
    else:
        ocr_round_info = resolve_ticket_round(
            title=title,
            description="",
            transcript="",
            frame_paths=paths,
            vision_detected_round=(
                (vision_result or {}).get("video_visual_analysis") or {}
            ).get("detected_round"),
            user_intent=intent,
        )
        round_info = {**ocr_round_info, **round_ctx}

    detected_round = round_info.get("ticket_round")
    position_template: Dict[str, Any] | None = None
    photo_review_template: Dict[str, Any] | None = None
    review_reference_template: Dict[str, Any] | None = None
    pattern_application: Dict[str, Any] | None = None
    draw_analysis: Dict[str, Any] | None = None
    count_for_combo = source_count or len(paths) or len(sheet_payloads)

    if intent == "review":
        photo_review_template = build_photo_review_template_from_sheets(
            sheet_payloads,
            ticket_round=str(round_ctx["review_round_ref"]),
        )
        position_template = photo_review_template
        draw_analysis = analyze_sheets_with_draw_template(draw_template, sheet_payloads)
        combo_patterns = draw_analysis.get("winning_combo_hits") or _winning_combo_hits(
            draw_template["winning_numbers"],
            sheet_sets,
            sheet_details=sheet_payloads,
            bonus=draw_template.get("bonus"),
        )
    else:
        from .store import get_photo_review_template

        review_reference_template = get_photo_review_template()
        position_template = review_reference_template if review_reference_template.get("marked_numbers") else None
        if review_reference_template.get("marked_numbers"):
            pattern_application = apply_template_to_current(review_reference_template, sheet_payloads)
        else:
            pattern_application = {
                "summary": "저장된 복기 용지 패턴이 없습니다. 먼저 「복기」 탭에서 용지를 등록·저장해 주세요.",
                "review_round": str(round_ctx["review_round_ref"]),
                "review_rounds": [],
                "position_matches": [],
                "number_matches": [],
                "combo_hits": [],
                "position_match_numbers": [],
                "number_only_matches": [],
            }
        review_ref_nums = review_reference_template.get("marked_numbers") or []
        combo_patterns = (
            analyze_current_round_sheet_combos(
                sheet_details=sheet_payloads,
                raw_sheet_count=count_for_combo,
                reference_numbers=review_ref_nums,
            )
            if len(sheet_sets) >= 2
            else {
                "summary": "용지 2장 이상 필요 — 게임 줄 겹침 분석",
                "pair_duplicates": [],
                "triple_duplicates": [],
                "quad_duplicates": [],
                "sheet_count": len(sheet_sets),
                "min_repeat": 2,
            }
        )
        draw_template = None

    merged["pattern_application"] = pattern_application
    merged["position_template"] = position_template
    merged["draw_analysis"] = draw_analysis
    merged["general_combo_patterns"] = general_combo
    summary_kwargs = {
        "entry_mode": entry_mode,
        "sheet_count": len(sheet_payloads),
        "intent_label": intent_label,
    }

    if vision_result:
        cv_payload = {
            "identified_multiples": merged["identified_multiples"],
            "frequency_overlap_patterns": merged.get("frequency_overlap_patterns"),
            "triple_plus_overlap": merged.get("triple_plus_overlap"),
            "line_patterns": merged["line_patterns"],
            "strong_candidates": merged.get("strong_candidates", []),
            "excluded_candidates": excluded,
            "main_board_summary": "",
        }
        core = _merge_vision_with_cv(vision_result, cv_payload)
        if not core["extracted_visual_patterns"].get("frequency_overlap_patterns", {}).get("tiers"):
            core["extracted_visual_patterns"]["frequency_overlap_patterns"] = merged.get(
                "frequency_overlap_patterns",
                {"summary": "", "all_frequent": [], "tiers": [], "triple_plus_overlap": {"items": []}},
            )
            core["extracted_visual_patterns"]["triple_plus_overlap"] = merged.get(
                "triple_plus_overlap",
                {"pattern_label": "자동용지 3회이상 겹침", "items": []},
            )
        core["extracted_visual_patterns"]["combo_patterns"] = combo_patterns
        core["extracted_visual_patterns"]["pattern_application"] = pattern_application
        core["extracted_visual_patterns"]["draw_template"] = draw_template
        core["extracted_visual_patterns"]["draw_analysis"] = draw_analysis
        core["extracted_visual_patterns"]["photo_review_template"] = photo_review_template
        core["extracted_visual_patterns"]["review_reference_template"] = review_reference_template
        core["video_visual_analysis"]["detected_round"] = detected_round
        line_strong = (combo_patterns or {}).get("strong_candidates") or []
        core["final_predictions"]["strong_candidates"] = _merge_candidates(
            line_strong,
            core["final_predictions"]["strong_candidates"],
        )
        strong = core["final_predictions"]["strong_candidates"]
        if not core["app_ui_message"]:
            core["app_ui_message"] = _build_ui_message(
                detected_round,
                {
                    **core["extracted_visual_patterns"],
                    "combo_patterns": combo_patterns,
                    "pattern_application": pattern_application,
                },
                strong,
                core["final_predictions"]["excluded_candidates"],
            )
        summary = core["video_visual_analysis"]["main_board_summary"]
        core["video_visual_analysis"]["main_board_summary"] = summary or _opencv_summary(
            merged,
            ocr_count,
            detected_round,
            analysis_mode,
            len(paths),
            **summary_kwargs,
        )
    else:
        line_strong = (combo_patterns or {}).get("strong_candidates") or []
        strong = _merge_candidates(line_strong, merged.get("strong_candidates", []))
        core = {
            "video_visual_analysis": {
                "detected_round": detected_round,
                "main_board_summary": _opencv_summary(
                    merged,
                    ocr_count,
                    detected_round,
                    analysis_mode,
                    len(paths) or len(sheet_payloads),
                    **summary_kwargs,
                ),
            },
            "extracted_visual_patterns": {
                "identified_multiples": merged["identified_multiples"],
                "frequency_overlap_patterns": merged.get("frequency_overlap_patterns"),
                "triple_plus_overlap": merged.get("triple_plus_overlap"),
                "combo_patterns": combo_patterns,
                "pattern_application": pattern_application,
                "draw_template": draw_template,
                "draw_analysis": draw_analysis,
                "photo_review_template": photo_review_template,
                "review_reference_template": review_reference_template,
                "line_patterns": merged["line_patterns"],
            },
            "final_predictions": {
                "strong_candidates": strong,
                "excluded_candidates": sorted(excluded),
            },
            "app_ui_message": _build_ui_message(
                detected_round,
                {
                    "identified_multiples": merged["identified_multiples"],
                    "combo_patterns": combo_patterns,
                    "pattern_application": pattern_application,
                },
                strong,
                excluded,
            ),
        }
        if vision_error:
            core["video_visual_analysis"]["main_board_summary"] += f" · 보조 분석 실패: {vision_error}"
        elif entry_mode == "photo" and ocr_count < 3:
            core["video_visual_analysis"]["main_board_summary"] += (
                " · 표시 번호 인식 낮음 — 용지 전체가 화면에 들어오게 촬영해 주세요"
            )

    preview = None
    if entry_mode == "photo" and paths:
        best_path = Path(merged["best_frame"]) if merged.get("best_frame") else paths[0]
        preview = frame_to_base64_preview(best_path)

    vva = {
        **core["video_visual_analysis"],
        "video_title": title,
        "video_id": source_id,
        **{
            k: round_info[k]
            for k in (
                "ticket_round",
                "ticket_round_confidence",
                "video_intent",
                "video_intent_label",
                "referenced_rounds",
                "current_round_ref",
                "review_round_ref",
            )
            if k in round_info
        },
    }

    return {
        **core,
        "video_visual_analysis": vva,
        "meta": {
            "entry_mode": entry_mode,
            "images_analyzed": len(paths),
            "manual_slips_analyzed": len(sheet_payloads) if entry_mode == "manual" else 0,
            "duplicates_removed": dup_removed,
            "preview_image_base64": preview,
            "analysis_mode": analysis_mode,
            "vision_error": vision_error,
            "vision_enabled": entry_mode == "photo" and _should_use_vision(),
            "ocr_numbers_detected": ocr_count,
            "image_names": [p.name for p in paths],
            "sheet_intent": intent,
            "sheet_intent_label": intent_label,
            "combo_patterns": combo_patterns,
            "position_template": position_template,
            "photo_review_template": photo_review_template,
            "review_reference_template": review_reference_template,
            "pattern_application": pattern_application,
            "draw_template": draw_template,
            "review_round_ref": round_ctx["review_round_ref"],
            "current_round_ref": round_ctx["current_round_ref"],
            "sheet_number_sets": [sorted(p["numbers"]) for p in sheet_payloads if len(p["numbers"]) >= 2],
            "sheet_details": [
                {
                    "numbers": sorted(p["numbers"]),
                    "mark_scores": p.get("mark_scores") or {},
                    "positions": p.get("positions") or {},
                    "lines": p.get("lines") or [],
                    "game_line_count": p.get("game_line_count", 0),
                    "game_line_labels": p.get("game_line_labels") or [],
                    "raw_mark_count": p.get("raw_mark_count", 0),
                    "source_image": p.get("source_image", ""),
                    "image_index": p.get("image_index"),
                    "image_label": p.get("image_label", ""),
                    "sub_sheet_index": p.get("sub_sheet_index", 0),
                    "layout_mode": p.get("layout_mode"),
                    "source_layout": p.get("source_layout"),
                    "entry_mode": p.get("entry_mode"),
                }
                for p in sheet_payloads
                if len(p.get("numbers") or []) >= 2 or len(p.get("lines") or []) >= 1
            ],
            "physical_sheets_detected": len(sheet_payloads),
            "images_with_multi_sheets": images_with_multi,
            "combo_verification": combo_patterns.get("combo_verification") if intent == "current_round" else None,
            "marks_filter_note": (
                "수기 등록 — A~E 줄 각 6번호 그대로 분석"
                if entry_mode == "manual"
                else "용지당 표시 강도 상위 번호만 조합 분석에 사용"
            ),
        },
    }


def analyze_image_files(
    image_paths: List[Path],
    *,
    sheet_intent: str = "current_round",
) -> Dict[str, Any]:
    """업로드된 용지 사진 목록 분석."""
    if not image_paths:
        raise ValueError("분석할 사진이 없습니다.")

    max_images = settings.PHOTO_ANALYSIS_MAX_IMAGES
    raw_paths = [p for p in image_paths if p.is_file()]
    paths, dup_removed = dedupe_paths_by_content(raw_paths)
    paths = paths[:max_images]
    if not paths:
        raise ValueError("유효한 이미지 파일이 없습니다.")

    intent = sheet_intent if sheet_intent in ("review", "current_round") else "current_round"
    intent_label = "복기" if intent == "review" else "이번회차"

    analyses = [analyze_frame(p) for p in paths]
    sheet_payloads: List[Dict[str, Any]] = []
    images_with_multi = 0
    for image_idx, (path, a) in enumerate(zip(paths, analyses), start=1):
        image_label = f"이미지 {image_idx}"
        detected = detect_all_sheets_in_image(path)
        if detected:
            if len(detected) > 1:
                images_with_multi += 1
            for sheet in detected:
                sheet["image_index"] = image_idx
                sheet["image_label"] = image_label
                sheet_payloads.append(sheet)
            continue
        raw_counts = a.get("sheet_mark_counts") or {}
        from .sheet_grid import build_sheet_payload

        payload = build_sheet_payload(
            {int(k): int(v) for k, v in raw_counts.items()},
            a.get("sheet_positions") or {},
            source_image=path.name,
            sub_sheet_index=0,
        )
        payload["image_index"] = image_idx
        payload["image_label"] = image_label
        sheet_payloads.append(payload)

    ocr_count = sum(
        len(a.get("sheet_mark_counts") or {}) or len(set(a.get("ocr_numbers", [])))
        for a in analyses
    )
    title = f"{intent_label} 용지 사진 {len(paths)}장"
    image_id = compute_source_id(paths, intent)
    return analyze_from_sheet_payloads(
        sheet_payloads,
        sheet_intent=intent,
        title=title,
        source_id=image_id,
        entry_mode="photo",
        source_count=len(paths),
        paths=paths,
        analyses=analyses,
        dup_removed=dup_removed,
        images_with_multi=images_with_multi,
        ocr_count=ocr_count,
    )

