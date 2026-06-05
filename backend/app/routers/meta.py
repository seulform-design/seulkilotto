"""앱 메타·헬스 API."""
from __future__ import annotations

from fastapi import APIRouter

from ..data_meta import get_history_meta

router = APIRouter(prefix="/api/v1", tags=["meta"])


@router.get("/meta")
def get_meta():
    """프론트/운영용: 데이터 소스, 최신 회차, 현재 회차, 누락 회차 수."""
    return get_history_meta()
