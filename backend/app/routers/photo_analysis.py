"""용지 사진 패턴 분석 API."""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from app.config import settings
from app.json_utils import to_jsonable
from app.video_analysis.image_engine import analyze_image_files, vision_api_configured
from app.video_analysis.manual_entry import analyze_manual_slips
from app.video_analysis.store import (
    DuplicateAnalysisError,
    append_analysis,
    build_accumulated,
    clear_store,
    clear_store_intent,
    delete_entry,
    list_entries,
)
from app.video_analysis.vision_config import clear_vision_api_key, save_vision_api_key, set_photo_use_vision

router = APIRouter(prefix="/api/v1/photo-analysis", tags=["photo-analysis"])

ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}


def _save_uploads(files: List[UploadFile], tmp: Path) -> List[Path]:
    paths: List[Path] = []
    for i, uf in enumerate(files):
        name = (uf.filename or f"image_{i}.jpg").replace("\\", "/").split("/")[-1]
        ext = Path(name).suffix.lower() or ".jpg"
        if ext not in ALLOWED_EXT:
            raise ValueError(f"지원하지 않는 이미지 형식입니다: {name}")
        dest = tmp / f"upload_{i:02d}{ext}"
        data = uf.file.read()
        if not data:
            continue
        dest.write_bytes(data)
        paths.append(dest)
    return paths


# 클라이언트 응답 슬림화 — 조합(pair/triple/quad)이 각자 '모든 출현 위치·줄'
# (lines/locations)을 통째로 담아 응답이 10MB+ 로 커지고 게이트웨이가 절단한다.
# 화면엔 조합·카운트(line_count 등 스칼라)만 필요하므로 상세 배열만 소수로 캡한다.
# saved_semi_lines/saved_auto_lines/numbers 등 다른 키는 건드리지 않는다.
# 절대 잘라선 안 되는 데이터 배열(복원·핵심 값). 나머지 dict-내 리스트는 상위 N만.
_SLIM_KEEP_FULL = {
    "saved_semi_lines", "saved_auto_lines", "numbers", "matching_numbers",
    "strong_candidates", "excluded_candidates", "marked_numbers",
    "winning", "referenced_rounds",
}
_SLIM_DETAIL_KEYS = {"lines", "locations"}  # 조합별 출현 상세 — 극소수만
_SLIM_DETAIL_CAP = 3
_SLIM_LIST_CAP = 50     # 그 외 모든 리스트(조합·세트·요약) 상위 N — 전체 건수는 스칼라로 별도 제공.
                        # 화면은 상위 8~10개만 렌더링하므로 50이면 충분하고, 티켓 수가 커져도
                        # 아카이브 스냅숏 등 잔여 대용량 배열을 눌러 게이트웨이 절단 여유를 둔다.
_SLIM_STR_CAP = 4000    # 초장문 문자열(formatted_text 등) 절단


def _slim_for_client(obj):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if isinstance(v, (dict, list)) and k in _SLIM_KEEP_FULL:
                out[k] = _slim_for_client(v) if isinstance(v, dict) else [_slim_for_client(x) for x in v]
            elif isinstance(v, list):
                cap = _SLIM_DETAIL_CAP if k in _SLIM_DETAIL_KEYS else _SLIM_LIST_CAP
                out[k] = [_slim_for_client(x) for x in v[:cap]]
            elif isinstance(v, str) and len(v) > _SLIM_STR_CAP:
                out[k] = v[:_SLIM_STR_CAP]
            else:
                out[k] = _slim_for_client(v)
        return out
    if isinstance(obj, list):
        return [_slim_for_client(x) for x in obj]
    return obj


