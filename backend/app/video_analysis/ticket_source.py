"""보관 용지 학습 엔진(V1·NestedCV·SHAP/Drift·V2·V3·V4-A)의 '용지 입력원' 스위치.

2026-11-10 사용자 결정: 수동 입력 용지 대신 **유튜브 영상에서 확인한 자동·반자동 용지**로 학습·검증한다.

- TICKET_LEARNING_SOURCE=youtube (기본) : 유튜브 확정 용지만
- TICKET_LEARNING_SOURCE=manual          : 기존 수동 보관 용지만(비교·복구용)
- TICKET_LEARNING_SOURCE=both            : 둘 다(같은 회차는 출처를 섞지 않고 각각 별도 배치)

유튜브 용지 투입 조건(검증 게이트 통과분만):
  verification_status = 'accepted'   — 6개·오름차순·OCR/유형 신뢰도 기준 통과
  round_status = 'ticket_printed'    — 용지에 인쇄된 '제 N 회' 로 회차 확인
  추첨이 끝난 회차                     — 당첨번호와 대조 가능할 때만(엔진이 자체 필터)
기존 수동 데이터는 삭제·수정하지 않는다(저장소 그대로, 스위치로만 제외).

엔진 코드는 바꾸지 않는다. 배치는 기존 형식(round_no·frozen_at·entries)을 따르고, 유튜브 줄은
entries 안의 {"_yt_lines": {"자동": [...], "반자동": [...]}} 로 전달되어 store._manual_saved_lines 가 읽는다.
"""
from __future__ import annotations

import hashlib
import os
from typing import Any, Dict, List

PICK_LABEL = {"auto": "자동", "semi_auto": "반자동"}


def mode() -> str:
    m = (os.environ.get("TICKET_LEARNING_SOURCE") or "youtube").strip().lower()
    return m if m in ("youtube", "manual", "both") else "youtube"


def youtube_batches() -> List[Dict[str, Any]]:
    try:
        from ..ingest import db
    except Exception:  # noqa: BLE001
        return []
    by_round: Dict[int, Dict[str, Any]] = {}
    try:
        for table, ptype in (("ticket_auto_data", "auto"), ("ticket_semi_auto_data", "semi_auto")):
            rows = db.query(f"SELECT draw_round, numbers, video_id, created_at FROM {table} "
                            "WHERE verification_status = 'accepted' AND round_status = 'ticket_printed' "
                            "AND draw_round IS NOT NULL")
            for rnd, nums, vid, created in rows:
                b = by_round.setdefault(int(rnd), {"lines": {"자동": [], "반자동": []}, "videos": set(), "first": created})
                b["lines"][PICK_LABEL[ptype]].append(sorted(int(n) for n in db.loads(nums)))
                b["videos"].add(vid)
                if created and created < b["first"]:
                    b["first"] = created
    except Exception:  # noqa: BLE001 — 테이블 없음 등: 유튜브 입력 없음으로 처리
        return []
    out = []
    for rnd, b in sorted(by_round.items()):
        out.append({
            "round_no": rnd,
            "frozen_at": b["first"],
            "source": "youtube",
            "video_count": len(b["videos"]),
            "entries": [{"_yt_lines": b["lines"], "entry_mode": "youtube", "source": "youtube"}],
        })
    return out


def learning_batches(historical: Dict[str, Any]) -> List[Dict[str, Any]]:
    """엔진이 학습에 쓸 보관 배치 목록(입력원 스위치 반영)."""
    m = mode()
    manual = list(historical.get("archived_current_rounds") or []) if m in ("manual", "both") else []
    yt = youtube_batches() if m in ("youtube", "both") else []
    return manual + yt


def signature() -> str:
    """캐시 무효화용 — 유튜브 확정 용지 수·최신 시각이 바뀌면 값이 바뀐다."""
    b = youtube_batches() if mode() in ("youtube", "both") else []
    raw = f"{mode()}|" + ";".join(f"{x['round_no']}:{len(x['entries'][0]['_yt_lines']['자동'])}:"
                                   f"{len(x['entries'][0]['_yt_lines']['반자동'])}" for x in b)
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def summary(historical: Dict[str, Any]) -> Dict[str, Any]:
    yt = youtube_batches()
    manual = historical.get("archived_current_rounds") or []
    return {
        "mode": mode(),
        "youtube": {"rounds": [b["round_no"] for b in yt],
                    "auto_lines": sum(len(b["entries"][0]["_yt_lines"]["자동"]) for b in yt),
                    "semi_lines": sum(len(b["entries"][0]["_yt_lines"]["반자동"]) for b in yt),
                    "videos": sum(b["video_count"] for b in yt)},
        "manual_preserved": {"rounds": sorted(int(b.get("round_no")) for b in manual if b.get("round_no") is not None),
                             "used": mode() in ("manual", "both")},
    }
