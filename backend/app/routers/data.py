"""데이터 업그레이드·회차 조회 API."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Query

from ..config import settings
from ..round_upgrade import get_upgrade_status, upgrade_rounds

router = APIRouter(prefix="/api/v1/data", tags=["data"])


def verify_upgrade_key(x_upgrade_key: str | None = Header(default=None, alias="X-Upgrade-Key")) -> None:
    key = settings.UPGRADE_API_KEY.strip()
    if key and x_upgrade_key != key:
        raise HTTPException(status_code=403, detail="Upgrade API key required")


@router.get("/upgrade-status")
def upgrade_status():
    """로컬 데이터 vs 동행복권 최신 회차 비교."""
    return get_upgrade_status()


@router.post("/upgrade")
def run_upgrade(
    force: bool = Query(default=False, description="전체 재수집(느림)"),
    _: None = Depends(verify_upgrade_key),
):
    """신규 회차 크롤링 → CSV 갱신 → v2 DB 동기화."""
    return upgrade_rounds(force=force)