def _slim_accumulated():
    """슬림화된 누적 응답 — 대용량 상세 배열을 캡해 게이트웨이 절단을 방지.

    최상위 accumulated_combo_patterns(레거시 전체집계, ~0.5MB)는 어떤 화면도
    참조하지 않는다. 프론트는 by_intent[intent].accumulated_combo_patterns 와
    historical_dataset.latest_archived_current_snapshot 만 읽는다. 티켓 수가
    늘면 이 최상위 필드가 응답을 수 MB 로 부풀려 게이트웨이가 502(HTML)로 절단 →
    프론트가 "게이트웨이 연결이 일시적으로 끊겼습니다" + saved_auto_lines 미수신으로
    "자동 서버 저장 0줄" 을 표시했다. 클라이언트 응답에서만 제거해 절단을 막는다.
    """
    full = build_accumulated()
    acc = full
    if isinstance(acc, dict):
        acc = dict(acc)  # 얕은 복사 — 캐시/원본 dict 를 훼손하지 않는다.
        acc.pop("accumulated_combo_patterns", None)
    slim = _slim_for_client(acc)

    # '다른 줄에도 겹침'(자동 누적 pair/triple/quad — pick_type='자동' 만 집계)은
    # 화면에서 전체를 봐야 한다. 리스트 캡(_SLIM_LIST_CAP)이 이를 잘라 "N건 전체"가
    # 실제로는 상위 N만 보였다. by_intent 슬라이스에 한해 캡을 풀되, 각 항목 내부
    # 상세(lines/locations)만 슬림화해 재주입한다. 최상위(제거됨)·아카이브 스냅숏은
    # 그대로 캡 유지 → 응답 크기·게이트웨이 절단 여유는 보존.
    if isinstance(full, dict) and isinstance(slim, dict):
        uncap_keys = ("pair_duplicates", "triple_duplicates", "quad_duplicates")
        # 화면(renderCross)이 실제 읽는 필드만 남겨 항목을 ~100B 로 줄인다. lines/
        # locations/*_indices 등 미표시 대용량 필드는 버려 전체 노출해도 응답이
        # 게이트웨이 한계를 넘지 않게 한다.
        keep_item = ("numbers", "size", "line_count", "repeat_count", "lift", "z", "is_winning_combo")
        for intent, fslice in (full.get("by_intent") or {}).items():
            if not isinstance(fslice, dict):
                continue
            fcombo = fslice.get("accumulated_combo_patterns")
            sslice = (slim.get("by_intent") or {}).get(intent)
            scombo = sslice.get("accumulated_combo_patterns") if isinstance(sslice, dict) else None
            if isinstance(fcombo, dict) and isinstance(scombo, dict):
                for key in uncap_keys:
                    items = fcombo.get(key)
                    if isinstance(items, list):
                        scombo[key] = [
                            {k: it[k] for k in keep_item if k in it}
                            for it in items
                            if isinstance(it, dict)
                        ]
    return slim


def _duplicate_payload(existing: dict, reason: str) -> dict:
    stored = existing.get("result") or existing
    return {
        "result": stored,
        "stored_entry_id": existing.get("id"),
        "duplicate_skipped": True,
        "duplicate_reason": reason,
        "duplicate_message": (
            f"이미 등록·분석된 데이터입니다: {existing.get('source_label') or existing.get('video_title')}"
            if reason == "same_source"
            else f"동일 용지가 이미 저장되어 있습니다 ({existing.get('ticket_round')}회)"
        ),
        "analysis_skipped": reason == "same_source",
    }


class ManualGameLine(BaseModel):
    label: str = ""
    numbers: List[int] = Field(..., min_length=6, max_length=6)


class ManualSlip(BaseModel):
    name: str = ""
    # 부분 용지 허용: 1~5줄 (대량 입력에서 마지막 슬립이 5줄 미만일 수 있음)
    lines: List[ManualGameLine] = Field(..., min_length=1, max_length=5)


class ManualAnalyzeRequest(BaseModel):
    sheet_intent: str = Field("current_round", description="review=복기, current_round=이번회차")
    pick_type: str = Field("반자동", description="자동 | 반자동 — 이 세트의 픽 타입")
    persist: bool = True
    allow_duplicate: bool = False
    slips: List[ManualSlip] = Field(..., min_length=1)


