"""데이터셋 격리 상태 API."""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query

from ..config import settings
from ..datasets import get_current_sandbox, get_historical_dataset
from ..pipeline.rollover import execute_saturday_rollover

router = APIRouter(prefix="/api/v1/datasets", tags=["datasets"])


def verify_upgrade_key(x_upgrade_key: str | None = Header(default=None, alias="X-Upgrade-Key")) -> None:
    """상태 변경(롤오버) 보호 — UPGRADE_API_KEY 설정 시 헤더 필요.
    data.py 의 동일 키를 공유해 업그레이드/롤오버 권한을 일관되게 보호한다."""
    key = settings.UPGRADE_API_KEY.strip()
    if key and x_upgrade_key != key:
        raise HTTPException(status_code=403, detail="Upgrade API key required")


@router.get("/status")
def dataset_status() -> Dict[str, Any]:
    """Historical / Current 샌드박스 격리 상태."""
    hist = get_historical_dataset()
    sb = get_current_sandbox()
    state = sb.get_state()
    meta_archived = hist.list_archived_rounds()
    return {
        "historical": {
            "mode": "immutable_read_only",
            "archived_rounds": meta_archived,
            "archived_count": len(meta_archived),
        },
        "current_sandbox": {
            "mode": "isolated_read_write",
            "round_no": state.round_no,
            "frozen": state.frozen,
            "write_enabled": state.write_enabled,
            "photo_entries": len(sb.list_photo_entries()),
            "derived_recommendations": len(sb.list_derived_recommendations()),
        },
        "pipeline": "historical -> rule_engine -> derived -> current_sandbox",
    }


@router.get("/current/derived")
def list_current_derived(limit: int = Query(default=20, ge=1, le=100)) -> Dict[str, Any]:
    sb = get_current_sandbox()
    runs = sb.list_derived_recommendations()
    return {
        "round_no": sb.get_state().round_no,
        "count": len(runs),
        "runs": runs[-limit:],
    }


@router.post("/rollover")
def trigger_rollover(
    closed_round: Optional[int] = Query(default=None, description="확정 회차 (기본: CSV 최신)"),
    _: None = Depends(verify_upgrade_key),
) -> Dict[str, Any]:
    """토요일 롤오버 배치 수동 실행 (멱등). 상태 변경이라 UPGRADE_API_KEY 보호."""
    result = execute_saturday_rollover(closed_round)
    if not result.ok and not result.idempotent:
        raise HTTPException(status_code=409, detail=result.to_dict())
    return result.to_dict()
