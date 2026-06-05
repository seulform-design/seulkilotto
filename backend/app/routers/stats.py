"""통계 관련 엔드포인트 (/api/v1/stats).

[기획서 API 1] GET /api/v1/stats/frequency
- 입력: optional recent_n (최근 N회차 슬라이스)
- 처리: Pandas value_counts on num1~num6 flattened vector
- 출력: total_rounds, items[{number, count, ratio}]
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from .. import analytics
from ..database import load_history
from ..schemas import FrequencyResponse

router = APIRouter(prefix="/api/v1/stats", tags=["stats"])


@router.get("/frequency", response_model=FrequencyResponse)
def get_frequency(
    recent_n: int | None = Query(
        default=None,
        ge=1,
        description="최근 N회차만 집계. 생략 시 전체 회차 집계.",
    ),
):
    """전체 또는 최근 N회차 동안의 1~45번 번호별 출현 빈도수 및 비율을 반환한다."""
    df = load_history()
    if df.empty:
        raise HTTPException(status_code=404, detail="당첨 데이터가 없습니다.")
    return analytics.calc_frequency(df, recent_n=recent_n)