class VisionConfigSaveRequest(BaseModel):
    api_key: str = Field(..., min_length=10)
    model: str = Field("gpt-4o-mini")


@router.post("/analyze")
async def analyze_photos(
    files: List[UploadFile] = File(..., description="용지 사진"),
    sheet_intent: str = Form("current_round", description="review=전회차, current_round=이번회차"),
    persist: bool = Form(True),
    allow_duplicate: bool = Form(False),
):
    if not files:
        raise HTTPException(status_code=400, detail="사진을 1장 이상 첨부하세요.")
    max_images = settings.PHOTO_ANALYSIS_MAX_IMAGES
    if len(files) > max_images:
        raise HTTPException(
            status_code=400,
            detail=f"한 번에 최대 {max_images}장까지 분석할 수 있습니다.",
        )

    tmp = Path(tempfile.mkdtemp(prefix="lotto_photo_"))
    try:
        paths = _save_uploads(files, tmp)
        if not paths:
            raise HTTPException(status_code=400, detail="유효한 이미지 파일이 없습니다.")

        if sheet_intent not in ("review", "current_round"):
            raise HTTPException(
                status_code=400,
                detail="sheet_intent 는 review(전회차) 또는 current_round(이번회차) 이어야 합니다.",
            )
        result = analyze_image_files(paths, sheet_intent=sheet_intent)
        source_id = result["video_visual_analysis"]["video_id"]

        stored_entry_id = None
        if persist:
            try:
                entry = append_analysis(
                    source_id,
                    result,
                    allow_duplicate=allow_duplicate,
                    replace_existing=True,
                    source_label=paths[0].name,
                )
                stored_entry_id = entry["id"]
            except DuplicateAnalysisError as exc:
                return to_jsonable({
                    **_duplicate_payload(exc.existing_entry, exc.reason),
                    "accumulated": _slim_accumulated(),
                })

        dup_removed = (result.get("meta") or {}).get("duplicates_removed", 0)
        return to_jsonable({
            "result": result,
            "stored_entry_id": stored_entry_id,
            "duplicate_skipped": False,
            "duplicates_removed": dup_removed,
            "accumulated": _slim_accumulated() if persist else None,
        })
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"사진 분석 실패: {e}") from e
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@router.post("/manual")
def analyze_manual(body: ManualAnalyzeRequest):
    """5천원 자동 용지 수기 등록 — A~E × 6번호."""
    if body.sheet_intent not in ("review", "current_round"):
        raise HTTPException(
            status_code=400,
            detail="sheet_intent 는 review(복기) 또는 current_round(이번회차) 이어야 합니다.",
        )
    if body.pick_type not in ("자동", "반자동"):
        raise HTTPException(
            status_code=400,
            detail="pick_type 은 자동 또는 반자동 이어야 합니다.",
        )
    try:
        slips = [
            {
                "name": slip.name,
                "lines": [{"label": ln.label, "numbers": ln.numbers} for ln in slip.lines],
            }
            for slip in body.slips
        ]
        result = analyze_manual_slips(
            slips, sheet_intent=body.sheet_intent, pick_type=body.pick_type
        )
        source_id = result["video_visual_analysis"]["video_id"]
        stored_entry_id = None
        if body.persist:
            label = body.slips[0].name or f"수기용지 {len(body.slips)}장"
            try:
                entry = append_analysis(
                    source_id,
                    result,
                    allow_duplicate=body.allow_duplicate,
                    replace_existing=True,
                    replace_prior_manual=True,
                    source_label=label,
                )
                stored_entry_id = entry["id"]
            except DuplicateAnalysisError as exc:
                dup = _duplicate_payload(exc.existing_entry, exc.reason)
                dup.pop("result", None)
                # accumulated 는 응답에서 계산하지 않는다(아래 설명). 프론트가 별도 GET.
                return to_jsonable({**dup, "accumulated": None})
        # 저장 POST 에서는 build_accumulated 를 호출하지 않는다.
        # analyze(결과 메모리) + append + build_accumulated 가 한 요청에 겹치면
        # 무료 워커가 OOM(→ nginx 502) 한다. build_accumulated 단독(GET /accumulated)은
        # 정상이므로, 저장은 경량(analyze+append)으로 끝내고 프론트가 저장 성공 후
        # GET /accumulated 로 누적을 갱신한다.
        return to_jsonable({
            "result": None,
            "stored_entry_id": stored_entry_id,
            "duplicate_skipped": False,
            "accumulated": None,
        })
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"수기 분석 실패: {e}") from e


