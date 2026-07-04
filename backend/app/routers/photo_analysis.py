"""용지 사진 패턴 분석 API."""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import List

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
                    "accumulated": build_accumulated(),
                })

        dup_removed = (result.get("meta") or {}).get("duplicates_removed", 0)
        return to_jsonable({
            "result": result,
            "stored_entry_id": stored_entry_id,
            "duplicate_skipped": False,
            "duplicates_removed": dup_removed,
            "accumulated": build_accumulated() if persist else None,
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
                # 거대한 result(수십 MB)는 프론트 미사용 — 응답에서 제거해 게이트웨이 절단 방지.
                dup.pop("result", None)
                return to_jsonable({
                    **dup,
                    "accumulated": build_accumulated(),
                })
        # result 는 수기 저장 경로에서 프론트가 쓰지 않고 용량이 수십 MB라
        # 응답에 넣으면 게이트웨이가 응답을 절단(→ HTML 502)한다. accumulated 만 반환.
        return to_jsonable({
            "result": None,
            "stored_entry_id": stored_entry_id,
            "duplicate_skipped": False,
            "accumulated": build_accumulated() if body.persist else None,
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
    return to_jsonable(build_accumulated())


@router.get("/history")
def get_history(limit: int = Query(50, ge=1, le=200)):
    return to_jsonable({"entries": list_entries(limit=limit), "accumulated": build_accumulated()})


@router.delete("/store")
def delete_store(intent: str | None = Query(default=None)):
    if intent is not None:
        if intent not in ("review", "current_round"):
            raise HTTPException(status_code=400, detail="intent 는 review 또는 current_round 이어야 합니다.")
        removed = clear_store_intent(intent)
    else:
        removed = clear_store()
    return {"ok": True, "removed": removed}


@router.delete("/store/{entry_id}")
def delete_store_entry(entry_id: str):
    if not delete_entry(entry_id):
        raise HTTPException(status_code=404, detail="분석 기록을 찾을 수 없습니다.")
    return to_jsonable({"ok": True, "accumulated": build_accumulated()})
