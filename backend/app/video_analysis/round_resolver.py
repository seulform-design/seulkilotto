"""용지·영상 회차 판별 — 복기 vs 이번회차 구분."""
from __future__ import annotations

import re
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Tuple

from app.data_meta import effective_current_round, get_history_meta

ROUND_TEXT_PATTERNS: List[Tuple[str, int]] = [
    (r"제\s*(\d{3,4})\s*회", 5),
    (r"(\d{3,4})\s*회차", 4),
    (r"회차\s*[:：]?\s*(\d{3,4})", 4),
    (r"(\d{3,4})\s*회\s*(?:로또|분석|예상|복기|당첨)", 4),
    (r"(\d{3,4})\s*회", 2),
]

REVIEW_KEYWORDS = (
    "복기", "지난주", "지난 회차", "전회차", "전 회차", "당첨번호", "당첨 번호",
    "당첨결과", "추첨결과", "결과분석", "후기", "완료", "이전회차", "지난회차",
)
CURRENT_KEYWORDS = (
    "이번회차", "이번 회차", "이번주", "이번 주", "금주", "금 주", "다음회차",
    "다음 회차", "예상번호", "예상 번호", "추첨전", "자동번호", "자동 용지", "용지",
)


def _valid_round(n: int) -> bool:
    return 1 <= n <= 9999


def _collect_round_hits(text: str, source: str, base_weight: int = 1) -> List[Dict[str, Any]]:
    if not text:
        return []
    hits: List[Dict[str, Any]] = []
    for pattern, w in ROUND_TEXT_PATTERNS:
        for m in re.finditer(pattern, text, flags=re.IGNORECASE):
            try:
                rnd = int(m.group(1))
            except (TypeError, ValueError):
                continue
            if not _valid_round(rnd):
                continue
            hits.append(
                {
                    "round": str(rnd),
                    "source": source,
                    "weight": w * base_weight,
                    "context": text[max(0, m.start() - 12) : m.end() + 12].strip(),
                }
            )
    return hits


def extract_round_from_frame_text(path: Path) -> List[Dict[str, Any]]:
    """프레임 OCR 전체 텍스트에서 회차 후보 (용지 인쇄 회차 우선)."""
    try:
        import cv2
        import pytesseract

        from .image_io import read_image_bgr

        img = read_image_bgr(path)
        if img is None:
            return []
        h = img.shape[0]
        top = img[0 : max(40, h // 4), :]
        rgb = cv2.cvtColor(top, cv2.COLOR_BGR2RGB)
        text = pytesseract.image_to_string(rgb, lang="kor+eng")
        full_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        text += "\n" + pytesseract.image_to_string(full_rgb, lang="kor+eng")
        return _collect_round_hits(text, "frame_ocr", base_weight=3)
    except Exception:
        return []


def _detect_video_intent(text: str, ticket_round: int | None, current_round: int) -> str:
    lower = (text or "").lower()
    review_score = sum(1 for k in REVIEW_KEYWORDS if k in lower)
    current_score = sum(1 for k in CURRENT_KEYWORDS if k in lower)

    if ticket_round is not None:
        if ticket_round < current_round:
            review_score += 2
        elif ticket_round >= current_round:
            current_score += 2

    if review_score > current_score:
        return "review"
    if current_score > review_score:
        return "current_round"
    return "unknown"


def _pick_ticket_round(hits: List[Dict[str, Any]], video_intent: str, current_round: int) -> Tuple[str | None, str, List[str]]:
    """용지 회차 1개 + 신뢰도 + 참조된 모든 회차."""
    if not hits:
        return None, "low", []

    weighted: Counter = Counter()
    for h in hits:
        weighted[h["round"]] += h["weight"]

    all_rounds = sorted({int(r) for r in weighted}, reverse=True)
    all_rounds_str = [str(r) for r in all_rounds]

    frame_rounds = {h["round"] for h in hits if h["source"] == "frame_ocr"}
    if frame_rounds:
        best = max(frame_rounds, key=lambda r: weighted[r])
        conf = "high" if weighted[best] >= 9 else "medium"
        return best, conf, all_rounds_str

    if video_intent == "current_round":
        candidates = [r for r in all_rounds_str if int(r) >= current_round - 1]
        if candidates:
            best = max(candidates, key=lambda r: weighted[r])
            return best, "medium", all_rounds_str

    if video_intent == "review":
        candidates = [r for r in all_rounds_str if int(r) < current_round]
        if candidates:
            best = max(candidates, key=lambda r: weighted[r])
            return best, "medium", all_rounds_str

    best = weighted.most_common(1)[0][0]
    conf = "high" if weighted[best] >= 8 else ("medium" if weighted[best] >= 4 else "low")
    return best, conf, all_rounds_str


def resolve_ticket_round(
    *,
    title: str,
    description: str,
    transcript: str,
    frame_paths: List[Path],
    vision_detected_round: str | None = None,
    user_intent: str | None = None,
) -> Dict[str, Any]:
    meta = get_history_meta()
    latest = int(meta.get("latest_round") or 0)
    current_round = int(meta.get("current_round") or effective_current_round(latest))

    hits: List[Dict[str, Any]] = []
    hits.extend(_collect_round_hits(title, "title", base_weight=2))
    hits.extend(_collect_round_hits(description, "description", base_weight=1))
    hits.extend(_collect_round_hits(transcript, "transcript", base_weight=1))

    if vision_detected_round:
        try:
            vr = int(str(vision_detected_round).strip())
            if _valid_round(vr):
                hits.append(
                    {
                        "round": str(vr),
                        "source": "vision",
                        "weight": 6,
                        "context": "vision_detected_round",
                    }
                )
        except ValueError:
            pass

    for p in frame_paths[:5]:
        hits.extend(extract_round_from_frame_text(p))

    text_blob = "\n".join([title, description, transcript])
    if user_intent in ("review", "current_round"):
        pre_intent = user_intent
    else:
        pre_intent = _detect_video_intent(text_blob, None, current_round)
    ticket_round, confidence, all_rounds = _pick_ticket_round(hits, pre_intent, current_round)

    ticket_int: int | None = int(ticket_round) if ticket_round else None
    if user_intent in ("review", "current_round"):
        video_intent = user_intent
    else:
        video_intent = _detect_video_intent(text_blob, ticket_int, current_round)

    intent_label = {
        "review": "복기",
        "current_round": "이번회차",
        "unknown": "회차미분류",
    }.get(video_intent, "회차미분류")

    if (
        user_intent not in ("review", "current_round")
        and ticket_round
        and video_intent == "review"
        and ticket_int
        and ticket_int >= current_round
    ):
        video_intent = "current_round"
        intent_label = "이번회차"

    return {
        "ticket_round": ticket_round,
        "detected_round": ticket_round,
        "ticket_round_confidence": confidence,
        "video_intent": video_intent,
        "video_intent_label": intent_label,
        "current_round_ref": current_round,
        "latest_drawn_round": latest,
        "referenced_rounds": all_rounds,
        "round_sources": hits[:30],
    }