@router.get("/vision-config")
def get_vision_config():
    has_key = bool((settings.VIDEO_VISION_API_KEY or "").strip())
    return {
        "configured": vision_api_configured(),
        "has_api_key": has_key,
        "use_vision_api": settings.PHOTO_USE_VISION_API,
        "model": settings.VIDEO_VISION_MODEL,
        "analysis_mode": "vision" if vision_api_configured() else "local",
        "env_hint": "기본은 로컬(OpenCV) 분석입니다. OpenAI Vision은 선택 사항입니다.",
    }


class VisionConfigToggleRequest(BaseModel):
    use_vision_api: bool = False


@router.post("/vision-config")
def save_vision_config(body: VisionConfigSaveRequest):
    try:
        save_vision_api_key(body.api_key, body.model)
        set_photo_use_vision(True)
        return {
            "ok": True,
            "configured": vision_api_configured(),
            "use_vision_api": settings.PHOTO_USE_VISION_API,
            "model": settings.VIDEO_VISION_MODEL,
            "message": "Vision API 키가 저장되었습니다. (선택 기능)",
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.delete("/vision-config")
def disable_vision_config():
    clear_vision_api_key()
    set_photo_use_vision(False)
    return {
        "ok": True,
        "configured": False,
        "use_vision_api": False,
        "message": "로컬 분석 모드로 전환했습니다.",
    }


@router.patch("/vision-config")
def toggle_vision_config(body: VisionConfigToggleRequest):
    set_photo_use_vision(body.use_vision_api)
    return {
        "ok": True,
        "configured": vision_api_configured(),
        "use_vision_api": settings.PHOTO_USE_VISION_API,
        "message": "Vision API 사용" if body.use_vision_api else "로컬 분석만 사용",
    }


@router.get("/storage-status")
def get_storage_status():
    """용지분석 저장 백엔드 진단 — Postgres 영구저장 설정·연결 여부 확인."""
    from app.video_analysis import pg_store

    return to_jsonable(pg_store.status())


@router.get("/accumulated")
def get_accumulated():
    return to_jsonable(_slim_accumulated())


@router.get("/round-learning")
def get_round_learning():
    """다회차 학습 — 보관된 과거 회차 용지 + 실제 당첨번호로 지지-적중 캘리브레이션.

    보관 용지는 추첨 전 등록분이라 예측 누수가 없다. 학습 결과를 이번회차 용지에 적용.
    """
    from ..video_analysis.round_learning import build_round_learning

    return to_jsonable(build_round_learning())


@router.get("/review-verification")
def get_review_verification():
    """복기 역산 검증 — 당첨번호가 각 신호에서 몇 위였는지 + 커버리지 곡선.

    '집중 top-6' 이 왜 당첨을 놓치는지(넓은 그물은 담는데)를 데이터로 보여준다.
    """
    from ..video_analysis.review_verification import build_review_verification

    return to_jsonable(build_review_verification())


@router.get("/overlap-learning")
def get_overlap_learning():
    """줄겹침(2·3·4번호) 패턴 역산 학습 — 보관 회차 겹침 조합 vs 실제 당첨 대조.

    회차가 쌓이면 호출 시마다 전체 보관 배치를 재집계하므로 자동으로 표본이 늘어난다.
    """
    from ..video_analysis.overlap_learning import build_overlap_learning

    return to_jsonable(build_overlap_learning())


@router.get("/feature-learning")
def get_feature_learning(seed: int = Query(42, ge=0, le=999_999)):
    """복기 Feature 자동 생성·검증·학습 엔진.

    보관 회차(추첨 전 용지)만으로 Feature Dataset 구축 → Walk-Forward/Bootstrap/
    Permutation/Monte Carlo/Time-Split 검증 → Random 대비 통과 Feature 만 채택 →
    앙상블 실험 → 추천 시 Feature 기여도 출력.
    """
    from ..video_analysis.feature_learning_engine import build_feature_learning

    return to_jsonable(build_feature_learning(seed=seed))


@router.get("/pattern-mining")
def get_pattern_mining(seed: int = Query(42, ge=0, le=999_999)):
    """복기 Pattern Mining · Validation · Cluster · 설명가능 추천.

    자동/반자동/매치카드/강한후보/구조(거리·구간·배치)를 전수 학습해 Pattern 을
    자동 생성하고, Walk-Forward/Rolling/Time-Split/Backtest 로 검증한 뒤
    통과 Pattern 만 추천·근거에 반영한다. 호출 시마다 전체 재탐색(자동 학습).
    """
    from ..video_analysis.pattern_mining_engine import build_pattern_mining

    return to_jsonable(build_pattern_mining(seed=seed))


class ReattributeRequest(BaseModel):
    from_round: int = Field(..., ge=1, description="현재 잘못 기록된 회차")
    to_round: int = Field(..., ge=1, description="교정할 실제 회차")
    entry_ids: Optional[List[str]] = Field(
        default=None, description="지정 시 해당 엔트리만 교정 (미지정 시 from_round 전체)"
    )


@router.post("/reattribute")
def reattribute_entries(body: ReattributeRequest):
    """복기 엔트리 소속 회차 교정(재귀속) — 관리자 도구.

    복기 엔트리의 회차 라벨만 바꾼다(삭제 없음). 롤오버 보관 정본은 건드리지 않으며,
    원래 회차는 original_ticket_round 에 보존되어 되돌릴 수 있다.
    """
    from ..video_analysis.store import reattribute_review_entries

    res = reattribute_review_entries(
        from_round=body.from_round,
        to_round=body.to_round,
        entry_ids=body.entry_ids,
    )
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error") or "재귀속 실패")
    return to_jsonable({**res, "accumulated": _slim_accumulated()})


@router.get("/history")
def get_history(limit: int = Query(50, ge=1, le=200)):
    return to_jsonable({"entries": list_entries(limit=limit), "accumulated": _slim_accumulated()})


@router.delete("/store")
def delete_store(
    intent: str | None = Query(default=None),
    pick_type: str | None = Query(default=None),
    include_archived: bool = Query(
        default=False,
        description="복기 한정 — 롤오버 보관 배치도 함께 삭제(복기 탭이 표시하는 정본)",
    ),
    round_no: int | None = Query(
        default=None,
        description="복기 한정 — 지정 시 그 회차 소속 엔트리만 삭제(고아 복기 정리 안전 필터)",
    ),
):
    if pick_type is not None and pick_type not in ("자동", "반자동"):
        raise HTTPException(status_code=400, detail="pick_type 은 자동 또는 반자동 이어야 합니다.")
    if intent is not None:
        if intent not in ("review", "current_round"):
            raise HTTPException(status_code=400, detail="intent 는 review 또는 current_round 이어야 합니다.")
        # pick_type 지정 시 해당 픽타입만 삭제(자동만/반자동만), 미지정 시 intent 전체.
        # round_no 지정 시 그 회차 소속만(복기 한정) — 다른 회차 정상 복기 보존.
        removed = clear_store_intent(
            intent, pick_type=pick_type, include_archived=include_archived, round_no=round_no
        )
    else:
        removed = clear_store()
    return {"ok": True, "removed": removed}


@router.delete("/store/{entry_id}")
def delete_store_entry(entry_id: str):
    if not delete_entry(entry_id):
        raise HTTPException(status_code=404, detail="분석 기록을 찾을 수 없습니다.")
    return to_jsonable({"ok": True, "accumulated": _slim_accumulated()})
