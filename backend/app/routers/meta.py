"""앱 메타·헬스 API."""
from __future__ import annotations

from fastapi import APIRouter

from ..data_meta import get_history_meta

router = APIRouter(prefix="/api/v1", tags=["meta"])


@router.get("/meta")
def get_meta():
    """프론트/운영용: 데이터 소스, 최신 회차, 현재 회차, 누락 회차 수."""
    return get_history_meta()


@router.get("/round-status")
def get_round_status():
    """회차 상태: 이번회차·복기회차·당첨발표 여부를 한 번에 반환.

    Response
    --------
    latest_round   : 가장 최근 추첨 완료 회차 (복기 대상)
    current_round  : 다음 추첨 예정 회차 (이번회차)
    review_round   : 복기 탭 기준 회차 (= latest_round)
    drawn          : 이번회차 당첨번호가 이미 발표됐는지 여부
                     (True 면 CSV 업데이트 필요)
    """
    from ..video_analysis.draw_template import round_status
    return round_status()
